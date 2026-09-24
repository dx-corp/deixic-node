import assert from "node:assert/strict";
import test from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  GetThreadResponseSchema, GetReceiptResponseSchema,
  SubmitTaskResponseSchema, ListEventsResponseSchema,
  OperatingTurnState, OperatingThreadEventKind, OperatingThreadRequestType,
  OperatingThreadWaitingReason,
} from "../dist/sdk/deixic/typescript/src/protocol.js";
import { createDeixicClient, DeixicError, parseTaskResult } from "../dist/sdk/deixic/typescript/src/index.js";

const C = 9_007_199_254_740_994n;
const acceptance = () => create(SubmitTaskResponseSchema, {
  replayCursor: C, acceptedTurn: { turnId: "target", sequence: 2n, state: OperatingTurnState.ACCEPTED },
});
const finished = (options = {}) => create(GetThreadResponseSchema, {
  thread: { id: "company" },
  turns: [{ turnId: "target", sequence: 2n, state: OperatingTurnState.COMPLETED, assistantMessageId: "answer", ...options.turn }],
  messages: [{ id: "answer", channelId: "company", role: 2, body: "Account brief", ...options.message }],
});
const page = (options = {}) => create(ListEventsResponseSchema, { nextCursor: C, ...options });

class Transport {
  calls = [];
  constructor(responses) { this.responses = responses; }
  async unary(method, signal, timeout, header, input) {
    this.calls.push({ method: method.name, signal, input, header: new Headers(header) });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    assert(response, `unexpected ${method.name}`);
    return { stream: false, method, header: new Headers(), trailer: new Headers(),
      message: typeof response === "function" ? await response(signal, input) : response };
  }
  stream() { throw new Error("unexpected stream"); }
}
function client(transport) {
  return createDeixicClient({ apiKey: "fixture-secret", organizationId: "org-fixture",
    workspaceId: "ws-fixture", baseUrl: "https://api.deixic.test", transport });
}
function prepare(sdk, options = {}) {
  return sdk.tasks.prepare({ channelId: "company", body: "Create an account brief",
    idempotencyKey: "crm-trigger-1", ...options });
}

test("lost acceptance requires explicit replay of the same request", async () => {
  const transport = new Transport([new Error("lost after acceptance"), acceptance()]);
  const checkpoints = [];
  const task = await prepare(client(transport), { onCheckpoint: value => checkpoints.push(value) });
  await assert.rejects(task.submit(), DeixicError);
  const saved = JSON.parse(JSON.stringify(checkpoints.at(-1)));
  assert.equal(saved.submission, "unacknowledged");
  assert(!JSON.stringify(saved).includes("fixture-secret"));
  const resumed = client(transport).tasks.resume(saved);
  assert.equal((await resumed.result()).status, "unacknowledged");
  assert.equal(transport.calls.length, 1);
  await assert.rejects(resumed.submit(), DeixicError);
  await resumed.replay();
  assert.deepEqual(transport.calls[0].input, transport.calls[1].input);
  assert.equal(resumed.checkpoint().cursor, C.toString());
  await assert.rejects(resumed.replay(), DeixicError);
});

test("completed result fetches exact linked answer and receipts across pages", async () => {
  const first = finished();
  first.messages = [];
  first.nextPageToken = "older";
  const second = finished({ message: { receiptIds: ["evidence"] } });
  second.turns = [];
  const transport = new Transport([acceptance(), first, second,
    create(GetReceiptResponseSchema, { receipt: { id: "evidence" } })]);
  const result = await (await prepare(client(transport))).submit().then(task => task.result());
  assert.equal(result.status, "completed");
  assert.equal(result.body, "Account brief");
  assert.equal(result.message.id, "answer");
  assert.equal(result.receipts[0].id, "evidence");
  assert.equal(parseTaskResult(result, value => value.toUpperCase()), "ACCOUNT BRIEF");
});

test("resume rejects tenant/origin changes and unsafe checkpoint coordinates", async () => {
  const transport = new Transport([]);
  const sdk = client(transport);
  const saved = (await prepare(sdk)).checkpoint();
  for (const field of ["organizationId", "workspaceId", "baseUrl"]) {
    assert.throws(() => sdk.tasks.resume({ ...saved, [field]: "different" }), DeixicError);
  }
  for (const [field, value] of [["cursor", Number(C)], ["sequence", "02"], ["cursor", "-1"],
    ["cursor", "9223372036854775808"], ["cursor", "9".repeat(5000)], ["projectResourceId", false]]) {
    assert.throws(() => sdk.tasks.resume({ ...saved, [field]: value }), DeixicError);
  }
  assert.equal(transport.calls.length, 0);
});

test("retention reset uses owner execution cursor and ignores reset events", async () => {
  const transport = new Transport([acceptance(), page({ resetRequired: true, nextCursor: C + 9n,
    snapshot: { replayCursor: C + 2n },
    events: [{ cursor: C + 9n, turnId: "target", kind: OperatingThreadEventKind.TURN_COMPLETED }],
  }), finished()]);
  const task = await (await prepare(client(transport))).submit();
  const events = [];
  assert.equal((await task.wait({ onEvent: event => events.push(event) })).status, "completed");
  assert.equal(task.checkpoint().cursor, (C + 2n).toString());
  assert.deepEqual(events, []);
});

test("reconnection retries observation without resubmission", async () => {
  const transport = new Transport([acceptance(), new ConnectError("unavailable", Code.Unavailable), page(), finished()]);
  const task = await (await prepare(client(transport))).submit();
  assert.equal((await task.wait({ pollIntervalMs: 1 })).status, "completed");
  assert.deepEqual(transport.calls.map(item => item.method), [
    "SubmitTask", "ListEvents", "ListEvents", "GetThread",
  ]);
});

test("progress includes only new matching events and detaches callback data", async () => {
  const own = { cursor: C + 2n, turnId: "target", id: "own", kind: OperatingThreadEventKind.PROGRESS };
  const transport = new Transport([acceptance(), page({ nextCursor: C + 2n, events: [
    { cursor: C + 1n, turnId: "other", kind: OperatingThreadEventKind.TURN_COMPLETED }, own, own,
  ] }), finished()]);
  const task = await (await prepare(client(transport))).submit();
  const events = [];
  const result = await task.wait({ onEvent(event) {
    events.push(event.id);
    assert.throws(() => { event.turnId = "forged"; }, TypeError);
  } });
  assert.deepEqual(events, ["own"]);
  assert.equal(result.status, "completed");
  assert.equal(result.event.turnId, "target");
});

test("pending approval request recovers from owner history after restart", async () => {
  const original = new Transport([acceptance()]);
  const saved = (await (await prepare(client(original))).submit()).checkpoint();
  const transport = new Transport([
    finished({ turn: { state: OperatingTurnState.WAITING, waitingReason: OperatingThreadWaitingReason.APPROVAL, firstCursor: C - 3n } }),
    page({ nextCursor: C - 1n, events: [{ cursor: C - 1n, turnId: "target", id: "approval",
      kind: OperatingThreadEventKind.APPROVAL_REQUIRED, requestId: "approval-1", requestKind: OperatingThreadRequestType.APPROVAL }] }),
  ]);
  const result = await client(transport).tasks.resume(saved).result();
  assert.equal(result.status, "waiting");
  assert.equal(result.event.requestId, "approval-1");
  assert.equal(result.body, undefined);
  assert.equal(transport.calls[1].input.afterCursor, C - 4n);
});

test("retained request absence stays waiting without inventing approval", async () => {
  const transport = new Transport([acceptance(), finished({ turn: { state: OperatingTurnState.WAITING,
    waitingReason: OperatingThreadWaitingReason.APPROVAL } }), page({ resetRequired: true })]);
  const result = await (await (await prepare(client(transport))).submit()).result();
  assert.equal(result.status, "waiting");
  assert.equal(result.reason, "request_not_visible");
  assert.equal(result.event, undefined);
});

for (const bad of ["sequence", "message_id", "role", "channel", "receipt"]) {
  test(`completed result fails closed on mismatched ${bad}`, async () => {
    const result = finished();
    const tail = [];
    if (bad === "sequence") result.turns[0].sequence = 3n;
    if (bad === "message_id") result.turns[0].assistantMessageId = "missing";
    if (bad === "role") result.messages[0].role = "user";
    if (bad === "channel") result.thread.id = "other";
    if (bad === "receipt") {
      result.messages[0].receiptIds = ["requested"];
      tail.push(create(GetReceiptResponseSchema, { receipt: { id: "wrong" } }));
    }
    const transport = new Transport([acceptance(), result, ...tail]);
    const task = await (await prepare(client(transport))).submit();
    await assert.rejects(task.result(), error => error instanceof DeixicError && error.kind === "protocol");
  });
}

for (const [state, status] of [[OperatingTurnState.RESPONDED, "responded"], [OperatingTurnState.FAILED, "failed"],
  [OperatingTurnState.INTERRUPTED, "interrupted"], [OperatingTurnState.RUNNING, "unfinished"]]) {
  test(`${status} owner state has no final answer`, async () => {
    const transport = new Transport([acceptance(), finished({ turn: { state } })]);
    const result = await (await (await prepare(client(transport))).submit()).result();
    assert.equal(result.status, status);
    assert.equal(result.body, undefined);
    assert.throws(() => parseTaskResult(result, JSON.parse), DeixicError);
  });
}

test("storage failure prevents submission; application errors are never retried", async () => {
  const transport = new Transport([]);
  const task = await prepare(client(transport), { onCheckpoint(state) {
    if (state.submission === "unacknowledged") throw new Error("storage failed");
  } });
  await assert.rejects(task.submit(), /storage failed/);
  assert.equal(transport.calls.length, 0);

  const observing = new Transport([acceptance(), page({ nextCursor: C + 1n,
    events: [{ cursor: C + 1n, turnId: "target", id: "own" }] })]);
  const observed = await (await prepare(client(observing))).submit();
  const failure = new DeixicError({ message: "application failure", kind: "transport" });
  await assert.rejects(observed.wait({ onEvent() { throw failure; } }), error => error === failure);
  assert.equal(observing.calls.length, 2);
  assert.equal(observed.checkpoint().cursor, C.toString());
});

test("local cancellation does not interrupt work", async () => {
  const transport = new Transport([acceptance()]);
  const task = await (await prepare(client(transport))).submit();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await task.wait({ signal: controller.signal })).reason, "cancelled");
  assert.equal(transport.calls.length, 1);
});

test("deadline aborts reads and preserves accepted checkpoint", async () => {
  const transport = new Transport([acceptance(), signal => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new ConnectError("cancelled", Code.Canceled)), { once: true });
  })]);
  const task = await (await prepare(client(transport))).submit();
  const result = await task.wait({ timeoutMs: 10 });
  assert.equal(result.status, "unfinished");
  assert.equal(result.reason, "deadline");
  assert.equal(transport.calls[1].signal.aborted, true);
  assert.equal(task.checkpoint().submission, "accepted");
});

for (const [name, options] of [
  ["skipped events", { nextCursor: C + 2n }], ["stalled pagination", { hasMore: true }],
  ["missing reset cursor", { resetRequired: true }],
  ["conflicting events", { nextCursor: C + 1n, events: [
    { cursor: C + 1n, turnId: "target", id: "a" }, { cursor: C + 1n, turnId: "target", id: "b" },
  ] }],
]) test(`invalid ${name} does not advance checkpoint`, async () => {
  const transport = new Transport([acceptance(), page(options)]);
  const task = await (await prepare(client(transport))).submit();
  await assert.rejects(task.wait(), error => error instanceof DeixicError && error.kind === "protocol");
  assert.equal(task.checkpoint().cursor, C.toString());
});

test("setup preserves owner prerequisites and does not claim write access", async () => {
  const transport = new Transport([create(GetThreadResponseSchema, {
    thread: { id: "company" }, setup: { accessible: false, missingRequirements: ["Connect CRM"] },
  })]);
  const report = await client(transport).tasks.checkSetup({ channelId: "company" });
  assert.equal(report.status, "needs_attention");
  assert.equal(report.writeAccess, "not_checked");
  assert.equal(report.capabilities[0].missingRequirements[0], "Connect CRM");
  assert.equal(transport.calls.length, 1);
});

test("setup failure has actionable grants guidance and support reference", async () => {
  const transport = new Transport([new ConnectError("denied", Code.PermissionDenied,
    { "x-request-id": "support-1" })]);
  const report = await client(transport).tasks.checkSetup({ channelId: "company" });
  assert.equal(report.status, "error");
  assert(report.nextAction.includes("read grants"));
  assert.equal(report.error.requestId, "support-1");
});

test("setup reports owner model availability", async () => {
  const transport = new Transport([create(GetThreadResponseSchema, {
    thread: { id: "company" }, setup: { accessible: true, defaultModel: { provider: "fixture", model: "chosen",
      ready: false } },
  })]);
  const report = await client(transport).tasks.checkSetup({ channelId: "company" });
  assert.equal(report.status, "needs_attention");
  assert.equal(report.defaultModel.ready, false);
  assert.equal(report.modelSelection, undefined);
});

test("wait continues past preliminary response until owner completion", async () => {
  const transport = new Transport([acceptance(), page(), finished({ turn: { state: OperatingTurnState.RESPONDED } }), page(), finished()]);
  const task = await (await prepare(client(transport))).submit();
  assert.equal((await task.wait({ pollIntervalMs: 1 })).status, "completed");
  assert.equal(transport.calls.length, 5);
});

test("visible final answer does not scan unrelated old history", async () => {
  const response = finished();
  response.nextPageToken = "unrelated-old-history";
  const transport = new Transport([acceptance(), response]);
  const task = await (await prepare(client(transport))).submit();
  assert.equal((await task.result({ maxPages: 1 })).body, "Account brief");
  assert.equal(transport.calls.length, 2);
});

test("selected ready model is not blocked by unavailable default", async () => {
  const transport = new Transport([create(GetThreadResponseSchema, {
    thread: { id: "company" }, setup: { accessible: true, defaultModel: { provider: "fixture", model: "default", ready: false },
    selection: { provider: "fixture", model: "chosen" }, availableModels: [{ provider: "fixture", model: "chosen", ready: true }] },
  })]);
  const report = await client(transport).tasks.checkSetup({ channelId: "company" });
  assert.equal(report.status, "accessible");
  assert.equal(report.selectedModel.model, "chosen");
  assert.equal(report.selectedModel.ready, true);
});

for (const explicitSelection of [false, true]) test(`setup rejects an absent execution route (${explicitSelection ? "removed selection" : "no default"})`, async () => {
  const transport = new Transport([create(GetThreadResponseSchema, {
    thread: { id: "company" },
    setup: { accessible: true, ...(explicitSelection ? { selection: { provider: "fixture", model: "removed" } } : {}) },
  })]);
  const report = await client(transport).tasks.checkSetup({ channelId: "company" });
  assert.equal(report.status, "needs_attention");
  assert.equal(report.selectedModel, undefined);
  assert.match(report.nextAction, /model availability/);
});

test("parser failures propagate without changing completion", async () => {
  const transport = new Transport([acceptance(), finished({ message: { body: "invalid JSON" } })]);
  const result = await (await (await prepare(client(transport))).submit()).result();
  assert.throws(() => parseTaskResult(result, JSON.parse), SyntaxError);
  assert.equal(result.status, "completed");
});

test("invalid acceptance stays unacknowledged and requires explicit replay", async () => {
  const transport = new Transport([create(SubmitTaskResponseSchema)]);
  const task = await prepare(client(transport));
  await assert.rejects(task.submit(), error => error instanceof DeixicError && error.kind === "protocol");
  assert.equal((await task.result()).status, "unacknowledged");
  assert.equal(transport.calls.length, 1);
});
