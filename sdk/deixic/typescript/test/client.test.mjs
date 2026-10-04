import assert from "node:assert/strict";
import test from "node:test";

import { create } from "@bufbuild/protobuf";
import {
  GetThreadResponseSchema, GetVoiceCatalogResponseSchema, SubmitVoicedTaskResponseSchema,
  SubmitTaskResponseSchema,
} from "../dist/sdk/deixic/typescript/src/protocol.js";
import {
  DEFAULT_DEIXIC_BASE_URL,
  DeixicError,
  createDeixicClient,
} from "../dist/sdk/deixic/typescript/src/index.js";

test("public client defaults to the deployed Deixic API origin", () => {
  assert.equal(DEFAULT_DEIXIC_BASE_URL, "https://app.deixic.com");
});

class RecordingTransport {
  calls = [];

  constructor(handler) {
    this.handler = handler;
  }

  async unary(method, signal, timeoutMs, header, input) {
    const call = { method, signal, timeoutMs, header: new Headers(header), input };
    this.calls.push(call);
    return {
      stream: false,
      method,
      header: new Headers(),
      trailer: new Headers(),
      message: await this.handler(call),
    };
  }

  async stream() {
    throw new Error("unexpected stream");
  }
}

test("public client exposes only supported task and thread facades", () => {
  const transport = new RecordingTransport(() => { throw new Error("unexpected RPC"); });
  const deixic = createDeixicClient({
    organizationId: "org-a", workspaceId: "workspace-a", apiKey: "sdk-test-key", transport,
  });
  assert.deepEqual(Object.keys(deixic).sort(), [
    "controls", "events", "messages", "receipts", "scope", "tasks", "threads", "voices",
  ]);
  assert.equal("compliance" in deixic, false);
});

test("public client fixes tenant scope and sends an API key as a bearer", async () => {
  const transport = new RecordingTransport(() => create(SubmitTaskResponseSchema, {
    replayCursor: 8n,
    acceptedTurn: { turnId: "turn-1", sequence: 2n },
  }));
  const deixic = createDeixicClient({
    apiKey: "sdk-test-key",
    organizationId: "org-a",
    workspaceId: "workspace-a",
    transport,
  });

  const response = await deixic.messages.send({
    channelId: "company",
    body: "Review this change.",
    idempotencyKey: "send-1",
    // Runtime callers cannot replace constructor scope with an unknown field.
    query: { organizationId: "org-b", workspaceId: "workspace-b" },
  });

  assert.equal(response.acceptedTurn?.turnId, "turn-1");
  assert.equal(transport.calls.length, 1);
  const call = transport.calls[0];
  assert.equal(call.header.get("Authorization"), "Bearer sdk-test-key");
  assert.equal(call.header.get("X-Organization-ID"), "org-a");
  assert.equal(call.header.get("X-Workspace-ID"), "workspace-a");
  assert.equal(call.input.scope.organizationId, "org-a");
  assert.equal(call.input.scope.workspaceId, "workspace-a");
  assert.equal(call.input.idempotencyKey, "send-1");
});

test("public client rejects ambiguous credentials before transport", () => {
  const transport = new RecordingTransport(() => create(GetThreadResponseSchema));

  assert.throws(
    () => createDeixicClient({
      apiKey: "sdk-test-key",
      auth: { getCredential: () => ({ accessToken: "oauth-token" }) },
      organizationId: "org-a",
      workspaceId: "workspace-a",
      transport,
    }),
    (error) => error instanceof DeixicError
      && error.kind === "validation"
      && error.status === 400
      && /either "apiKey" or "auth"/.test(error.message),
  );
  assert.equal(transport.calls.length, 0);
});

test("public client rejects an explicitly empty API key", () => {
  assert.throws(
    () => createDeixicClient({
      apiKey: " ",
      organizationId: "org-a",
      workspaceId: "workspace-a",
      transport: new RecordingTransport(() => create(GetThreadResponseSchema)),
    }),
    (error) => error instanceof DeixicError
      && error.kind === "validation"
      && error.status === 400,
  );
});

test("public client rejects unsafe base URLs before transport", () => {
  const transport = new RecordingTransport(() => create(GetThreadResponseSchema));
  for (const baseUrl of [
    "deixic.example",
    "ftp://deixic.example",
    "https://user@deixic.example",
    "https://deixic.example?token=x",
  ]) {
    assert.throws(
      () => createDeixicClient({
        apiKey: "sdk-test-key",
        organizationId: "org-a",
        workspaceId: "workspace-a",
        baseUrl,
        transport,
      }),
      (error) => error instanceof DeixicError
        && error.kind === "validation"
        && error.status === 400,
    );
  }
  assert.equal(transport.calls.length, 0);
});

test("public client reports scope validation through DeixicError", () => {
  assert.throws(
    () => createDeixicClient({
      apiKey: "sdk-test-key",
      organizationId: " ",
      workspaceId: "workspace-a",
      transport: new RecordingTransport(() => create(GetThreadResponseSchema)),
    }),
    (error) => error instanceof DeixicError
      && error.kind === "validation"
      && error.status === 400,
  );
});

test("native fetch rejection is unavailable; malformed responses remain protocol errors", async () => {
  const failed = createDeixicClient({ apiKey: "fixture", organizationId: "org", workspaceId: "ws",
    fetch: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(failed.threads.get({ channelId: "company" }), error => error.kind === "unavailable");
  const malformed = createDeixicClient({ apiKey: "fixture", organizationId: "org", workspaceId: "ws",
    fetch: async () => new Response(new Uint8Array([255]), { headers: { "Content-Type": "application/proto" } }) });
  await assert.rejects(malformed.threads.get({ channelId: "company" }), error => error.kind === "protocol");
});

test("request response cannot replace fixed scope or accepted turn coordinates", async () => {
  const transport = new RecordingTransport(call => create(call.method.output));
  const sdk = createDeixicClient({ organizationId: "org-a", workspaceId: "workspace-a", apiKey: "fixture", transport });
  await sdk.controls.respond({ channelId: "thread-a", turnId: "turn-a", idempotencyKey: "decision-a",
    response: { scope: { organizationId: "other", workspaceId: "other" }, threadId: "other", turnId: "other",
      requestId: "request-a", requestKind: 1, action: 1 } });
  const call = transport.calls[0];
  assert.equal(call.method.parent.typeName, "deixicpublic.v1.DeixicPublicService");
  assert.equal(call.method.name, "RespondToRequest");
  assert.equal(call.input.scope.organizationId, "org-a");
  assert.equal(call.input.scope.workspaceId, "workspace-a");
  assert.equal(call.input.threadId, "thread-a");
  assert.equal(call.input.turnId, "turn-a");
  assert.equal(call.input.requestId, "request-a");
});

test("unsupported offset pagination fails before any request", async () => {
  const transport = new RecordingTransport(() => { throw new Error("unexpected request"); });
  const sdk = createDeixicClient({ organizationId: "org-a", workspaceId: "workspace-a", transport });
  await assert.rejects(async () => sdk.threads.get({ channelId: "thread-a", offset: 1 }), DeixicError);
  assert.equal(transport.calls.length, 0);
});


test("explicit blend uses a separate RPC and snapshots before credential callbacks", async () => {
  const selection = { mode: 2, voiceIds: ["lead", "support"], toneAdjustments: [3, 1] };
  const transport = new RecordingTransport(() => create(SubmitVoicedTaskResponseSchema, {
    result: { acceptedTurn: { turnId: "voiced", sequence: 1n } },
  }));
  const sdk = createDeixicClient({ organizationId: "org-a", workspaceId: "workspace-a", transport,
    auth: { getCredential: () => { selection.voiceIds.reverse(); return { accessToken: "fixture" }; } },
  });
  assert.equal((await sdk.messages.send({ channelId: "company", body: "draft", idempotencyKey: "voice-key", voiceSelection: selection })).acceptedTurn.turnId, "voiced");
  assert.equal(transport.calls[0].method.name, "SubmitVoicedTask");
  assert.deepEqual(transport.calls[0].input.voiceSelection.voiceIds, ["lead", "support"]);
  assert.deepEqual(transport.calls[0].input.voiceSelection.toneAdjustments, [1, 3]);
  assert.equal(transport.calls[0].input.task.idempotencyKey, "voice-key");
});

test("catalog is scope fenced and voice selections are bounded before I/O", async () => {
  const transport = new RecordingTransport(() => create(GetVoiceCatalogResponseSchema, { scope: { organizationId: "org-b", workspaceId: "workspace-a" } }));
  const sdk = createDeixicClient({ organizationId: "org-a", workspaceId: "workspace-a", apiKey: "fixture", transport });
  await assert.rejects(sdk.voices.list(), error => error.kind === "protocol");
  for (const selection of [{ mode: 2, voiceIds: [] }, { mode: 2, voiceIds: ["a", "a"] }, { mode: 3, voiceIds: ["a"] }, { mode: 2, voiceIds: ["a", "b", "c", "d", "e"] }, { mode: 9 }]) {
    assert.throws(() => sdk.messages.send({ channelId: "company", body: "draft", idempotencyKey: "key", voiceSelection: selection }), DeixicError);
  }
  assert.equal(transport.calls.length, 1);
});

test("Unicode voice IDs obey the same character boundary as the owner and Python SDK", async () => {
  const voiceId = "😀".repeat(128);
  let credentialReads = 0;
  const transport = new RecordingTransport(() => create(SubmitVoicedTaskResponseSchema, {
    result: { acceptedTurn: { turnId: "unicode", sequence: 1n } },
  }));
  const sdk = createDeixicClient({ organizationId: "org-a", workspaceId: "workspace-a", transport,
    auth: { getCredential: () => { credentialReads++; return { accessToken: "fixture" }; } },
  });
  await sdk.messages.send({ channelId: "company", body: "draft", idempotencyKey: "unicode-key",
    voiceSelection: { mode: 2, voiceIds: [voiceId, "support"] } });
  assert.deepEqual(transport.calls[0].input.voiceSelection.voiceIds, [voiceId, "support"]);
  assert.equal(credentialReads, 1);
  assert.throws(() => sdk.messages.send({ channelId: "company", body: "draft", idempotencyKey: "too-long",
    voiceSelection: { mode: 2, voiceIds: [`${voiceId}😀`] } }), DeixicError);
  assert.equal(credentialReads, 1);
  assert.equal(transport.calls.length, 1);
});

test("voiced authentication replay keeps the original binary request and never falls back", async () => {
  const { Code, ConnectError } = await import('@connectrpc/connect');
  const { toBinary } = await import('@bufbuild/protobuf');
  const selection = { mode: 2, voiceIds: ['lead', 'support'], toneAdjustments: [3] };
  const bytes = [];
  const transport = new RecordingTransport(call => {
    bytes.push(toBinary(call.method.input, call.input));
    if (bytes.length === 1) throw new ConnectError('expired', Code.Unauthenticated);
    return create(SubmitVoicedTaskResponseSchema, { result: { acceptedTurn: { turnId: 'turn', sequence: 1n } } });
  });
  const sdk = createDeixicClient({ organizationId: 'org-a', workspaceId: 'workspace-a', transport,
    auth: { getCredential: () => ({ accessToken: 'old', subject: 'user' }),
      refreshCredential: () => { selection.voiceIds.reverse(); return { accessToken: 'new', subject: 'user' }; } },
  });
  await sdk.messages.send({ channelId: 'company', body: 'draft', idempotencyKey: 'key', voiceSelection: selection });
  assert.deepEqual(bytes[0], bytes[1]);
  assert.deepEqual(transport.calls.map(call => call.method.name), ['SubmitVoicedTask', 'SubmitVoicedTask']);
  const old = new RecordingTransport(() => { throw new ConnectError('unknown method', Code.Unimplemented); });
  const oldSdk = createDeixicClient({ organizationId: 'org-a', workspaceId: 'workspace-a', apiKey: 'fixture', transport: old });
  await assert.rejects(oldSdk.messages.send({ channelId: 'company', body: 'draft', idempotencyKey: 'key', voiceSelection: { mode: 3 } }), DeixicError);
  assert.deepEqual(old.calls.map(call => call.method.name), ['SubmitVoicedTask']);
});
