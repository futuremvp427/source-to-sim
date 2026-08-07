/**
 * Server-only credential loader for Polymarket US.
 *
 * Values are read from process.env inside function bodies (never at module
 * scope) and are never returned to client code or API responses.
 */

export type PmusCredentials = {
  keyId: string;
  secretKey: string;
};

export function isPmusConfigured(): boolean {
  return loadPmusCredentials() !== null;
}

/**
 * Removes copy/paste artefacts only: leading/trailing whitespace and any CR/LF
 * characters. The Base64 payload itself is never otherwise modified.
 */
export function normalizeSecretValue(value: string): string {
  return value.replace(/[\r\n]/g, "").trim();
}

/** Returns credentials or null when not configured. Server-only. */
export function loadPmusCredentials(): PmusCredentials | null {
  const keyId = normalizeSecretValue(process.env["POLYMARKET_KEY_ID"] ?? "");
  const secretKey = normalizeSecretValue(process.env["POLYMARKET_SECRET_KEY"] ?? "");
  if (!keyId || !secretKey) return null;
  return { keyId, secretKey };
}

/** Secret literals to feed the redaction pipeline. */
export function pmusSecretLiterals(credentials: PmusCredentials | null): string[] {
  if (!credentials) return [];
  return [credentials.keyId, credentials.secretKey];
}