/** The only SDK request header that may carry product routing context. */
export const DEIXIC_PUBLIC_APP_CONTEXT_HEADER = "X-EvalOps-App-Context";

/** Matches the existing Operating Chat header budget. */
export const DEIXIC_PUBLIC_APP_CONTEXT_MAX_HEADER_CHARS = 6000;

/**
 * Encodes bounded, redacted product context for one submitted message.
 *
 * This context is intentionally kept out of the durable protobuf body. It can
 * guide request routing but does not become a user message or a completion
 * record.
 */
export function encodePublicAppContextHeader(value: unknown): string | undefined {
  const normalized = normalizeForHeader(value);
  if (normalized === undefined) return undefined;

  const encoded = encodedNormalizedContext(normalized);
  if (encoded.length <= DEIXIC_PUBLIC_APP_CONTEXT_MAX_HEADER_CHARS) return encoded;

  return encodeURIComponent(JSON.stringify({
    schema: "dex.app_context.v1",
    truncated: true,
    reason: "encoded_context_exceeded_header_budget",
  }));
}

/**
 * Returns the encoded length before the oversized-header fallback is applied.
 * Product UIs use this to decide whether to compact context before submit.
 */
export function encodedPublicAppContextHeaderLength(value: unknown): number {
  const normalized = normalizeForHeader(value);
  return normalized === undefined ? 0 : encodedNormalizedContext(normalized).length;
}

function encodedNormalizedContext(normalized: unknown): string {
  return encodeURIComponent(JSON.stringify(normalized));
}

function normalizeForHeader(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 25)
      .map((item) => normalizeForHeader(item))
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      const cleanKey = sanitizeKey(key);
      if (!cleanKey || sensitiveKey(cleanKey)) continue;
      const normalizedItem = normalizeForHeader(item);
      if (normalizedItem !== undefined) out[cleanKey] = normalizedItem;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

function sanitizeString(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return redactSensitiveString(normalized).slice(0, 300);
}

function redactSensitiveString(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
      "[REDACTED]",
    )
    .replace(
      /("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|authorization)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
      "$1\"[REDACTED]\"",
    )
    .replace(/\bBearer[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY)[A-Z0-9_]*)\s*([=:])\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
      "[REDACTED]",
    );
}

function sensitiveKey(key: string): boolean {
  return /(^|[_.-])(authorization|bearer|cookie|token|secret|password|credential|code|state|session)($|[_.-])/i.test(key);
}
