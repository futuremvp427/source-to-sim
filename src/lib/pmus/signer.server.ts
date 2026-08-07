/**
 * Ed25519 request signer, per current official Polymarket US docs
 * (docs.polymarket.us/api-reference/authentication):
 *
 *   message   = timestamp + HTTP method + request path
 *   signature = base64( Ed25519_sign(secretKey[:32], message) )
 *   headers   = X-PM-Access-Key, X-PM-Timestamp (ms), X-PM-Signature
 *
 * Timestamps must be within 30 seconds of server time.
 */

const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function importSigningKey(secretKeyBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(secretKeyBase64);
  if (raw.length < 32) throw new Error("Polymarket US secret key is malformed.");
  const seed = raw.slice(0, 32);
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  return crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, { name: "Ed25519" }, false, [
    "sign",
  ]);
}

/** Builds the exact signing payload. Exported for tests. */
export function buildSigningMessage(timestamp: string, method: string, path: string): string {
  return `${timestamp}${method}${path}`;
}

/** Base64 Ed25519 signature of `timestamp + method + path`. */
export async function signRequest(
  secretKeyBase64: string,
  timestamp: string,
  method: string,
  path: string,
): Promise<string> {
  const key = await importSigningKey(secretKeyBase64);
  const message = new TextEncoder().encode(buildSigningMessage(timestamp, method, path));
  const signature = await crypto.subtle.sign("Ed25519", key, message as BufferSource);
  return bytesToBase64(new Uint8Array(signature));
}