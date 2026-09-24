import { Code, ConnectError, type Transport } from "@connectrpc/connect";

import {
  createPublicClient,
  type PublicAuth,
  type PublicClient,
} from "./client.js";
import { PublicError } from "./errors.js";
import { TasksClient } from "./tasks.js";

/** Hosted Deixic API origin used when a client does not provide one. */
export const DEFAULT_DEIXIC_BASE_URL = "https://app.deixic.com";

/** Immutable tenant scope applied to every SDK request. */
export interface DeixicScope {
  organizationId: string;
  workspaceId: string;
}

/**
 * Public SDK configuration. API keys are intended for trusted server-side
 * applications. Browser applications should use a same-origin authenticated
 * backend or provide an identity-preserving OAuth credential source.
 */
export interface DeixicClientOptions {
  organizationId: string;
  workspaceId: string;
  baseUrl?: string;
  apiKey?: string;
  auth?: PublicAuth;
  fetch?: typeof globalThis.fetch;
  /** Test and server-adapter escape hatch. Product calls remain tenant-bound. */
  transport?: Transport;
}

/** The typed Deixic client returned by {@link createDeixicClient}. */
export interface DeixicClient extends Pick<PublicClient,
  "scope" | "threads" | "events" | "messages" | "controls" | "receipts"> {
  readonly tasks: TasksClient;
}

/**
 * Create a client for durable Deixic threads, events, messages, controls, and
 * governed receipt actions.
 *
 * The organization and workspace are fixed for the lifetime of the client.
 * Mutations require caller-owned idempotency keys, and an accepted response is
 * not treated as completed work.
 */
export function createDeixicClient(options: DeixicClientOptions): DeixicClient {
  const apiKey = options.apiKey?.trim();
  if (options.apiKey !== undefined && !apiKey) {
    throw validationError("apiKey must be non-empty when provided");
  }
  if (options.apiKey !== undefined && options.auth) {
    throw validationError('provide either "apiKey" or "auth", not both');
  }

  const auth: PublicAuth | undefined = apiKey
    ? { getCredential: () => ({ accessToken: apiKey, tokenType: "Bearer" }) }
    : options.auth;

  const baseUrl = checkedBaseUrl(options.baseUrl ?? DEFAULT_DEIXIC_BASE_URL);
  const client = createPublicClient({
    baseUrl,
    scope: {
      organizationId: options.organizationId,
      workspaceId: options.workspaceId,
    },
    auth,
    fetch: async (input, init) => {
      try {
        return await (options.fetch ?? globalThis.fetch)(input, init);
      } catch (error) {
        if (init?.signal?.aborted) throw error;
        // Connect otherwise maps a rejected native fetch to Unknown/protocol.
        // Classify only failures at the HTTP transport boundary; HTTP/protobuf
        // responses retain their original status and protocol classification.
        throw new ConnectError("Request transport failed", Code.Unavailable, undefined, undefined, error);
      }
    },
    transport: options.transport,
  });
  // Enumerate supported SDK facades explicitly.
  return {
    scope: client.scope,
    threads: client.threads,
    events: client.events,
    messages: client.messages,
    controls: client.controls,
    receipts: client.receipts,
    tasks: new TasksClient(client, baseUrl),
  };
}

export { Task, TasksClient, parseTaskResult } from "./tasks.js";
export type { PrepareTaskInput, SetupCheck, TaskCheckpoint, TaskResult, WaitTaskOptions } from "./tasks.js";

function checkedBaseUrl(value: string): string {
  const cleaned = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw validationError("baseUrl must be an absolute HTTP(S) URL");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw validationError("baseUrl must be an absolute HTTP(S) URL without credentials, a query, or a fragment");
  }
  return cleaned;
}

function validationError(message: string): PublicError {
  return new PublicError({ message, kind: "validation", status: 400 });
}

export {
  observePublicAcceptedTurn as observeAcceptedTurn,
} from "./accepted-turn.js";

export type {
  PublicAcceptedTurnAcceptance as AcceptedTurnAcceptance,
  PublicAcceptedTurnResult as AcceptedTurnResult,
  PublicAcceptedTurnUnfinishedReason as AcceptedTurnUnfinishedReason,
  PublicAcceptedTurnWatchOptions as AcceptedTurnWatchOptions,
  PublicObserveAcceptedTurnInput as ObserveAcceptedTurnInput,
} from "./accepted-turn.js";

export {
  DEIXIC_PUBLIC_APP_CONTEXT_HEADER as DEIXIC_APP_CONTEXT_HEADER,
  DEIXIC_PUBLIC_APP_CONTEXT_MAX_HEADER_CHARS as DEIXIC_APP_CONTEXT_MAX_HEADER_CHARS,
  encodePublicAppContextHeader as encodeDeixicAppContextHeader,
  encodedPublicAppContextHeaderLength as encodedDeixicAppContextHeaderLength,
} from "./app-context.js";

export {
  PublicError as DeixicError,
} from "./errors.js";

export type {
  PublicErrorKind as DeixicErrorKind,
} from "./errors.js";

export type {
  PublicGetReceiptInput as GetReceiptInput,
  PublicGetThreadInput as GetThreadInput,
  PublicInterruptThreadInput as InterruptThreadInput,
  PublicListThreadEventsInput as ListThreadEventsInput,
  PublicAuth as DeixicAuth,
  PublicCredential as DeixicCredential,
  PublicResolveReceiptInput as ResolveReceiptInput,
  PublicRespondToThreadInput as RespondToThreadInput,
  PublicSendMessageInput as SendMessageInput,
  PublicWatchThreadInput as WatchThreadInput,
} from "./client.js";

export {
  OperatingThreadRequestType,
  OperatingThreadResponseAction,
  OperatingThreadWaitingReason,
  OperatingTurnState,
  ReceiptLifecycleState,
} from "./protocol.js";
