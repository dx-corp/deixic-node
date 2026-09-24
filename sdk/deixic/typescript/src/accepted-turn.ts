import { clone } from "@bufbuild/protobuf";
import {
  OperatingThreadEventKind,
  OperatingThreadEventSchema,
  type OperatingThreadExecution,
  OperatingThreadTurnSchema,
  OperatingTurnState,
  type OperatingThreadEvent,
  type OperatingThreadTurn,
  type SubmitOperatingMessageResponse,
} from "./protocol.js";

import type { PublicClient } from "./client.js";
import { PublicError, asPublicError } from "./errors.js";

const DEFAULT_MAX_BACKFILL_PAGES = 10;
const MAX_BACKFILL_PAGES = 50;
const MAX_WATCH_PAGES = 100;
const MAX_OPERATING_CURSOR = 9_223_372_036_854_775_807n;

/**
 * Stable acceptance coordinates for one Platform-owned turn. A prior result
 * supplies this shape when a caller resumes observation from its cursor.
 */
export interface PublicAcceptedTurnAcceptance {
  acceptedTurn?: OperatingThreadTurn;
  replayCursor: bigint;
}

/** One caller-bounded WatchOperatingThread segment. */
export interface PublicAcceptedTurnWatchOptions {
  /** Number of stream pages to process before observation returns unfinished. */
  maxPages: number;
}

export interface PublicObserveAcceptedTurnInput {
  channelId: string;
  /**
   * A SubmitOperatingMessage response or a prior result's acceptedTurn and
   * replayCursor. It identifies the accepted owner turn without resending it.
   */
  acceptance: PublicAcceptedTurnAcceptance
    | Pick<SubmitOperatingMessageResponse, "acceptedTurn" | "replayCursor">;
  /** Maximum ListOperatingThreadEvents pages before observation stops. */
  maxBackfillPages?: number;
  /** Optional one-shot watch. Reconnect policy remains with the caller. */
  watch?: PublicAcceptedTurnWatchOptions;
  /** Receives each new exact-turn event in cursor order. */
  onEvent?: (event: Readonly<OperatingThreadEvent>) => void | Promise<void>;
  /** Stops observation only; this helper never interrupts or resends a turn. */
  signal?: AbortSignal;
}

interface PublicAcceptedTurnResultBase {
  /** Detached identity snapshot for a later observation call. */
  acceptedTurn: OperatingThreadTurn;
  /** Last fully processed durable event cursor, preserved as bigint. */
  replayCursor: bigint;
  /** Detached matching owner snapshot, when Platform supplied one. */
  turn?: OperatingThreadTurn;
  /** Detached matching event that established the returned state. */
  event?: OperatingThreadEvent;
}

export type PublicAcceptedTurnUnfinishedReason =
  | "backfill_limit"
  | "backfill_error"
  | "watch_not_requested"
  | "watch_eof"
  | "watch_page_limit"
  | "watch_error"
  | "reset_required"
  | "reset_missing_turn"
  | "cancelled";

/**
 * Result for a single accepted durable turn. `responded` remains separate
 * from `completed` because Platform exposes those owner states separately.
 */
export type PublicAcceptedTurnResult =
  | (PublicAcceptedTurnResultBase & { status: "responded" })
  | (PublicAcceptedTurnResultBase & { status: "completed" })
  | (PublicAcceptedTurnResultBase & { status: "failed" })
  | (PublicAcceptedTurnResultBase & { status: "interrupted" })
  | (PublicAcceptedTurnResultBase & { status: "waiting" })
  | (PublicAcceptedTurnResultBase & {
    status: "unfinished";
    reason: PublicAcceptedTurnUnfinishedReason;
    error?: PublicError;
  });

/**
 * Observe one already-accepted Platform turn through the durable event API.
 * The helper uses only the tenant scope already fixed on `client`.
 */
export async function observePublicAcceptedTurn(
  client: PublicClient,
  input: PublicObserveAcceptedTurnInput,
): Promise<PublicAcceptedTurnResult> {
  const signal = input.signal;
  const channelId = requiredString(input.channelId, "channelId");
  const acceptance = input.acceptance;
  if (!acceptance || typeof acceptance !== "object") {
    throw validationError("acceptance is required");
  }
  const sourceTurn = acceptance.acceptedTurn;
  if (!sourceTurn) throw validationError("acceptance.acceptedTurn is required");

  const acceptedTurn = clone(OperatingThreadTurnSchema, sourceTurn);
  const turnId = requiredString(acceptedTurn.turnId, "acceptance.acceptedTurn.turnId");
  if (acceptedTurn.turnId !== turnId) {
    throw validationError("acceptance.acceptedTurn.turnId must not have surrounding whitespace");
  }
  const sequence = inputCursor(acceptedTurn.sequence, "acceptance.acceptedTurn.sequence", true);
  inputCursor(
    acceptedTurn.lastCursor,
    "acceptance.acceptedTurn.lastCursor",
  );
  // This is the caller's consumed watermark. A newer turn snapshot cannot
  // advance it, because doing so would skip unseen event history on resume.
  let replayCursor = inputCursor(acceptance.replayCursor, "acceptance.replayCursor");
  const maxBackfillPages = boundedPageCount(
    input.maxBackfillPages,
    DEFAULT_MAX_BACKFILL_PAGES,
    MAX_BACKFILL_PAGES,
    "maxBackfillPages",
  );
  const maxWatchPages = input.watch === undefined
    ? undefined
    : boundedPageCount(input.watch.maxPages, undefined, MAX_WATCH_PAGES, "watch.maxPages");
  const onEvent = input.onEvent;
  if (onEvent !== undefined && typeof onEvent !== "function") {
    throw validationError("onEvent must be a function");
  }

  let latestTurn: OperatingThreadTurn | undefined;
  let latestEvent: OperatingThreadEvent | undefined;
  const seenEventIds = new Map<string, bigint>();
  const seenEventCursors = new Map<bigint, string>();

  const base = (): PublicAcceptedTurnResultBase => ({
    acceptedTurn: clone(OperatingThreadTurnSchema, acceptedTurn),
    replayCursor,
    ...(latestTurn ? { turn: clone(OperatingThreadTurnSchema, latestTurn) } : {}),
    ...(latestEvent ? { event: clone(OperatingThreadEventSchema, latestEvent) } : {}),
  });
  const unfinished = (
    reason: PublicAcceptedTurnUnfinishedReason,
    error?: PublicError,
  ): PublicAcceptedTurnResult => ({
    ...base(),
    status: "unfinished",
    reason,
    ...(error ? { error } : {}),
  });
  const cancelled = (): PublicAcceptedTurnResult => unfinished("cancelled");

  if (signal?.aborted) return cancelled();

  // A detached terminal owner snapshot is terminal proof for this exact turn.
  // WAITING always backfills so the matching event retains its request
  // identity for the caller.
  const acceptedOutcome = outcomeForTurn(acceptedTurn);
  if (acceptedOutcome && acceptedOutcome !== "waiting") {
    latestTurn = clone(OperatingThreadTurnSchema, acceptedTurn);
    return { ...base(), status: acceptedOutcome };
  }
  const processPage = async (page: ObservationPage): Promise<PublicAcceptedTurnResult | undefined> => {
    const pageStartCursor = replayCursor;
    const nextCursor = responseCursor(page.nextCursor, "response.nextCursor");
    if (nextCursor < pageStartCursor) {
      throw protocolError("response.nextCursor regressed from the current replay cursor");
    }
    if (signal?.aborted) return cancelled();

    if (page.resetRequired) {
      // A reset snapshot is authoritative. Do not apply the page's event list
      // or use page.nextCursor or a turn snapshot as the replacement cursor.
      latestEvent = undefined;
      latestTurn = undefined;
      seenEventIds.clear();
      seenEventCursors.clear();
      if (!page.snapshot) {
        throw protocolError("response.threadExecution is required when resetRequired is true");
      }
      const resetCursor = responseCursor(
        page.snapshot.replayCursor,
        "response.threadExecution.replayCursor",
      );
      if (resetCursor < pageStartCursor) {
        throw protocolError("response.threadExecution.replayCursor regressed from the current replay cursor");
      }
      // A reset cursor comes from the authoritative owner execution record,
      // not from a turn snapshot. It replaces the caller's old history.
      replayCursor = resetCursor;
      const snapshotTurn = page.snapshotTurns.find((candidate) => (
        candidate.turnId === turnId && candidate.sequence === sequence
      ));
      if (!snapshotTurn) return unfinished("reset_missing_turn");
      const copiedTurn = clone(OperatingThreadTurnSchema, snapshotTurn);
      responseCursor(copiedTurn.lastCursor, "response.snapshotTurns.lastCursor");
      latestTurn = copiedTurn;
      const snapshotOutcome = outcomeForTurn(copiedTurn);
      if (snapshotOutcome) return { ...base(), status: snapshotOutcome };
      return unfinished("reset_required");
    }

    const records = page.events.map((source, index) => {
      const event = clone(OperatingThreadEventSchema, source);
      const cursor = responseCursor(event.cursor, "response.events.cursor", true);
      return { cursor, event, identity: eventIdentity(event, cursor), index };
    });
    // Owner list/watch set next_cursor to the last returned event, or the
    // request after_cursor when the page is empty. A higher cursor would skip
    // undelivered events on the next afterCursor read.
    const expectedNextCursor = records.reduce(
      (highest, record) => record.cursor > highest ? record.cursor : highest,
      pageStartCursor,
    );
    if (nextCursor !== expectedNextCursor) {
      throw protocolError("response.nextCursor did not match the page event watermark");
    }

    const pageCursorIdentities = new Map<bigint, string>();
    for (const record of records) {
      const existing = pageCursorIdentities.get(record.cursor);
      if (existing !== undefined && existing !== record.identity) {
        throw protocolError("response.events contained different events at the same cursor");
      }
      pageCursorIdentities.set(record.cursor, record.identity);
    }

    const matchingEvents = records
      .filter((record) => record.event.turnId === turnId)
      .sort((left, right) => (
        left.cursor === right.cursor ? left.index - right.index : left.cursor < right.cursor ? -1 : 1
      ));
    let latestTerminalEvent: OperatingThreadEvent | undefined;
    let latestWaitingEvent: OperatingThreadEvent | undefined;
    let waiting = false;

    for (const record of matchingEvents) {
      if (record.cursor <= pageStartCursor) continue;

      const eventId = record.event.id.trim();
      const previousAtCursor = seenEventCursors.get(record.cursor);
      if (previousAtCursor !== undefined) {
        if (previousAtCursor !== record.identity) {
          throw protocolError("response.events reused a cursor for different accepted-turn events");
        }
        continue;
      }
      if (eventId) {
        const previousCursor = seenEventIds.get(eventId);
        if (previousCursor !== undefined) {
          if (previousCursor !== record.cursor) {
            throw protocolError("response.events reused an eventId at a different cursor");
          }
          continue;
        }
        seenEventIds.set(eventId, record.cursor);
      }
      seenEventCursors.set(record.cursor, record.identity);

      // Classify from this private clone before invoking application code. The
      // callback receives another detached object and cannot forge a result.
      latestEvent = record.event;
      const terminal = terminalOutcomeForEvent(record.event);
      if (terminal) {
        latestTerminalEvent = record.event;
        latestWaitingEvent = undefined;
        waiting = false;
      } else if (!latestTerminalEvent) {
        if (isWaitingEvent(record.event)) {
          latestWaitingEvent = record.event;
          waiting = true;
        } else if (clearsWaitingEvent(record.event)) {
          latestWaitingEvent = undefined;
          waiting = false;
        }
      }
      try {
        await onEvent?.(Object.freeze(clone(OperatingThreadEventSchema, record.event)));
      } catch (error) {
        throw new ObservationCallbackError(error);
      }
      if (signal?.aborted) return cancelled();
    }

    replayCursor = nextCursor;
    if (latestTerminalEvent) {
      latestEvent = latestTerminalEvent;
      const terminalOutcome = terminalOutcomeForEvent(latestTerminalEvent);
      if (!terminalOutcome) throw protocolError("accepted-turn terminal event had no terminal outcome");
      return { ...base(), status: terminalOutcome };
    }
    if (waiting && latestWaitingEvent) {
      latestEvent = latestWaitingEvent;
      return { ...base(), status: "waiting" };
    }
    return undefined;
  };

  let hasMore = true;
  for (let pageNumber = 0; pageNumber < maxBackfillPages && hasMore; pageNumber += 1) {
    if (signal?.aborted) return cancelled();
    try {
      const page = await client.events.list({ channelId, afterCursor: replayCursor, signal });
      const result = await processPage(page);
      if (result) return result;
      hasMore = page.hasMore;
    } catch (error) {
      if (signal?.aborted) return cancelled();
      rethrowObservationError(error);
      return unfinished("backfill_error", asPublicError(error));
    }
  }

  if (hasMore) return unfinished("backfill_limit");
  if (maxWatchPages === undefined) return unfinished("watch_not_requested");
  if (signal?.aborted) return cancelled();

  let pageCount = 0;
  try {
    for await (const page of client.events.watch({ channelId, afterCursor: replayCursor, signal })) {
      if (signal?.aborted) return cancelled();
      const result = await processPage(page);
      if (result) return result;
      pageCount += 1;
      if (pageCount >= maxWatchPages) return unfinished("watch_page_limit");
    }
  } catch (error) {
    if (signal?.aborted) return cancelled();
    rethrowObservationError(error);
    return unfinished("watch_error", asPublicError(error));
  }

  return unfinished("watch_eof");
}

type ObservationPage = {
  events: readonly OperatingThreadEvent[];
  nextCursor: bigint;
  resetRequired: boolean;
  snapshot?: OperatingThreadExecution;
  snapshotTurns: readonly OperatingThreadTurn[];
};

type TerminalOutcome = "responded" | "completed" | "failed" | "interrupted";

function outcomeForTurn(turn: OperatingThreadTurn): TerminalOutcome | "waiting" | undefined {
  switch (turn.state) {
    case OperatingTurnState.RESPONDED:
      return "responded";
    case OperatingTurnState.COMPLETED:
      return "completed";
    case OperatingTurnState.FAILED:
      return "failed";
    case OperatingTurnState.INTERRUPTED:
      return "interrupted";
    case OperatingTurnState.WAITING:
      return "waiting";
    default:
      return undefined;
  }
}

function terminalOutcomeForEvent(event: OperatingThreadEvent | undefined): TerminalOutcome | undefined {
  switch (event?.kind) {
    case OperatingThreadEventKind.TURN_COMPLETED:
      return "completed";
    case OperatingThreadEventKind.TURN_FAILED:
      return "failed";
    case OperatingThreadEventKind.TURN_INTERRUPTED:
      return "interrupted";
    default:
      return undefined;
  }
}

function isWaitingEvent(event: OperatingThreadEvent): boolean {
  return event.kind === OperatingThreadEventKind.APPROVAL_REQUIRED
    || event.kind === OperatingThreadEventKind.INPUT_REQUIRED
    || event.kind === OperatingThreadEventKind.CLIENT_TOOL_REQUIRED
    || event.kind === OperatingThreadEventKind.EXTERNAL_RETRY_REQUIRED;
}

function clearsWaitingEvent(event: OperatingThreadEvent): boolean {
  return event.kind === OperatingThreadEventKind.TURN_ACCEPTED
    || event.kind === OperatingThreadEventKind.TURN_STARTED;
}

function eventIdentity(event: OperatingThreadEvent, cursor: bigint): string {
  const eventId = event.id.trim();
  if (eventId) return `id:${eventId}`;
  return [
    "fallback",
    cursor.toString(10),
    event.turnId,
    String(event.kind),
    event.requestId,
    event.callId,
  ].join("\u0000");
}

function boundedPageCount(
  value: number | undefined,
  defaultValue: number | undefined,
  maxValue: number,
  field: string,
): number {
  const resolved = value ?? defaultValue;
  if (resolved === undefined || !Number.isInteger(resolved) || resolved < 1 || resolved > maxValue) {
    throw validationError(`${field} must be an integer from 1 to ${maxValue}`);
  }
  return resolved;
}

function requiredString(value: string, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw validationError(`${field} is required`);
  return normalized;
}

function inputCursor(value: bigint, field: string, positive = false): bigint {
  if (typeof value !== "bigint" || value < (positive ? 1n : 0n) || value > MAX_OPERATING_CURSOR) {
    throw validationError(`${field} must be a ${positive ? "positive" : "non-negative"} int64 bigint`);
  }
  return value;
}

function responseCursor(value: bigint, field: string, positive = false): bigint {
  if (typeof value !== "bigint" || value < (positive ? 1n : 0n) || value > MAX_OPERATING_CURSOR) {
    throw protocolError(`${field} must be a ${positive ? "positive" : "non-negative"} int64 bigint`);
  }
  return value;
}

function validationError(message: string): PublicError {
  return new PublicError({ message, kind: "validation", status: 400 });
}

function protocolError(message: string): ObservationProtocolError {
  return new ObservationProtocolError(new PublicError({
    message,
    kind: "protocol",
    status: 502,
  }));
}

function rethrowObservationError(error: unknown): void {
  if (error instanceof ObservationProtocolError) throw error.productError;
  if (error instanceof ObservationCallbackError) throw error.callbackError;
}

class ObservationProtocolError extends Error {
  constructor(readonly productError: PublicError) {
    super(productError.message, { cause: productError });
    this.name = "ObservationProtocolError";
  }
}

class ObservationCallbackError extends Error {
  constructor(readonly callbackError: unknown) {
    super("accepted-turn observation callback failed", { cause: callbackError });
    this.name = "ObservationCallbackError";
  }
}
