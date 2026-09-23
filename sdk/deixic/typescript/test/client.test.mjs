import assert from "node:assert/strict";
import test from "node:test";

import { create } from "@bufbuild/protobuf";
import {
  AssessComplianceSubjectResponseSchema,
  GetComplianceAssessmentResponseSchema,
  RecordComplianceAssessmentResponseSchema,
  GetOperatingThreadResponseSchema,
  SubmitOperatingMessageResponseSchema,
} from "../dist/gen/ts/console/v1/console_pb.js";
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

test("compliance assessments use the fixed tenant and a typed Deixic RPC", async () => {
  const transport = new RecordingTransport(() => create(AssessComplianceSubjectResponseSchema, {
    assessment: { profileId: "dex-production-action-assurance/v1", inspectedCount: 1, expectedCount: 1 },
  }));
  const deixic = createDeixicClient({
    organizationId: "org-a", workspaceId: "workspace-a", apiKey: "sdk-test-key", transport,
  });
  const response = await deixic.compliance.assess({
    profileId: "dex-production-action-assurance/v1",
    subjectKind: "tool_execution", subjectId: "execution-1",
  });
  assert.equal(response.assessment?.inspectedCount, 1);
  assert.equal(transport.calls[0].method.name, "AssessComplianceSubject");
  assert.equal(transport.calls[0].method.parent.typeName, "deixic.v1.DeixicService");
  assert.equal(transport.calls[0].input.organizationId, "org-a");
  assert.equal(transport.calls[0].input.workspaceId, "workspace-a");
  assert.equal(transport.calls[0].input.subjectId, "execution-1");
});

test("compliance records bind tenant and replay key through typed RPCs", async () => {
  const transport = new RecordingTransport(({ method }) => create(
    method.name === "RecordComplianceAssessment"
      ? RecordComplianceAssessmentResponseSchema : GetComplianceAssessmentResponseSchema,
    { record: { id: "ca_1" } },
  ));
  const deixic = createDeixicClient({
    organizationId: "org-a", workspaceId: "workspace-a", apiKey: "sdk-test-key", transport,
  });
  await deixic.compliance.record({
    profileId: "dex-production-action-assurance/v1", subjectKind: "tool_execution",
    subjectId: "execution-1", idempotencyKey: "snapshot-1",
  });
  await deixic.compliance.get({ recordId: "ca_1" });
  assert.deepEqual(transport.calls.map(({ method }) => method.name), [
    "RecordComplianceAssessment", "GetComplianceAssessment",
  ]);
  assert.equal(transport.calls[0].input.organizationId, "org-a");
  assert.equal(transport.calls[0].input.workspaceId, "workspace-a");
  assert.equal(transport.calls[0].input.idempotencyKey, "snapshot-1");
  assert.equal(transport.calls[1].input.recordId, "ca_1");
});

test("public client fixes tenant scope and sends an API key as a bearer", async () => {
  const transport = new RecordingTransport(() => create(SubmitOperatingMessageResponseSchema, {
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
  assert.equal(call.input.query.organizationId, "org-a");
  assert.equal(call.input.query.workspaceId, "workspace-a");
  assert.equal(call.input.idempotencyKey, "send-1");
});

test("public client rejects ambiguous credentials before transport", () => {
  const transport = new RecordingTransport(() => create(GetOperatingThreadResponseSchema));

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
      transport: new RecordingTransport(() => create(GetOperatingThreadResponseSchema)),
    }),
    (error) => error instanceof DeixicError
      && error.kind === "validation"
      && error.status === 400,
  );
});

test("public client rejects unsafe base URLs before transport", () => {
  const transport = new RecordingTransport(() => create(GetOperatingThreadResponseSchema));
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
      transport: new RecordingTransport(() => create(GetOperatingThreadResponseSchema)),
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
