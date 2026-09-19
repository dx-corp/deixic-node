import { Code, ConnectError, type Transport } from "@connectrpc/connect";

import {
  createMaestroProductClient,
  type MaestroProductAuth,
  type MaestroProductClient,
} from "../../../maestro/typescript/src/client.js";
import { MaestroProductError } from "../../../maestro/typescript/src/errors.js";
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
  auth?: MaestroProductAuth;
  fetch?: typeof globalThis.fetch;
  /** Test and server-adapter escape hatch. Product calls remain tenant-bound. */
  transport?: Transport;
}

/** The typed Deixic client returned by {@link createDeixicClient}. */
export interface DeixicClient extends MaestroProductClient {
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

  const auth: MaestroProductAuth | undefined = apiKey
    ? { getCredential: () => ({ accessToken: apiKey, tokenType: "Bearer" }) }
    : options.auth;

  const baseUrl = checkedBaseUrl(options.baseUrl ?? DEFAULT_DEIXIC_BASE_URL);
  const client = createMaestroProductClient({
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
  return Object.assign(client, { tasks: new TasksClient(client, baseUrl) });
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

function validationError(message: string): MaestroProductError {
  return new MaestroProductError({ message, kind: "validation", status: 400 });
}

export {
  observeMaestroAcceptedTurn as observeAcceptedTurn,
} from "../../../maestro/typescript/src/accepted-turn.js";

export type {
  MaestroAcceptedTurnAcceptance as AcceptedTurnAcceptance,
  MaestroAcceptedTurnResult as AcceptedTurnResult,
  MaestroAcceptedTurnUnfinishedReason as AcceptedTurnUnfinishedReason,
  MaestroAcceptedTurnWatchOptions as AcceptedTurnWatchOptions,
  MaestroObserveAcceptedTurnInput as ObserveAcceptedTurnInput,
} from "../../../maestro/typescript/src/accepted-turn.js";

export {
  MAESTRO_PRODUCT_APP_CONTEXT_HEADER as DEIXIC_APP_CONTEXT_HEADER,
  MAESTRO_PRODUCT_APP_CONTEXT_MAX_HEADER_CHARS as DEIXIC_APP_CONTEXT_MAX_HEADER_CHARS,
  encodeMaestroProductAppContextHeader as encodeDeixicAppContextHeader,
  encodedMaestroProductAppContextHeaderLength as encodedDeixicAppContextHeaderLength,
} from "../../../maestro/typescript/src/app-context.js";

export {
  MaestroProductError as DeixicError,
} from "../../../maestro/typescript/src/errors.js";

export type {
  MaestroProductErrorKind as DeixicErrorKind,
} from "../../../maestro/typescript/src/errors.js";

export type {
  MaestroGetReceiptInput as GetReceiptInput,
  MaestroGetThreadInput as GetThreadInput,
  MaestroInterruptThreadInput as InterruptThreadInput,
  MaestroListThreadEventsInput as ListThreadEventsInput,
  MaestroProductAuth as DeixicAuth,
  MaestroProductCredential as DeixicCredential,
  MaestroResolveReceiptInput as ResolveReceiptInput,
  MaestroRespondToThreadInput as RespondToThreadInput,
  MaestroSendMessageInput as SendMessageInput,
  MaestroWatchThreadInput as WatchThreadInput,
} from "../../../maestro/typescript/src/client.js";

export {
  OperatingThreadRequestType,
  OperatingThreadResponseAction,
  OperatingThreadWaitingReason,
  OperatingTurnState,
  ReceiptLifecycleState,
} from "../../../../gen/ts/console/v1/console_pb.js";

export type {
  GetOperatingReceiptResponse,
  GetOperatingThreadResponse,
  InterruptOperatingThreadResponse,
  ListOperatingThreadEventsResponse,
  OperatingAttachmentRef,
  OperatingCapabilityState,
  OperatingChannel,
  OperatingModelSelection,
  OperatingReceipt,
  OperatingReceiptAction,
  OperatingThreadEvent,
  OperatingThreadExecution,
  OperatingThreadResponse,
  OperatingThreadTurn,
  ResolveOperatingReceiptActionResponse,
  RespondOperatingThreadResponse,
  SubmitOperatingMessageResponse,
  WatchOperatingThreadResponse,
} from "../../../../gen/ts/console/v1/console_pb.js";
