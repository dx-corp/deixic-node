import { Code, ConnectError } from "@connectrpc/connect";

/** Private transport metadata; intentionally not re-exported from the SDK. */
export const INTERNAL_DEIXIC_PUBLIC_HTTP_STATUS_HEADER = "x-deixic-product-http-status";

/** Stable error categories for product code. */
export type PublicErrorKind =
  | "authentication"
  | "authorization"
  | "validation"
  | "conflict"
  | "not_found"
  | "unavailable"
  | "rate_limited"
  | "transport"
  | "protocol";

/**
 * An error returned by the Deixic SDK facade. The original Connect
 * error remains its cause so applications can inspect protocol details if they
 * need them without coupling ordinary handling to Connect.
 */
export class PublicError extends Error {
  readonly kind: PublicErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly traceparent?: string;

  constructor(input: {
    message: string;
    kind: PublicErrorKind;
    status?: number;
    code?: string;
    requestId?: string;
    traceparent?: string;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "PublicError";
    this.kind = input.kind;
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId;
    this.traceparent = input.traceparent;
  }
}

export function asPublicError(error: unknown): PublicError {
  if (error instanceof PublicError) return error;
  if (error instanceof ConnectError) return fromConnectError(error);

  return new PublicError({
    message: error instanceof Error ? error.message : String(error),
    kind: "transport",
    cause: error,
  });
}

export function isUnauthenticated(error: unknown): boolean {
  return error instanceof ConnectError && error.code === Code.Unauthenticated;
}

function fromConnectError(error: ConnectError): PublicError {
  const metadata = error.metadata;
  const status = preservedHttpStatus(metadata) ?? httpStatusFor(error.code);
  return new PublicError({
    message: error.rawMessage || error.message,
    kind: errorKindFor(error.code),
    status,
    code: metadata.get("x-evalops-error-code")
      ?? metadata.get("x-error-code")
      ?? connectCodeName(error.code),
    requestId: metadata.get("x-request-id") ?? undefined,
    traceparent: metadata.get("traceparent") ?? undefined,
    cause: error,
  });
}

function preservedHttpStatus(metadata: Headers): number | undefined {
  const value = metadata.get(INTERNAL_DEIXIC_PUBLIC_HTTP_STATUS_HEADER);
  if (!value || !/^[45]\d{2}$/.test(value)) return undefined;
  return Number(value);
}

function errorKindFor(code: Code): PublicErrorKind {
  switch (code) {
    case Code.Unauthenticated:
      return "authentication";
    case Code.PermissionDenied:
      return "authorization";
    case Code.InvalidArgument:
    case Code.OutOfRange:
      return "validation";
    case Code.AlreadyExists:
    case Code.Aborted:
    case Code.FailedPrecondition:
      return "conflict";
    case Code.NotFound:
      return "not_found";
    case Code.ResourceExhausted:
      return "rate_limited";
    case Code.Unavailable:
    case Code.DeadlineExceeded:
      return "unavailable";
    case Code.Canceled:
      return "transport";
    default:
      return "protocol";
  }
}

function httpStatusFor(code: Code): number {
  switch (code) {
    case Code.Canceled:
      return 499;
    case Code.InvalidArgument:
      return 400;
    case Code.DeadlineExceeded:
      return 504;
    case Code.NotFound:
      return 404;
    case Code.AlreadyExists:
      return 409;
    case Code.PermissionDenied:
      return 403;
    case Code.ResourceExhausted:
      return 429;
    case Code.FailedPrecondition:
      return 400;
    case Code.Aborted:
      return 409;
    case Code.OutOfRange:
      return 400;
    case Code.Unimplemented:
      return 501;
    case Code.Internal:
    case Code.DataLoss:
    case Code.Unknown:
      return 500;
    case Code.Unavailable:
      return 503;
    case Code.Unauthenticated:
      return 401;
  }
}

function connectCodeName(code: Code): string {
  return Code[code]?.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase() ?? "unknown";
}
