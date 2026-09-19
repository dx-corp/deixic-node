#!/usr/bin/env node
import { open, readFile, rename, link, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { createDeixicClient, DeixicError, parseTaskResult, OperatingThreadRequestType, OperatingThreadResponseAction, ReceiptLifecycleState } from "@evalops/deixic-sdk";

import { FORMAT_INSTRUCTION, parseAccountBrief } from "./account-brief-result.mjs";

async function save(path, state, create = false) {
  const directory = await mkdtemp(join(dirname(path), basename(path) + "."));
  const target = join(directory, "checkpoint.json");
  try {
    const file = await open(target, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
    finally { await file.close(); }
    if (create) await link(target, path);
    else await rename(target, path);
    const parent = await open(dirname(path), "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("deixic-account-brief check [--channel ID]\n"
      + "deixic-account-brief start CHECKPOINT --account NAME --trigger STABLE_ID [--channel ID]\n"
      + "deixic-account-brief resume CHECKPOINT [--timeout MILLISECONDS] [--progress]\n"
      + "deixic-account-brief approve|deny CHECKPOINT --request ID --decision-key STABLE_ID\n"
      + "Add --structured to start to request and validate a JSON account brief.\n"
      + "deixic-account-brief replay CHECKPOINT\n"
      + "Uses CRM data available in your Deixic workspace. Set DEIXIC_API_KEY, DEIXIC_ORGANIZATION_ID and DEIXIC_WORKSPACE_ID.");
    return 0;
  }
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    channel: { type: "string" }, account: { type: "string" }, trigger: { type: "string" },
    timeout: { type: "string", default: "60000" },
    structured: { type: "boolean", default: false }, progress: { type: "boolean", default: false },
    request: { type: "string" }, "decision-key": { type: "string" },
  } });
  const [action, path] = positionals;
  if (!["check", "start", "resume", "replay", "approve", "deny"].includes(action) || positionals.length > 2
    || action !== "check" && !path) throw new Error("configuration");
  if (action === "start" && (!values.account || !values.trigger)) throw new Error("configuration");
  if (["resume", "replay", "approve", "deny"].includes(action) && (values.account || values.trigger || values.channel || values.structured)) throw new Error("configuration");
  if (["approve", "deny"].includes(action) ? (!values.request || !values["decision-key"])
    : (values.request || values["decision-key"])) throw new Error("configuration");
  if (values.structured && action !== "start") throw new Error("configuration");
  const required = ["DEIXIC_API_KEY", "DEIXIC_ORGANIZATION_ID", "DEIXIC_WORKSPACE_ID"];
  const missing = required.filter(name => !process.env[name]?.trim());
  if (missing.length) {
    console.log(JSON.stringify({ status: "error", kind: "configuration", nextAction: "Missing configuration: " + missing.join(", ") }));
    return 1;
  }
  const client = createDeixicClient({ apiKey: process.env.DEIXIC_API_KEY,
    organizationId: process.env.DEIXIC_ORGANIZATION_ID, workspaceId: process.env.DEIXIC_WORKSPACE_ID,
    baseUrl: process.env.DEIXIC_BASE_URL,
  });
  if (action === "check") {
    const check = await client.tasks.checkSetup({ channelId: values.channel ?? "company" });
    console.log(JSON.stringify({ status: check.status, channelId: check.channelId,
      writeAccess: check.writeAccess, nextAction: check.nextAction,
      requirements: check.capabilities.map(item => ({ service: item.service,
        missingRequirements: item.missingRequirements,
        reasonCodes: item.missingRequirementStates.map(reason => reason.reasonCode) })),
      modelReady: check.selectedModel?.ready ?? null, errorKind: check.error?.kind,
      requestId: check.error?.requestId,
    }));
    return check.status === "accessible" ? 0 : 2;
  }
  let task;
  if (action === "start") {
    let creating = true;
    task = await client.tasks.prepare({ channelId: values.channel ?? "company",
      body: "Prepare an account brief for " + JSON.stringify(values.account) + ". "
        + "Use CRM data available in this workspace. Include the account summary, "
        + "open opportunities, risks and source references. State which data is missing. "
        + "Do not update records or send messages." + (values.structured ? FORMAT_INSTRUCTION : ""),
      idempotencyKey: values.trigger, onCheckpoint: async state => {
        await save(path, state, creating); creating = false;
      },
    });
    await task.submit();
  } else {
    task = client.tasks.resume(JSON.parse(await readFile(path, "utf8")), { onCheckpoint: state => save(path, state) });
    if (action === "replay") await task.replay();
    else if (["approve", "deny"].includes(action)) {
      const result = await task.result();
      const event = result.event;
      if (result.status !== "waiting" || !event || event.requestType !== OperatingThreadRequestType.APPROVAL
        || event.requestId !== values.request) {
        console.log(JSON.stringify({ status: "needs_attention", reason: "approval_request_not_current" }));
        return 2;
      }
      await client.controls.respond({ channelId: task.checkpoint().channelId, turnId: result.turnId,
        response: { requestId: event.requestId, callId: event.requestCallId, requestType: event.requestType,
          action: action === "approve" ? OperatingThreadResponseAction.APPROVE : OperatingThreadResponseAction.DENY },
        idempotencyKey: values["decision-key"],
      });
      console.log(JSON.stringify({ status: "decision_submitted", turnId: result.turnId,
        nextAction: "resume the checkpoint to observe the owner outcome" }));
      return 0;
    } else {
      const result = await task.wait({ timeoutMs: Number(values.timeout), onEvent: event => {
        if (values.progress) process.stderr.write(JSON.stringify({ eventId: event.eventId,
          turnId: event.turnId, kind: event.kind }) + "\n");
      } });
      const structured = task.checkpoint().body.includes(FORMAT_INSTRUCTION);
      let brief;
      if (result.status === "completed" && structured) {
        try {
          brief = parseTaskResult(result, parseAccountBrief);
          const name = task.checkpoint().body.slice("Prepare an account brief for ".length).match(/^"(?:\\.|[^"\\])*"/);
          if (!name || brief.accountName !== JSON.parse(name[0])) throw new Error("Account mismatch");
        }
        catch {
          console.log(JSON.stringify({ status: "invalid_result", remoteStatus: "completed", turnId: result.turnId,
            nextAction: "inspect the answer; do not resubmit this request" }));
          return 2;
        }
      }
      const receipts = result.status === "completed" ? result.receipts : [];
      const actions = receipts.map(item => ({ id: item.id, ownerService: item.ownerService,
        objectId: item.objectId, kind: item.kind, lifecycleState: item.lifecycleState,
        evidenceRefs: item.evidenceRefs.map(ref => ({ resourceType: ref.resourceType, id: ref.id })) }));
      const attention = receipts.some(item => ![ReceiptLifecycleState.SUCCEEDED, ReceiptLifecycleState.VERIFIED].includes(item.lifecycleState));
      console.log(JSON.stringify({ status: result.status, turnId: result.turnId,
        reason: result.reason, body: result.status === "completed" && !structured ? result.body : undefined,
        brief, receiptIds: receipts.map(item => item.id), actions,
        actionStatus: !actions.length ? "not_reported" : attention ? "requires_attention" : "owner_reported_success",
        requestId: result.event?.requestId, requestType: result.event?.requestType, errorCode: result.turn?.errorCode,
      }));
      return result.status === "completed" && !attention ? 0 : 2;
    }
  }
  console.log(JSON.stringify({ status: "accepted", turnId: task.checkpoint().turnId,
    nextAction: "resume this checkpoint to retrieve the account brief" }));
  return 0;
}

try { process.exitCode = await main(); }
catch (error) {
  console.log(JSON.stringify(error instanceof DeixicError
    ? { status: "error", kind: error.kind, code: error.code, requestId: error.requestId }
    : { status: "error", kind: "configuration", nextAction: "Check configuration and checkpoint storage; use --help" }));
  process.exitCode = 1;
}
