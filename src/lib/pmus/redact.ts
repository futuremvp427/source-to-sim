/**
 * Secret redaction for anything that could carry Polymarket US credentials.
 *
 * Required order is normalize -> redact -> truncate -> format. Redaction MUST
 * happen before truncation so a secret straddling the truncation boundary can
 * never survive as a partial value.
 */

export const REDACTED = "[redacted]";
export const MAX_MESSAGE_LENGTH = 400;

/** Constant message for every rejected authenticated operation. */
export const REJECTED_OPERATION_MESSAGE =
  "Rejected: this authenticated Polymarket US operation is not allowed.";

/** Step 1 — normalize any thrown/returned value into a plain string. */
export function normalizeMessage(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  if (typeof input === "number" || typeof input === "boolean") return String(input);
  if (input instanceof Error) return `${input.name}: ${input.message}`;
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return "[unserializable value]";
  }
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;
const QUERY_RE = /\?[^\s"'<>]+/g;
const PATH_RE = /(?<![A-Za-z0-9])\/v\d+\/[^\s"'<>]*/g;
const HEADER_RE = /((?:x-pm-[a-z-]+|authorization)\s*[:=]\s*)("?)[^\s",;}]*\2/gi;
/** Long opaque tokens (base64 / hex / base64url) that could be a key or signature. */
const TOKEN_RE = /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g;

/** Step 2 — redact secrets and any caller-controlled transport detail. */
export function redactMessage(message: string, extraSecrets: readonly string[] = []): string {
  let out = message;

  for (const secret of extraSecrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    out = out.split(secret).join(REDACTED);
  }

  out = out.replace(HEADER_RE, (_m, label: string) => `${label}${REDACTED}`);
  out = out.replace(URL_RE, "[redacted-url]");
  out = out.replace(PATH_RE, "[redacted-path]");
  out = out.replace(QUERY_RE, "?[redacted-query]");
  out = out.replace(TOKEN_RE, REDACTED);

  return out;
}

/** Step 3 — truncate. Always runs after redaction. */
export function truncateMessage(message: string, max = MAX_MESSAGE_LENGTH): string {
  if (message.length <= max) return message;
  return `${message.slice(0, max)}…[truncated]`;
}

/** Step 4 — format for storage/UI. */
export function formatMessage(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, " ");
  return trimmed.length === 0 ? "Unknown error." : trimmed;
}

/**
 * The single safe error pipeline. Never returns raw secrets, signatures,
 * headers, URLs, paths, or query strings.
 */
export function safeErrorMessage(input: unknown, secrets: readonly string[] = []): string {
  return formatMessage(truncateMessage(redactMessage(normalizeMessage(input), secrets)));
}