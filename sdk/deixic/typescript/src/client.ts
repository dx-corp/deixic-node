import {
  clone,
  create,
  type DescMessage,
  type MessageInitShape,
  type MessageShape,
} from "@bufbuild/protobuf";
import { createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import {
  CodingAcceptanceContractSchema,
  ConsoleQuerySchema,
  GetOperatingReceiptRequestSchema,
  GetOperatingReceiptResponseSchema,
  GetOperatingThreadRequestSchema,
  GetOperatingThreadResponseSchema,
  InterruptOperatingThreadRequestSchema,
  InterruptOperatingThreadResponseSchema,
  ListOperatingThreadEventsRequestSchema,
  ListOperatingThreadEventsResponseSchema,
  OperatingModelSelectionSchema,
  OperatingReceiptActionSchema,
  OperatingThreadResponseSchema,
  ResolveOperatingReceiptActionRequestSchema,
  ResolveOperatingReceiptActionResponseSchema,
  RespondOperatingThreadRequestSchema,
  RespondOperatingThreadResponseSchema,
  SubmitOperatingMessageRequestSchema,
  SubmitOperatingMessageResponseSchema,
  WatchOperatingThreadRequestSchema,
  WatchOperatingThreadResponseSchema,
  type GetOperatingReceiptResponse,
  type GetOperatingThreadResponse,
  type InterruptOperatingThreadResponse,
  type ListOperatingThreadEventsResponse,
  type OperatingReceiptAction,
  type ResolveOperatingReceiptActionResponse,
  type RespondOperatingThreadResponse,
  type SubmitOperatingMessageResponse,
  type WatchOperatingThreadResponse,
} from "./protocol.js";
import { DeixicPublicService as DeixicService } from "./protocol.js";

import {
  DEIXIC_PUBLIC_APP_CONTEXT_HEADER,
  encodePublicAppContextHeader,
} from "./app-context.js";
import {
  INTERNAL_DEIXIC_PUBLIC_HTTP_STATUS_HEADER,
  PublicError,
  asPublicError,
  isUnauthenticated,
} from "./errors.js";

const DEFAULT_THREAD_LIMIT = 100;
const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 200;
const MAX_OPERATING_CURSOR = 9_223_372_036_854_775_807n;
const MAX_INT32 = 2_147_483_647;

/** The immutable tenant boundary used for every public SDK call. */
export interface PublicScope {
  organizationId: string;
  workspaceId: string;
}

/**
 * Credential metadata is optional so a same-origin BFF can rely on its cookie
 * session. If supplied, declared tenant or subject metadata is checked before
 * every request and cannot change during a refresh.
 */
export interface PublicCredential {
  accessToken?: string;
  tokenType?: string;
  subject?: string;
  organizationId?: string;
  workspaceId?: string;
  scopes?: string | readonly string[];
}

export interface PublicAuth {
  getCredential?: () => MaybePromise<PublicCredential | null | undefined>;
  refreshCredential?: (
    current: PublicCredential | null,
  ) => MaybePromise<PublicCredential | null | undefined>;
  /**
   * Required for a 401 replay when credentials do not carry a stable subject.
   * The callback must compare trusted session identity, not only tenant scope.
   */
  verifyRefreshIdentity?: (
    current: PublicCredential,
    refreshed: PublicCredential,
  ) => MaybePromise<boolean>;
}

export interface PublicClientOptions {
  /** Platform API base URL. Empty uses the same-origin BFF. */
  baseUrl?: string;
  scope: PublicScope;
  auth?: PublicAuth;
  fetch?: typeof globalThis.fetch;
  /** Test or server adapter escape hatch; product calls remain scope-bound. */
  transport?: Transport;
}

export interface PublicGetThreadInput {
  channelId: string;
  /** Defaults to Platform's current 100-message operating snapshot window. */
  limit?: number;
  /** Only zero is accepted; use pageToken to request older messages. */
  offset?: number;
  pageToken?: string;
  signal?: AbortSignal;
}

export interface PublicListThreadEventsInput {
  channelId: string;
  afterCursor: bigint;
  limit?: number;
  signal?: AbortSignal;
}

export interface PublicWatchThreadInput {
  channelId: string;
  afterCursor: bigint;
  signal?: AbortSignal;
}

export interface PublicSendMessageInput {
  channelId: string;
  body: string;
  /** Caller-owned key. The SDK never creates or replaces it. */
  idempotencyKey: string;
  continuationTaskId?: string;
  referenceTaskIds?: string[];
  modelSelection?: MessageInitShape<typeof OperatingModelSelectionSchema>;
  codingAcceptance?: MessageInitShape<typeof CodingAcceptanceContractSchema>;
  projectResourceId?: string;
  /** Bounded, redacted routing context sent only in X-EvalOps-App-Context. */
  appContext?: unknown;
  signal?: AbortSignal;
}

export interface PublicRespondToThreadInput {
  channelId: string;
  turnId: string;
  /** Must echo the current owner-issued request identity. */
  response: MessageInitShape<typeof OperatingThreadResponseSchema>;
  /** Caller-owned key. It is copied into the embedded response if absent. */
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface PublicInterruptThreadInput {
  channelId: string;
  turnId?: string;
  idempotencyKey: string;
  reason?: string;
  signal?: AbortSignal;
}

export interface PublicGetReceiptInput {
  channelId: string;
  receiptId: string;
  signal?: AbortSignal;
}

export interface PublicResolveReceiptInput {
  receiptId: string;
  /** Exact action object returned in receipt.allowedActions. */
  action: OperatingReceiptAction;
  idempotencyKey: string;
  signal?: AbortSignal;
}

/**
 * Typed facade for the durable Platform-owned operating-thread contract.
 * Responses are generated protobuf objects; 64-bit cursors remain bigint.
 */
export interface PublicClient {
  readonly scope: Readonly<PublicScope>;
  threads: {
    get(input: PublicGetThreadInput): Promise<GetOperatingThreadResponse>;
  };
  events: {
    list(input: PublicListThreadEventsInput): Promise<ListOperatingThreadEventsResponse>;
    /**
     * One bounded server stream. The caller owns reconnect and backoff policy.
     * Resume with the last returned nextCursor; replace its projection when
     * resetRequired is true instead of appending the page's snapshotTurns.
     */
    watch(input: PublicWatchThreadInput): AsyncIterable<WatchOperatingThreadResponse>;
  };
  messages: {
    send(input: PublicSendMessageInput): Promise<SubmitOperatingMessageResponse>;
  };
  controls: {
    respond(input: PublicRespondToThreadInput): Promise<RespondOperatingThreadResponse>;
    interrupt(input: PublicInterruptThreadInput): Promise<InterruptOperatingThreadResponse>;
  };
  receipts: {
    get(input: PublicGetReceiptInput): Promise<GetOperatingReceiptResponse>;
    resolve(input: PublicResolveReceiptInput): Promise<ResolveOperatingReceiptActionResponse>;
  };
}

/** Build a scope-bound public SDK client over Platform's Deixic service. */
export function createPublicClient(options: PublicClientOptions): PublicClient {
  const scope = normalizeScope(options.scope);
  const auth = options.auth;
  const client = createClient(DeixicService, createTransport(options));
  const identity = new CredentialIdentity(scope);

  function fixedScope() {
    return create(ConsoleQuerySchema, {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
    });
  }

  async function credential(): Promise<PublicCredential | null> {
    try {
      const resolved = await auth?.getCredential?.();
      return identity.check(snapshotCredential(resolved ?? null));
    } catch (error) {
      throw asPublicError(error);
    }
  }

  async function refreshed(
    current: PublicCredential | null,
  ): Promise<PublicCredential | null> {
    if (!auth?.refreshCredential) return null;
    try {
      // Retain a detached proof of what authorized the first request. The
      // provider gets its own mutable copy, so it cannot alter that proof
      // between a 401 and a replay decision.
      const proof = snapshotCredential(current);
      const next = await auth.refreshCredential(copyCredential(proof));
      // A refresh provider can decline to produce a credential. This is not an
      // ambient-cookie fallback: the SDK performs no replay and lets the
      // original authentication error retain its Platform metadata. A later
      // regular getCredential() call still rejects a disappeared explicit
      // credential through CredentialIdentity.
      if (!next) return null;
      const refreshedCredential = snapshotCredential(next);
      if (!refreshedCredential) return null;
      // Validate without changing the accepted identity. A failed session
      // verifier must not poison later requests with rejected subject/scope data.
      identity.validate(refreshedCredential);
      await verifyRefreshIdentity(proof, refreshedCredential);
      return identity.check(refreshedCredential);
    } catch (error) {
      throw asPublicError(error);
    }
  }

  async function verifyRefreshIdentity(
    current: PublicCredential | null,
    refreshedCredential: PublicCredential,
  ): Promise<void> {
    const currentSubject = current?.subject?.trim();
    const refreshedSubject = refreshedCredential.subject?.trim();
    if (currentSubject && refreshedSubject === currentSubject) return;

    if (current && auth?.verifyRefreshIdentity
      && await auth.verifyRefreshIdentity(
        copyCredential(current),
        copyCredential(refreshedCredential),
      )) {
      return;
    }

    throw credentialError(
      "credential refresh needs the same stable subject or verified session identity before replay",
    );
  }

  function headers(current: PublicCredential | null, appContextHeader?: string): Headers {
    const requestHeaders = new Headers({
      Accept: "application/proto",
      "X-Organization-ID": scope.organizationId,
      "X-Workspace-ID": scope.workspaceId,
    });

    const token = current?.accessToken?.trim();
    if (token) requestHeaders.set("Authorization", `${current?.tokenType?.trim() || "Bearer"} ${token}`);

    if (appContextHeader) requestHeaders.set(DEIXIC_PUBLIC_APP_CONTEXT_HEADER, appContextHeader);
    return requestHeaders;
  }

  async function unary<T>(
    operation: (requestHeaders: Headers) => Promise<T>,
    appContext?: unknown,
  ): Promise<T> {
    // Retain exactly the same bounded/redacted context across the one allowed
    // authentication retry, even if a caller mutates its source object later.
    const appContextHeader = encodePublicAppContextHeader(appContext);
    const current = await credential();
    try {
      return await operation(headers(current, appContextHeader));
    } catch (error) {
      // Platform authenticates before protobuf decode and effect admission. A
      // single retry is therefore limited to an authentication challenge; all
      // durable mutations still retain their caller-owned idempotency key.
      if (!isUnauthenticated(error) || !auth?.refreshCredential) {
        throw asPublicError(error);
      }

      const next = await refreshed(current);
      if (!next) throw asPublicError(error);
      try {
        return await operation(headers(next, appContextHeader));
      } catch (retryError) {
        throw asPublicError(retryError);
      }
    }
  }

  async function* watch(input: PublicWatchThreadInput): AsyncGenerator<WatchOperatingThreadResponse> {
    const request = snapshotRequest(WatchOperatingThreadRequestSchema, {
      scope: fixedScope(),
      threadId: required(input.channelId, "channelId"),
      afterCursor: cursor(input.afterCursor, "afterCursor"),
    });
    const current = await credential();
    let yielded = false;
    let initialAuthenticationError: unknown;

    try {
      for await (const page of client.watchEvents(request, {
        headers: headers(current),
        signal: input.signal,
      })) {
        yielded = true;
        yield page;
      }
      return;
    } catch (error) {
      // A stream that has started is never resumed by the SDK. The caller knows
      // its projection/cursor and chooses whether, when, and how to reconnect.
      if (yielded || !isUnauthenticated(error) || !auth?.refreshCredential) {
        throw asPublicError(error);
      }
      initialAuthenticationError = error;
    }

    const next = await refreshed(current);
    if (!next) throw asPublicError(initialAuthenticationError);

    try {
      for await (const page of client.watchEvents(request, {
        headers: headers(next),
        signal: input.signal,
      })) {
        yield page;
      }
    } catch (error) {
      throw asPublicError(error);
    }
  }

  return {
    scope,
    threads: {
      get(input) {
        const limit = readLimit(input.limit);
        const offset = readOffset(input.offset) ?? 0;
        if (offset !== 0) throw validationError("Use pageToken for public thread pagination");
        const request = snapshotRequest(GetOperatingThreadRequestSchema, {
          scope: fixedScope(),
          threadId: required(input.channelId, "channelId"),
          limit,
          pageToken: input.pageToken ?? "",
        });
        return unary((requestHeaders) => client.getThread(request, {
          headers: requestHeaders,
          signal: input.signal,
        }));
      },
    },
    events: {
      list(input) {
        const limit = eventLimit(input.limit);
        const request = snapshotRequest(ListOperatingThreadEventsRequestSchema, {
          scope: fixedScope(),
          threadId: required(input.channelId, "channelId"),
          afterCursor: cursor(input.afterCursor, "afterCursor"),
          limit,
        });
        return unary((requestHeaders) => client.listEvents(request, {
          headers: requestHeaders,
          signal: input.signal,
        }));
      },
      watch,
    },
    messages: {
      send(input) {
        const idempotencyKey = required(input.idempotencyKey, "idempotencyKey");
        const request = snapshotRequest(SubmitOperatingMessageRequestSchema, {
          scope: fixedScope(),
          threadId: required(input.channelId, "channelId"),
          body: input.body,
          idempotencyKey,
          continuationTaskId: input.continuationTaskId ?? "",
          referenceTaskIds: input.referenceTaskIds ?? [],
          modelSelection: input.modelSelection,
          codingContract: input.codingAcceptance,
          projectResourceId: input.projectResourceId,
        });
        return unary((requestHeaders) => client.submitTask(request, {
          headers: requestHeaders,
          signal: input.signal,
        }), input.appContext);
      },
    },
    controls: {
      respond(input) {
        const idempotencyKey = required(input.idempotencyKey, "idempotencyKey");
        const responseKey = typeof input.response.idempotencyKey === "string"
          ? input.response.idempotencyKey.trim()
          : "";
        if (responseKey && responseKey !== idempotencyKey) {
          throw validationError("response.idempotencyKey must match idempotencyKey");
        }
        const request = snapshotRequest(RespondOperatingThreadRequestSchema, {
          scope: fixedScope(),
          threadId: required(input.channelId, "channelId"),
          turnId: required(input.turnId, "turnId"),
          requestId: input.response.requestId,
          requestKind: input.response.requestKind,
          callId: input.response.callId,
          action: input.response.action,
          text: input.response.text,
          isError: input.response.isError,
          idempotencyKey,
        });
        return unary((requestHeaders) => client.respondToRequest(request, {
          headers: requestHeaders,
          signal: input.signal,
        }));
      },
      interrupt(input) {
        const request = snapshotRequest(InterruptOperatingThreadRequestSchema, {
          scope: fixedScope(),
          threadId: required(input.channelId, "channelId"),
          turnId: input.turnId ?? "",
          idempotencyKey: required(input.idempotencyKey, "idempotencyKey"),
          reason: input.reason ?? "",
        });
        return unary((requestHeaders) => client.interruptTask(request, {
          headers: requestHeaders,
          signal: input.signal,
        }));
      },
    },
    receipts: {
      get(input) {
        const request = snapshotRequest(GetOperatingReceiptRequestSchema, {
          scope: fixedScope(),
          threadId: required(input.channelId, "channelId"),
          receiptId: required(input.receiptId, "receiptId"),
        });
        return unary((requestHeaders) => client.getReceipt(request, {
          headers: requestHeaders,
          signal: input.signal,
        }));
      },
      resolve(input) {
        if (!input.action) throw validationError("action is required");
        const request = snapshotRequest(ResolveOperatingReceiptActionRequestSchema, {
          scope: fixedScope(),
          receiptId: required(input.receiptId, "receiptId"),
          actionId: required(input.action.id, "action.id"),
          idempotencyKey: required(input.idempotencyKey, "idempotencyKey"),
        });
        return unary((requestHeaders) => client.resolveReceiptAction(request, {
          headers: requestHeaders,
          signal: input.signal,
        }));
      },
    },
  };
}

function createTransport(options: PublicClientOptions): Transport {
  if (options.transport) return options.transport;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new PublicError({
      message: "Deixic SDK requires fetch or a Connect transport",
      kind: "transport",
    });
  }
  return createConnectTransport({
    baseUrl: trimTrailingSlash(options.baseUrl ?? ""),
    useBinaryFormat: true,
    fetch: async (input, init) => preservePlatformHttpStatus(await fetchImpl(input, {
      ...init,
      credentials: init?.credentials ?? "include",
    })),
  });
}

/**
 * Connect preserves response headers for a non-Connect error body but reports
 * Code.Unknown. Retain a bounded raw HTTP error status in private metadata so
 * the facade can preserve Platform's existing status/code error shape.
 */
function preservePlatformHttpStatus(response: Response): Response {
  const preserveStatus = Number.isInteger(response.status)
    && response.status >= 400
    && response.status <= 599;
  const hasInjectedHeader = response.headers.has(INTERNAL_DEIXIC_PUBLIC_HTTP_STATUS_HEADER);
  if (!preserveStatus && !hasInjectedHeader) {
    return response;
  }
  const headers = new Headers(response.headers);
  // Do not trust a response-supplied internal marker. Recreate it only from
  // this response's actual 4xx/5xx status, or remove it from other responses.
  headers.delete(INTERNAL_DEIXIC_PUBLIC_HTTP_STATUS_HEADER);
  if (preserveStatus) {
    headers.set(INTERNAL_DEIXIC_PUBLIC_HTTP_STATUS_HEADER, String(response.status));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

class CredentialIdentity {
  private subject: string | undefined;
  private scopes: Set<string> | undefined;
  private organizationId: string | undefined;
  private workspaceId: string | undefined;
  private sawCredential = false;

  constructor(private readonly scope: Readonly<PublicScope>) {}

  check(credential: PublicCredential | null): PublicCredential | null {
    if (!credential) {
      if (this.sawCredential) {
        throw credentialError("credential source removed an explicit credential");
      }
      return null;
    }
    this.sawCredential = true;

    const claims = this.claims(credential);
    if (claims.organizationId) this.organizationId = claims.organizationId;
    if (claims.workspaceId) this.workspaceId = claims.workspaceId;
    if (claims.subject) this.subject = claims.subject;
    if (claims.scopes.size > 0 && !this.scopes) this.scopes = claims.scopes;
    return credential;
  }

  validate(credential: PublicCredential): void {
    this.claims(credential);
  }

  private claims(credential: PublicCredential): {
    organizationId?: string;
    workspaceId?: string;
    subject?: string;
    scopes: Set<string>;
  } {
    const organizationId = credential.organizationId?.trim();
    const workspaceId = credential.workspaceId?.trim();
    if (organizationId && organizationId !== this.scope.organizationId) {
      throw credentialError("credential organizationId does not match the client scope");
    }
    if (workspaceId && workspaceId !== this.scope.workspaceId) {
      throw credentialError("credential workspaceId does not match the client scope");
    }
    if (this.organizationId && !organizationId) {
      throw credentialError("credential refresh removed its declared organizationId");
    }
    if (this.workspaceId && !workspaceId) {
      throw credentialError("credential refresh removed its declared workspaceId");
    }
    const subject = credential.subject?.trim();
    if (this.subject && !subject) {
      throw credentialError("credential refresh removed the authenticated subject");
    }
    if (subject && this.subject && subject !== this.subject) {
      throw credentialError("credential refresh changed the authenticated subject");
    }
    const scopes = normalizedScopes(credential.scopes);
    if (this.scopes && scopes.size === 0) {
      throw credentialError("credential refresh removed its declared OAuth scopes");
    }
    if (scopes.size > 0 && this.scopes) {
      if (!sameScopes(this.scopes, scopes)) {
        throw credentialError("credential refresh changed its declared OAuth scopes");
      }
    }
    return { organizationId, workspaceId, subject, scopes };
  }
}

function normalizeScope(scope: PublicScope): Readonly<PublicScope> {
  return Object.freeze({
    organizationId: required(scope.organizationId, "scope.organizationId"),
    workspaceId: required(scope.workspaceId, "scope.workspaceId"),
  });
}

function required(value: string, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw validationError(`${field} is required`);
  return normalized;
}

/**
 * Snapshot the complete protobuf request shape before a unary or pre-page stream
 * retry closure captures it. `create()` intentionally preserves some caller
 * list/object references; `clone()` prevents refresh-time mutation from
 * changing the bytes associated with a caller-owned idempotency key.
 */
function snapshotRequest<Desc extends DescMessage>(
  schema: Desc,
  init: MessageInitShape<Desc>,
): MessageShape<Desc> {
  return clone(schema, create(schema, init));
}

function cursor(value: bigint, field: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_OPERATING_CURSOR) {
    throw validationError(`${field} must be a non-negative bigint within the operating cursor range`);
  }
  return value;
}

function readLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_THREAD_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_EVENT_LIMIT) {
    throw validationError(`limit must be an integer between 1 and ${MAX_EVENT_LIMIT}`);
  }
  return value;
}

function readOffset(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > MAX_INT32) {
    throw validationError(`offset must be a non-negative int32`);
  }
  return value;
}

function eventLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_EVENT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_EVENT_LIMIT) {
    throw validationError(`limit must be an integer between 1 and ${MAX_EVENT_LIMIT}`);
  }
  return value;
}

function normalizedScopes(value: PublicCredential["scopes"]): Set<string> {
  const values = typeof value === "string" ? value.split(/\s+/) : value ?? [];
  return new Set(values.map((scope) => scope.trim()).filter(Boolean));
}

function snapshotCredential(
  credential: PublicCredential | null | undefined,
): PublicCredential | null {
  if (!credential) return null;
  return Object.freeze({
    accessToken: credential.accessToken,
    tokenType: credential.tokenType,
    subject: credential.subject,
    organizationId: credential.organizationId,
    workspaceId: credential.workspaceId,
    scopes: typeof credential.scopes === "string"
      ? credential.scopes
      : credential.scopes ? Object.freeze([...credential.scopes]) : undefined,
  });
}

function copyCredential(credential: PublicCredential): PublicCredential;
function copyCredential(credential: null): null;
function copyCredential(credential: PublicCredential | null): PublicCredential | null;
function copyCredential(
  credential: PublicCredential | null,
): PublicCredential | null {
  if (!credential) return null;
  return {
    ...credential,
    scopes: typeof credential.scopes === "string"
      ? credential.scopes
      : credential.scopes ? [...credential.scopes] : undefined,
  };
}

function sameScopes(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((scope) => right.has(scope));
}

function validationError(message: string): PublicError {
  return new PublicError({ message, kind: "validation", status: 400 });
}

function credentialError(message: string): PublicError {
  return new PublicError({ message, kind: "authentication", status: 401 });
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

type MaybePromise<T> = T | Promise<T>;
