import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(resolve(tmpdir(), "deixic-sdk-package-"));
try {
  const result = JSON.parse(execFileSync("npm", [
    "pack", "--ignore-scripts", "--json", "--pack-destination", scratch,
    "--cache", resolve(scratch, "pack-cache"),
  ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
  assert.equal(result.length, 1);
  const names = new Set(result[0].files.map((file) => file.path));
  assert(names.has("LICENSE"));
  assert(names.has("dist/sdk/deixic/typescript/src/index.js"));
  assert(names.has("dist/sdk/maestro/typescript/src/client.js"));
  assert(names.has("dist/gen/ts/console/v1/console_pb.js"));
  assert(names.has("dist/gen/ts/deixic/v1/deixic_pb.js"));
  assert(names.has("examples/account-brief.mjs"));
  assert(names.has("dist/sdk/deixic/typescript/src/tasks.js"));

  const consumer = resolve(scratch, "consumer");
  await mkdir(consumer);
  await writeFile(resolve(consumer, "package.json"), JSON.stringify({
    name: "deixic-sdk-package-consumer",
    private: true,
    type: "module",
    dependencies: { "@evalops/deixic-sdk": `file:../${result[0].filename}` },
  }));
  execFileSync("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund",
    "--cache", resolve(scratch, "cache"),
  ], { cwd: consumer, stdio: "inherit" });
  execFileSync("npm", [
    "ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund",
    "--cache", resolve(scratch, "cache"),
  ], { cwd: consumer, stdio: "inherit" });

  const installed = JSON.parse(await readFile(
    resolve(consumer, "node_modules/@evalops/deixic-sdk/package.json"),
    "utf8",
  ));
  assert.equal(installed.name, "@evalops/deixic-sdk");
  assert.equal(installed.exports["."].import, "./dist/sdk/deixic/typescript/src/index.js");

  await writeFile(resolve(consumer, "smoke.mjs"), `
import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import { createDeixicClient, OperatingTurnState } from "@evalops/deixic-sdk";
assert.equal(typeof OperatingTurnState, "object");
let calls = 0;
let completed = false;
const client = createDeixicClient({
  apiKey: "package-test-key",
  organizationId: "org-package-test",
  workspaceId: "workspace-package-test",
  transport: {
    async unary(method, signal, timeout, headers, input) {
      calls += 1;
      assert.equal(method.parent.typeName, "deixic.v1.DeixicService");
      assert.equal(headers.get("Authorization"), "Bearer package-test-key");
      assert.equal(input.query.organizationId, "org-package-test");
      assert.equal(input.query.workspaceId, "workspace-package-test");
      let fields;
      if (method.name === "SubmitOperatingMessage") {
        assert.equal(input.idempotencyKey, "installed-request");
        fields = { replayCursor: 9007199254740993n, acceptedTurn: { turnId: "installed-turn", sequence: 2n, state: OperatingTurnState.QUEUED } };
      } else if (method.name === "ListOperatingThreadEvents") {
        completed = true;
        fields = { nextCursor: input.afterCursor };
      } else {
        assert.equal(method.name, "GetOperatingThread");
        fields = { replayCursor: 9007199254740993n, channel: { id: "channel-package-test" },
          turns: [{ turnId: "installed-turn", sequence: 2n, state: completed ? OperatingTurnState.COMPLETED : OperatingTurnState.QUEUED,
            assistantMessageId: completed ? "answer" : "" }],
          messages: completed ? [{ id: "answer", channelId: "channel-package-test", role: "assistant", body: "Installed result" }] : [] };
      }
      return { message: create(method.output, fields) };
    },
    stream() { throw new Error("unexpected stream"); },
  },
});
const thread = await client.threads.get({ channelId: "channel-package-test" });
assert.equal(thread.replayCursor, 9007199254740993n);
assert.equal(calls, 1);
const checkpoints = [];
const task = await client.tasks.start({ channelId: "channel-package-test", body: "Return a result",
  idempotencyKey: "installed-request", onCheckpoint: value => checkpoints.push(value) });
const resumed = client.tasks.resume(JSON.parse(JSON.stringify(checkpoints.at(-1))));
const result = await resumed.wait();
assert.equal(result.status, "completed");
assert.equal(result.body, "Installed result");
assert.equal(task.checkpoint().cursor, "9007199254740993");
`);
  execFileSync(process.execPath, ["smoke.mjs"], { cwd: consumer, stdio: "inherit" });
  execFileSync(process.execPath, [
    resolve(consumer, "node_modules/@evalops/deixic-sdk/examples/account-brief.mjs"), "--help",
  ], { cwd: consumer, stdio: "inherit" });

  await writeFile(resolve(consumer, "smoke.ts"), `
import { createDeixicClient, parseTaskResult, type DeixicClient, type GetThreadInput, type TaskCheckpoint, type TaskResult } from "@evalops/deixic-sdk";
import { parseAccountBrief, type AccountBrief } from "@evalops/deixic-sdk/examples/account-brief-result";
const parse: (body: string) => AccountBrief = parseAccountBrief;
void parse;
const input: GetThreadInput = { channelId: "channel", offset: 0 };
const client: DeixicClient = createDeixicClient({
  apiKey: "test-key",
  organizationId: "org",
  workspaceId: "workspace",
});
void client.threads.get(input);
async function taskResult(): Promise<string> {
  const task = await client.tasks.start({ channelId: "channel", body: "Return a result", idempotencyKey: "request" });
  const saved: TaskCheckpoint = task.checkpoint();
  const result: TaskResult = await client.tasks.resume(saved).wait();
  return result.status === "completed" ? parseTaskResult(result, body => body) : result.status;
}
void taskResult;
`);
  execFileSync(process.execPath, [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext",
    "--moduleResolution", "NodeNext", "smoke.ts",
  ], { cwd: consumer, stdio: "inherit" });
  console.log("Packed Deixic SDK passed isolated install, runtime, and declaration checks.");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
