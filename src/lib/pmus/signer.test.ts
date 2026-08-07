import { describe, expect, it } from "vitest";

import { buildSigningMessage, signRequest } from "./signer.server";

// Deterministic 32-byte fake Ed25519 seed (0x01..0x20), never a real secret.
const SEED = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1));
const PUBLIC_SUFFIX = new Uint8Array(32).fill(0xaa);

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const SEED_B64 = toBase64(SEED);
const SEED_PLUS_PUBLIC_B64 = toBase64(new Uint8Array([...SEED, ...PUBLIC_SUFFIX]));

describe("pmus signer", () => {
  it("signs exactly timestamp + METHOD + path", () => {
    expect(buildSigningMessage("1700000000000", "GET", "/v1/account/balances")).toBe(
      "1700000000000GET/v1/account/balances",
    );
  });

  it("is deterministic for a known seed", async () => {
    const a = await signRequest(SEED_B64, "1700000000000", "GET", "/v1/account/balances");
    const b = await signRequest(SEED_B64, "1700000000000", "GET", "/v1/account/balances");
    expect(a).toBe(b);
    expect(atob(a).length).toBe(64);
  });

  it("uses only the first 32 decoded bytes (64-byte seed||public form matches)", async () => {
    const fromSeed = await signRequest(SEED_B64, "1700000000000", "GET", "/v1/account/balances");
    const fromExpanded = await signRequest(
      SEED_PLUS_PUBLIC_B64,
      "1700000000000",
      "GET",
      "/v1/account/balances",
    );
    expect(fromExpanded).toBe(fromSeed);
  });

  it("ignores copy/paste whitespace and newlines in the secret", async () => {
    const dirty = `\n  ${SEED_B64}\r\n`;
    const clean = await signRequest(SEED_B64, "1700000000000", "GET", "/v1/account/balances");
    expect(await signRequest(dirty, "1700000000000", "GET", "/v1/account/balances")).toBe(clean);
  });

  it("produces different signatures per path", async () => {
    const a = await signRequest(SEED_B64, "1700000000000", "GET", "/v1/account/balances");
    const b = await signRequest(SEED_B64, "1700000000000", "GET", "/v1/portfolio/positions");
    const c = await signRequest(SEED_B64, "1700000000000", "POST", "/v1/order/preview");
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
