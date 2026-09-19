import {
  clone,
  toBinary,
} from "@bufbuild/protobuf";
import {
  OperatingCapabilityStateSchema,
  OperatingModelSelectionSchema,
  InferenceProviderTargetSchema,
  OperatingMessageSchema,
  OperatingReceiptSchema,
  OperatingThreadEventSchema,
  OperatingThreadTurnSchema,
  OperatingTurnState,
  OperatingThreadWaitingReason,
  OperatingThreadRequestType,
  type OperatingCapabilityState,
  type OperatingModelSelection,
  type InferenceProviderTarget,
  type OperatingMessage,
  type OperatingReceipt,
  type OperatingThreadEvent,
  type OperatingThreadTurn,
  type ListOperatingThreadEventsResponse,
} from "../../../../gen/ts/console/v1/console_pb.js";
import type { MaestroProductClient } from "../../../maestro/typescript/src/client.js";
import { MaestroProductError } from "../../../maestro/typescript/src/errors.js";

const MAX_CURSOR = 9_223_372_036_854_775_807n;

/** JSON-safe request and observation coordinates; never authorization or completion. */
export interface TaskCheckpoint {
  schema: "deixic.task.v1";
  organizationId: string;
  workspaceId: string;
  baseUrl: string;
  channelId: string;
  body: string;
  idempotencyKey: string;
  projectResourceId: string;
  submission: "prepared" | "unacknowledged" | "accepted";
  turnId: string;
  sequence: string;
  cursor: string;
}

export interface PrepareTaskInput {
  channelId: string;
  body: string;
  idempotencyKey: string;
  projectResourceId?: string;
  /** Persist before mutation and after acceptance/progress. Storage failures propagate. */
  onCheckpoint?: (checkpoint: TaskCheckpoint) => void | Promise<void>;
}

interface TaskResultBase {
  turnId: string;
  reason?: string;
  turn?: OperatingThreadTurn;
  event?: OperatingThreadEvent;
}

export type TaskResult =
  | (TaskResultBase & {
    status: "completed";
    body: string;
    message: OperatingMessage;
    receipts: OperatingReceipt[];
  })
  | (TaskResultBase & { status: "prepared" | "unacknowledged" | "responded" | "failed" | "interrupted" })
  | (TaskResultBase & { status: "waiting"; reason?: string })
  | (TaskResultBase & { status: "unfinished"; reason?: string; error?: MaestroProductError });

export interface WaitTaskOptions {
  /** Observation budget in milliseconds. Expiry never interrupts remote work. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxPages?: number;
  maxReconnectAttempts?: number;
  onEvent?: (event: Readonly<OperatingThreadEvent>) => void | Promise<void>;
  /** Local cancellation only. Use controls.interrupt for an explicit remote mutation. */
  signal?: AbortSignal;
}

export interface SetupCheck {
  status: "accessible" | "needs_attention" | "error";
  channelId: string;
  capabilities: OperatingCapabilityState[];
  nextAction: string;
  error?: MaestroProductError;
  modelSelection?: OperatingModelSelection;
  defaultModel?: InferenceProviderTarget;
  selectedModel?: InferenceProviderTarget;
  writeAccess: "not_checked";
}

export class TasksClient {
  constructor(private readonly client: MaestroProductClient, private readonly baseUrl: string) {}

  async prepare(input: PrepareTaskInput): Promise<Task> {
    const task = new Task(this.client, {
      schema: "deixic.task.v1", ...this.client.scope, baseUrl: this.baseUrl,
      channelId: identity(input.channelId, "channelId"), body: body(input.body),
      idempotencyKey: identity(input.idempotencyKey, "idempotencyKey"),
      projectResourceId: input.projectResourceId === undefined || input.projectResourceId === ""
        ? "" : identity(input.projectResourceId, "projectResourceId"),
      submission: "prepared", turnId: "", sequence: "0", cursor: "0",
    }, input.onCheckpoint);
    await task.saveCheckpoint();
    return task;
  }

  async start(input: PrepareTaskInput): Promise<Task> {
    return (await this.prepare(input)).submit();
  }

  resume(checkpoint: TaskCheckpoint, options: Pick<PrepareTaskInput, "onCheckpoint"> = {}): Task {
    const fields = ["schema", "organizationId", "workspaceId", "baseUrl", "channelId", "body",
      "idempotencyKey", "projectResourceId", "submission", "turnId", "sequence", "cursor"];
    if (!checkpoint || typeof checkpoint !== "object"
      || Object.keys(checkpoint).sort().join(",") !== fields.sort().join(",")
      || checkpoint.schema !== "deixic.task.v1") throw validation("Invalid task checkpoint fields or schema");
    if (checkpoint.organizationId !== this.client.scope.organizationId
      || checkpoint.workspaceId !== this.client.scope.workspaceId
      || checkpoint.baseUrl !== this.baseUrl) throw validation("Checkpoint belongs to a different tenant or Platform URL");
    identity(checkpoint.channelId, "channelId");
    identity(checkpoint.idempotencyKey, "idempotencyKey");
    body(checkpoint.body);
    if (checkpoint.projectResourceId !== "") identity(checkpoint.projectResourceId, "projectResourceId");
    const sequence = decimal(checkpoint.sequence);
    const cursor = decimal(checkpoint.cursor);
    if (checkpoint.submission === "accepted") {
      identity(checkpoint.turnId, "turnId");
      if (sequence === 0n) throw validation("Accepted checkpoint requires a positive sequence");
    } else if (!["prepared", "unacknowledged"].includes(checkpoint.submission)
      || checkpoint.turnId !== "" || sequence !== 0n || cursor !== 0n) {
      throw validation("Invalid submission coordinates");
    }
    return new Task(this.client, { ...checkpoint }, options.onCheckpoint);
  }

  async checkSetup(input: { channelId: string; signal?: AbortSignal }): Promise<SetupCheck> {
    const channelId = identity(input.channelId, "channelId");
    try {
      const thread = await this.client.threads.get({ channelId, limit: 1, signal: input.signal });
      if (thread.channel?.id !== channelId) throw protocol("Setup lookup omitted or changed the channel identity");
      const capabilities = thread.capabilities.map(item => clone(OperatingCapabilityStateSchema, item));
      if (thread.channel.capabilityState) capabilities.push(clone(OperatingCapabilityStateSchema, thread.channel.capabilityState));
      const missing = capabilities.some(item => item.missingRequirements.length || item.missingRequirementStates.length);
      const selection = thread.modelSelection;
      const selected = selection && (selection.provider || selection.model)
        ? thread.availableModels.find(item => item.provider === selection.provider && item.model === selection.model)
        : thread.defaultModel;
      // Platform deliberately omits both the catalog and default target when
      // managed inference is unavailable. An explicit selection that no longer
      // appears in the catalog is unavailable for the same reason.
      const unavailableModel = selected === undefined || !selected.ready;
      return {
        status: missing || unavailableModel ? "needs_attention" : "accessible", channelId, capabilities, writeAccess: "not_checked",
        nextAction: missing ? "Resolve the reported workspace prerequisites" : unavailableModel
          ? "Check the reported model availability in workspace settings" : "Submit a task to check execution and write access",
        ...(thread.modelSelection ? { modelSelection: clone(OperatingModelSelectionSchema, thread.modelSelection) } : {}),
        ...(thread.defaultModel ? { defaultModel: clone(InferenceProviderTargetSchema, thread.defaultModel) } : {}),
        ...(selected ? { selectedModel: clone(InferenceProviderTargetSchema, selected) } : {}),
      };
    } catch (error) {
      if (!(error instanceof MaestroProductError)) throw error;
      const actions: Partial<Record<MaestroProductError["kind"], string>> = {
        authentication: "Replace or refresh the expired or invalid credential",
        authorization: "Check the credential's organization and workspace read grants",
        not_found: "Check the channel ID in this workspace",
      };
      const nextAction = actions[error.kind] ?? "Check API connectivity and share the request ID with support";
      return { status: "error", channelId, capabilities: [], writeAccess: "not_checked", nextAction, error };
    }
  }
}

/** One logical request and its non-authoritative recovery coordinates. Use one observer/storage writer. */
export class Task {
  private event?: OperatingThreadEvent;
  private submitting = false;
  private observing = false;
  private readonly state: TaskCheckpoint;

  constructor(private readonly client: MaestroProductClient, state: TaskCheckpoint,
    private readonly onCheckpoint?: PrepareTaskInput["onCheckpoint"]) {
    if (onCheckpoint !== undefined && typeof onCheckpoint !== "function") throw validation("onCheckpoint must be callable");
    this.state = { ...state };
  }

  checkpoint(): TaskCheckpoint { return { ...this.state }; }

  async saveCheckpoint(): Promise<void> { await this.onCheckpoint?.(this.checkpoint()); }

  async submit(): Promise<Task> { return this.send("prepared"); }

  /** Explicit same-request replay only when the acceptance response was not received. */
  async replay(): Promise<Task> { return this.send("unacknowledged"); }

  private async send(required: TaskCheckpoint["submission"]): Promise<Task> {
    if (this.submitting || this.state.submission !== required) {
      throw validation("Submission already attempted; resume or explicitly replay an unacknowledged request");
    }
    this.submitting = true;
    try {
      this.state.submission = "unacknowledged";
      await this.saveCheckpoint();
      const accepted = await this.client.messages.send({
        channelId: this.state.channelId, body: this.state.body, idempotencyKey: this.state.idempotencyKey,
        ...(this.state.projectResourceId ? { projectResourceId: this.state.projectResourceId } : {}),
      });
      const turn = accepted.acceptedTurn;
      if (!turn?.turnId.trim() || turn.turnId !== turn.turnId.trim() || turn.sequence <= 0n
        || turn.sequence > MAX_CURSOR || accepted.replayCursor < 0n || accepted.replayCursor > MAX_CURSOR) {
        throw protocol("Submission omitted valid accepted-turn coordinates");
      }
      Object.assign(this.state, { submission: "accepted", turnId: turn.turnId,
        sequence: turn.sequence.toString(), cursor: accepted.replayCursor.toString() });
      await this.saveCheckpoint();
      return this;
    } finally { this.submitting = false; }
  }

  async result(options: { maxPages?: number; signal?: AbortSignal } = {}): Promise<TaskResult> {
    const maxPages = pages(options.maxPages ?? 10);
    if (this.state.submission !== "accepted") return { status: this.state.submission, turnId: "",
      reason: this.state.submission === "prepared" ? "submit_required" : "explicit_replay_required" };
    const turnId = this.state.turnId;
    const sequence = BigInt(this.state.sequence);
    let turn: OperatingThreadTurn | undefined;
    const messages = new Map<string, OperatingMessage>();
    const seen = new Set<string>();
    let pageToken = "";
    let exhausted = true;
    for (let index = 0; index < maxPages; index += 1) {
      const page = await this.client.threads.get({ channelId: this.state.channelId,
        limit: 200, pageToken, signal: options.signal });
      if (page.channel?.id && page.channel.id !== this.state.channelId) throw protocol("Thread lookup changed the channel identity");
      const candidate = page.turns.find(item => item.turnId === turnId);
      if (candidate) {
        if (candidate.sequence !== sequence) throw protocol("Thread lookup changed the accepted turn sequence");
        turn ??= clone(OperatingThreadTurnSchema, candidate);
      }
      for (const item of page.messages) if (!messages.has(item.id)) messages.set(item.id, item);
      if (turn && (turn.state !== OperatingTurnState.COMPLETED || !turn.assistantMessageId || messages.has(turn.assistantMessageId))) {
        exhausted = false;
        break;
      }
      if (!page.nextPageToken) { exhausted = false; break; }
      if (seen.has(page.nextPageToken)) throw protocol("Thread pagination repeated a page token");
      seen.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    }
    if (exhausted) return { status: "unfinished", turnId, reason: "result_page_limit" };
    if (!turn) return { status: "unfinished", turnId, reason: "turn_not_visible" };
    const base: TaskResultBase = { turnId, turn,
      ...(this.event ? { event: clone(OperatingThreadEventSchema, this.event) } : {}) };
    switch (turn.state) {
      case OperatingTurnState.RESPONDED: return { ...base, status: "responded" };
      case OperatingTurnState.FAILED: return { ...base, status: "failed" };
      case OperatingTurnState.INTERRUPTED: return { ...base, status: "interrupted" };
      case OperatingTurnState.WAITING: {
        const event = await this.waitingRequest(turn, maxPages, options.signal);
        return { ...base, status: "waiting", event, ...(event ? {} : { reason: "request_not_visible" }) };
      }
      case OperatingTurnState.COMPLETED: break;
      default: return { ...base, status: "unfinished" };
    }
    const message = messages.get(turn.assistantMessageId);
    if (!message || message.role !== "assistant" || message.channelId !== this.state.channelId) {
      throw protocol("Completed turn omitted its linked final assistant message");
    }
    const receipts: OperatingReceipt[] = [];
    for (const receiptId of new Set(message.receiptIds)) {
      const receipt = (await this.client.receipts.get({ channelId: this.state.channelId,
        receiptId, signal: options.signal })).receipt;
      if (!receipt || receipt.id !== receiptId) throw protocol("Receipt lookup changed the receipt identity");
      receipts.push(clone(OperatingReceiptSchema, receipt));
    }
    return { ...base, status: "completed", body: message.body,
      message: clone(OperatingMessageSchema, message), receipts };
  }

  private async waitingRequest(turn: OperatingThreadTurn, maxPages: number, signal?: AbortSignal): Promise<OperatingThreadEvent | undefined> {
    // Recover request identity from owner history rather than a cached checkpoint.
    let cursor = turn.firstCursor > 0n ? turn.firstCursor - 1n : 0n;
    let request: OperatingThreadEvent | undefined;
    for (let index = 0; index < maxPages; index += 1) {
      const page = await this.client.events.list({ channelId: this.state.channelId, afterCursor: cursor, signal });
      if (page.resetRequired) return undefined;
      validatePage(page, cursor);
      const events = [...page.events].sort((a, b) => a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0);
      for (const event of events) {
        if (event.turnId === turn.turnId && event.cursor > cursor && event.requestId) request = clone(OperatingThreadEventSchema, event);
      }
      cursor = page.nextCursor;
      if (!page.hasMore) {
        const types: Partial<Record<OperatingThreadWaitingReason, OperatingThreadRequestType>> = {
          [OperatingThreadWaitingReason.APPROVAL]: OperatingThreadRequestType.APPROVAL,
          [OperatingThreadWaitingReason.USER_INPUT]: OperatingThreadRequestType.USER_INPUT,
          [OperatingThreadWaitingReason.CLIENT_TOOL]: OperatingThreadRequestType.CLIENT_TOOL,
          [OperatingThreadWaitingReason.EXTERNAL_RETRY]: OperatingThreadRequestType.EXTERNAL_RETRY,
        };
        const expected = types[turn.waitingReason];
        return request?.requestType === expected ? request : undefined;
      }
    }
    return undefined;
  }

  private async backfill(maxPages: number, signal: AbortSignal, onEvent?: WaitTaskOptions["onEvent"]): Promise<boolean> {
    for (let index = 0; index < maxPages; index += 1) {
      const cursor = BigInt(this.state.cursor);
      const page = await this.client.events.list({ channelId: this.state.channelId, afterCursor: cursor, signal });
      if (page.resetRequired) {
        if (!page.threadExecution || page.threadExecution.replayCursor < cursor) {
          throw protocol("Retention reset omitted a valid owner execution cursor");
        }
        this.event = undefined;
        this.state.cursor = page.threadExecution.replayCursor.toString();
        await applicationCall(() => this.saveCheckpoint());
        return true;
      }
      validatePage(page, cursor);
      const seen = new Set<bigint>();
      const events = [...page.events].sort((a, b) => a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0);
      for (const event of events) {
        if (event.turnId !== this.state.turnId || event.cursor <= cursor || seen.has(event.cursor)) continue;
        seen.add(event.cursor);
        await applicationCall(() => onEvent?.(Object.freeze(clone(OperatingThreadEventSchema, event))));
        this.event = clone(OperatingThreadEventSchema, event);
      }
      this.state.cursor = page.nextCursor.toString();
      await applicationCall(() => this.saveCheckpoint());
      if (!page.hasMore) return true;
    }
    return false;
  }

  async wait(options: WaitTaskOptions = {}): Promise<TaskResult> {
    const timeoutMs = positive(options.timeoutMs ?? 60_000, "timeoutMs");
    const interval = positive(options.pollIntervalMs ?? 1_000, "pollIntervalMs");
    const maxPages = pages(options.maxPages ?? 10);
    const maxReconnects = options.maxReconnectAttempts ?? 3;
    if (!Number.isInteger(maxReconnects) || maxReconnects < 0 || maxReconnects > 100) throw validation("maxReconnectAttempts must be between 0 and 100");
    if (options.onEvent !== undefined && typeof options.onEvent !== "function") throw validation("onEvent must be callable");
    if (this.observing) throw validation("This task already has an active observer");
    if (this.state.submission !== "accepted") return this.result();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const timer = setTimeout(cancel, timeoutMs);
    this.observing = true;
    let reconnects = 0;
    try {
      while (!controller.signal.aborted) {
        try {
          const caughtUp = await this.backfill(maxPages, controller.signal, options.onEvent);
          const outcome = await this.result({ maxPages, signal: controller.signal });
          if (controller.signal.aborted) break;
          if (outcome.status !== "unfinished" && outcome.status !== "responded") return outcome;
          if (!caughtUp) return { status: "unfinished", turnId: this.state.turnId, reason: "backfill_limit" };
          reconnects = 0;
        } catch (error) {
          if (error instanceof ApplicationCallbackError) throw error.original;
          if (controller.signal.aborted) break;
          if (!(error instanceof MaestroProductError) || !["transport", "unavailable"].includes(error.kind)) throw error;
          if (reconnects >= maxReconnects) return { status: "unfinished", turnId: this.state.turnId, reason: "observation_error", error };
          reconnects += 1;
        }
        await pause(Math.min(interval * 2**reconnects, 5_000) * (0.8 + Math.random() * 0.4), controller.signal);
      }
      return { status: "unfinished", turnId: this.state.turnId,
        reason: options.signal?.aborted ? "cancelled" : "deadline" };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      this.observing = false;
    }
  }
}

function validatePage(page: ListOperatingThreadEventsResponse, cursor: bigint): void {
  const expected = page.events.reduce((highest, event) => event.cursor > highest ? event.cursor : highest, cursor);
  if (page.nextCursor !== expected || page.hasMore && expected <= cursor) throw protocol("Event pagination returned an invalid watermark");
  const records = new Map<bigint, string>();
  for (const event of page.events) {
    if (event.cursor <= 0n) throw protocol("Event cursor must be positive");
    const encoded = toBinary(OperatingThreadEventSchema, event).join(",");
    if (records.has(event.cursor) && records.get(event.cursor) !== encoded) throw protocol("Different events reused the same cursor");
    records.set(event.cursor, encoded);
  }
}

class ApplicationCallbackError extends Error {
  constructor(readonly original: unknown) { super("Application callback failed"); }
}
async function applicationCall(callback: () => unknown): Promise<void> {
  try { await callback(); } catch (error) { throw new ApplicationCallbackError(error); }
}
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}
function identity(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) throw validation(`${name} must be a non-empty string without surrounding whitespace`);
  return value;
}
function body(value: string): string {
  if (typeof value !== "string" || !value.trim() || [...value].length > 20_000) throw validation("body must contain between 1 and 20000 characters");
  return value;
}
function decimal(value: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > MAX_CURSOR) {
    throw validation("Checkpoint cursor and sequence must be canonical int64 decimal strings");
  }
  return BigInt(value);
}
function pages(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 50) throw validation("maxPages must be between 1 and 50");
  return value;
}
function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) throw validation(`${name} must be positive, finite, and within the supported timer range`);
  return value;
}
function validation(message: string): MaestroProductError { return new MaestroProductError({ message, kind: "validation", status: 400 }); }
function protocol(message: string): MaestroProductError { return new MaestroProductError({ message, kind: "protocol" }); }

/** Apply an application's schema/parser to a completed answer; parser failures propagate. */
export function parseTaskResult<T>(result: TaskResult, parser: (body: string) => T): T {
  if (result.status !== "completed") throw validation("Only a completed task has a final answer to parse");
  return parser(result.body);
}
