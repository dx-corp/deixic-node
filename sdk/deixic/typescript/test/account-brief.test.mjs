import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import * as pb from "../dist/gen/ts/console/v1/console_pb.js";

const C = 9_007_199_254_740_994n;
const script = fileURLToPath(import.meta.resolve("@evalops/deixic-sdk/examples/account-brief"));
function command(arguments_, environment) {
  return new Promise(resolve => execFile(process.execPath, [script, ...arguments_],
    { env: environment, timeout: 10_000 }, (error, stdout, stderr) => resolve({
      code: error?.code ?? 0, output: JSON.parse(stdout), stderr,
    })));
}

async function owner(loseAcceptance) {
  const operations = new Map();
  const submissions = [];
  const errors = [];
  let completed = false;
  const server = createServer(async (request, response) => {
    const method = request.url.split("/").at(-1);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const data = Buffer.concat(chunks);
    try {
      assert(request.url.startsWith("/deixic.v1.DeixicService/"));
      assert.equal(request.headers["content-type"], "application/proto");
      assert.equal(request.headers["connect-protocol-version"], "1");
      assert.equal(request.headers.authorization, "Bearer fixture-secret");
      const input = fromBinary(pb[method + "RequestSchema"], data);
      assert.equal(input.query.organizationId, "org-fixture");
      assert.equal(input.query.workspaceId, "ws-fixture");
      assert.equal(request.headers["x-organization-id"], input.query.organizationId);
      assert.equal(request.headers["x-workspace-id"], input.query.workspaceId);
      assert.equal(input.channelId, "company");
      let fields;
      switch (method) {
        case "SubmitOperatingMessage":
          submissions.push(data);
          assert.equal(input.idempotencyKey, "crm-event-001");
          assert(input.body.includes("Example account"));
          if (operations.has(input.idempotencyKey)) assert.deepEqual(data, operations.get(input.idempotencyKey));
          operations.set(input.idempotencyKey, data);
          if (loseAcceptance && submissions.length === 1) { request.socket.destroy(); return; }
          fields = { replayCursor: C, acceptedTurn: { turnId: "target", sequence: 2n, state: pb.OperatingTurnState.QUEUED } };
          break;
        case "ListOperatingThreadEvents":
          completed = true;
          fields = { nextCursor: C + 1n, events: input.afterCursor < C + 1n ? [{ cursor: C + 1n,
            turnId: "target", eventId: "completed", kind: pb.OperatingThreadEventKind.TURN_COMPLETED }] : [] };
          break;
        case "GetOperatingThread":
          fields = { channel: { id: "company" }, defaultModel: { provider: "fixture", model: "fixture", ready: true },
            turns: [{ turnId: "target", sequence: 2n, state: completed ? pb.OperatingTurnState.COMPLETED : pb.OperatingTurnState.QUEUED,
              assistantMessageId: completed ? "answer" : "" }],
            messages: completed ? [{ id: "answer", channelId: "company", role: "assistant",
              body: "Example account: an evidence-linked brief", receiptIds: ["evidence"] }] : [] };
          break;
        case "GetOperatingReceipt":
          assert.equal(input.receiptId, "evidence");
          fields = { receipt: { id: "evidence", lifecycleState: pb.ReceiptLifecycleState.VERIFIED } };
          break;
        default: throw new Error("unexpected mutation or RPC: " + method);
      }
      const payload = toBinary(pb[method + "ResponseSchema"], create(pb[method + "ResponseSchema"], fields));
      response.writeHead(200, { "Content-Type": "application/proto" });
      response.end(payload);
    } catch (error) {
      errors.push(error);
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end('{"code":"invalid_argument"}');
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    operations, submissions, errors,
    environment: { ...process.env, DEIXIC_API_KEY: "fixture-secret", DEIXIC_ORGANIZATION_ID: "org-fixture",
      DEIXIC_WORKSPACE_ID: "ws-fixture", DEIXIC_BASE_URL: `http://127.0.0.1:${server.address().port}` },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}

for (const loss of [false, true]) test(`account brief survives a process restart${loss ? " and lost acceptance" : ""}`, async () => {
  const server = await owner(loss);
  const directory = await mkdtemp(join(tmpdir(), "deixic-account-brief-"));
  const path = join(directory, "brief.json");
  try {
    const check = await command(["check"], server.environment);
    assert.equal(check.code, 0);
    assert.equal(check.output.status, "accessible");
    assert.equal(check.output.writeAccess, "not_checked");
    const started = await command(["start", path, "--account", "Example account", "--trigger", "crm-event-001"], server.environment);
    assert.equal(started.code, loss ? 1 : 0);
    if (loss) {
      const pending = await command(["resume", path], server.environment);
      assert.equal(pending.code, 2);
      assert.equal(pending.output.status, "unacknowledged");
      assert.equal(server.submissions.length, 1);
      const replayed = await command(["replay", path], server.environment);
      assert.equal(replayed.code, 0);
      assert.equal(replayed.output.status, "accepted");
    }
    const result = await command(["resume", path], server.environment);
    assert.equal(result.code, 0);
    assert.equal(result.output.status, "completed");
    assert.equal(result.output.body, "Example account: an evidence-linked brief");
    assert.deepEqual(result.output.receiptIds, ["evidence"]);
    assert.equal(server.operations.size, 1);
    assert.equal(server.submissions.length, loss ? 2 : 1);
    if (loss) assert.deepEqual(server.submissions[0], server.submissions[1]);
    assert(!(await readFile(path, "utf8")).includes("fixture-secret"));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const duplicate = await command(["start", path, "--account", "Example account", "--trigger", "crm-event-001"], server.environment);
    assert.equal(duplicate.code, 1);
    assert.equal(server.submissions.length, loss ? 2 : 1);
    assert.deepEqual(server.errors, []);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
