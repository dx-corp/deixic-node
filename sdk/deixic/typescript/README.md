# Deixic SDK for TypeScript

`@evalops/deixic-sdk` is the supported TypeScript client for applications that
submit Deixic tasks, follow durable progress, interrupt work, and approve or
deny requested actions. It exposes that focused contract without publishing
Deixic's browser-only API as an application interface.

## Install

```sh
npm install @evalops/deixic-sdk
```

## Quickstart

Use an API key only from a trusted server-side process:

```ts
import { createDeixicClient } from "@evalops/deixic-sdk";

const deixic = createDeixicClient({
  apiKey: process.env.DEIXIC_API_KEY,
  organizationId: "org_123",
  workspaceId: "ws_456",
});

const task = await deixic.tasks.start({
  channelId: "company",
  body: "Review the open changes.",
  idempotencyKey: "review-request-001", // Stable business-event ID for this request.
});

const result = await task.wait({ timeoutMs: 60_000 });

if (result.status === "completed") {
  console.log(result.body);
} else {
  console.log(result.status);
}
```

Choose a different key for each new business request. Recovery of the same
request keeps its original key and body. `task.wait()` follows durable events
and retrieves the final answer linked to that accepted turn, together with
its referenced receipts. The lower-level `observeAcceptedTurn` helper remains
available for callers that own their streaming policy.

## Compliance assessments

`deixic.compliance.assess()` evaluates a versioned control against a record
fetched from its owning service under the client's fixed organization and
workspace:

```ts
const { assessment } = await deixic.compliance.assess({
  profileId: "dex-production-action-assurance/v1",
  subjectKind: "tool_execution",
  subjectId: "tex_123",
});
```

The response names each requirement, its `ComplianceFindingStatus` value,
a reason code and the owner reference. The first profile tags findings with
the internal `DEX-ACTION-ASSURANCE` control; mapping that control to an
external framework requires a separately reviewed mapping. Denied actions are `NOT_APPLICABLE`;
executions without a confirmed succeeded state are `INDETERMINATE`. It includes a
digest of the exact Tool Execution returned by the owner and declares coverage
of one requested record. This is a live read; store the result in your own
system if you need to retain that observation. The current profile reports
the independent Audit receipt as indeterminate because Tool Executor has no
general Audit sink. Do not treat the result as proof of an external state
change or of every action in a time window.

## Task handles and setup checks

`await deixic.tasks.checkSetup({ channelId: "company" })` makes one read
request to verify channel access and reports the owner's workspace prerequisites
and selected/default model availability. `accessible` confirms read access; `writeAccess`
remains `not_checked`. The report contains `nextAction` and, on failure, an SDK
error with its request ID. Submission checks write authorization and execution.

For restart recovery, use `await tasks.prepare({ ..., onCheckpoint })` with
your application's storage adapter, then `await task.submit()`. The callback
runs before submission and after acceptance or consumed event pages. Storage
errors propagate. `tasks.resume(savedCheckpoint)` restores observation
coordinates and never submits work. `await task.replay()` explicitly repeats
only an unacknowledged request with its original body, key, tenant and origin.

Checkpoints use the shared Python/TypeScript `deixic.task.v1` format with
decimal-string int64 cursors. They contain the request body and no SDK
credential. Protect them as customer data and use one observer/storage writer
per checkpoint. A checkpoint never proves authorization or task completion.

`wait()` uses bounded event backfill and polling, reconnecting read requests
after transport/unavailable failures up to `maxReconnectAttempts`. It never
retries a mutation. `timeoutMs` and `signal` stop local observation; remote
interruption requires an explicit `controls.interrupt()` call. Custom transports
must honor the provided `AbortSignal`.

`wait()` continues past a preliminary `responded` state until completion,
failure, interruption or work that needs attention. `result()` reads the current
owner state once. Outcomes are `completed`, `responded`, `waiting`, `failed`, `interrupted`,
`unfinished`, `prepared`, or `unacknowledged`. Waiting includes the turn's
waiting reason and a freshly retrieved request event when retained. Use that
event's request identity with `controls.respond()` after an explicit
application/user decision. Missing request history stays
`waiting/request_not_visible`; no approval is invented or sent automatically.
Progress callbacks receive only new matching-turn events. Callbacks may be
delivered again after a storage failure or restart; make application effects
idempotent. Callback exceptions propagate.

`parseTaskResult(result, yourParser)` validates/converts a completed answer
using your application's schema. Parser failures propagate. A completed answer
does not prove that every external action succeeded; inspect the receipts'
owner-resolved lifecycle and evidence for those actions.

## Account-brief workflow

Use a workspace with connected CRM data and a policy that permits only CRM
reads for this workflow. The SDK creates no connector, grant or model route.
The example asks for a summary, open opportunities, risks and source references;
Platform enforces the access and action policy for the workspace.

Set `DEIXIC_API_KEY`, `DEIXIC_ORGANIZATION_ID`, and `DEIXIC_WORKSPACE_ID` from
your workspace. `DEIXIC_BASE_URL` defaults to `https://app.deixic.com`.
After installing the package, run:

```sh
npx deixic-account-brief check --channel company
npx deixic-account-brief start account-brief.json \
  --channel company --account 'Example account' --trigger crm-event-001
# A separate process retrieves the result:
npx deixic-account-brief resume account-brief.json
```

`start` saves a private checkpoint before sending and reports acceptance.
`resume` prints the final brief and receipt IDs when completed. It returns
exit code 2 for unfinished work or work that needs attention. If acceptance was
lost, explicitly run `replay account-brief.json`, then resume. A new `start`
refuses an existing checkpoint path. The same file can be resumed by the
Python account-brief example with the same tenant and origin.
Add `--structured` to `start` to request the versioned JSON brief and validate
facts against its declared source IDs. A restarted worker remembers the saved
format. `resume --progress` writes matching event IDs to standard error and the final
JSON to standard output. Missing CRM data is explicit; malformed results return exit 2
with `invalid_result`, without another submission. Receipt owner, object,
lifecycle and evidence references appear separately in `actions`. A completed
answer with a failed or unavailable receipt still returns exit 2.

The installed example also supports explicit `approve` and `deny` commands with
`--request` and `--decision-key`. They re-fetch the current owner request;
Platform checks the operator's authorization. Observation never approves work.
See the [complete application guide](https://www.deixic.com/developers/sdk/account-brief)
for the trigger/worker integration, result format, approval decisions, receipt
interpretation and tested recovery cases. The private-file storage example
requires a POSIX filesystem supporting atomic rename, hard links and `fsync()`;
hosted applications use their existing durable storage and job queue.

## Authentication and tenant scope

The organization and workspace are fixed when the client is created. Method
inputs cannot replace them. Every request carries the same scope in the typed
request and `X-Organization-ID` / `X-Workspace-ID` headers.

For OAuth or rotating workload credentials, provide an authentication source:

```ts
const deixic = createDeixicClient({
  organizationId,
  workspaceId,
  auth: {
    getCredential: () => ({
      accessToken,
      subject,
      organizationId,
      workspaceId,
      scopes: ["console:read", "console:write"],
    }),
    refreshCredential: refreshAccessToken,
  },
});
```

The SDK permits one replay after an authentication challenge only when the
refreshed credential retains the same subject, tenant, and declared scopes.
Mutation methods do not retry unavailable or transport failures. Task
observation has the bounded read recovery described above.

Browser applications should keep API keys out of browser code. Use a
same-origin authenticated server, or a credential source backed by the
application's OAuth session.

## Request replay and recovery

Every mutation requires a caller-owned `idempotencyKey`. The SDK never invents
or replaces one. Keep the same key when the application intentionally resumes
the same logical operation.

For thread recovery:

1. Read `threads.get()` and retain its `replayCursor`.
2. Backfill with `events.list({ afterCursor })`.
3. Apply ordinary events in cursor order.
4. When `resetRequired` is true, replace the local projection with the supplied
   snapshot and authoritative `threadExecution.replayCursor`.
5. Reconnect a watch from the last saved cursor. Never resend a mutation merely
   because observation ended.

The SDK preserves protobuf `bigint` cursor and sequence values. Convert them
only at a boundary that can reject unsafe JavaScript numbers.

## Errors

Failures are reported as `DeixicError` with a stable `kind`, HTTP `status` when
known, platform error `code`, request ID, and trace context. The error cause
retains the original Connect failure for advanced diagnostics.

## Supported runtime

Node.js 20 or later is supported. The client also works in modern browsers
when the application supplies an appropriate authenticated transport.
