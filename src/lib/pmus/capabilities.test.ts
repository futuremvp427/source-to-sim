/**
 * Fake credentials + mocked HTTP only. Nothing here touches the network.
 *
 * The critical invariant: for every non-allowlisted authenticated operation,
 * signer calls = 0 and transport calls = 0.
 */

import { describe, expect, it, vi } from "vitest";

import {
  getBalances,
  getPositions,
  isAllowedOperation,
  previewOrder,
  __testOnly,
  type PmusDeps,
} from "./capabilities.server";
import { classifyCompatibility } from "./compatibility.server";
import { mapOutcomeSide, availableUsdBalance } from "./previews.server";
import {
  MAX_MESSAGE_LENGTH,
  REJECTED_OPERATION_MESSAGE,
  safeErrorMessage,
} from "./redact";

const FAKE_KEY_ID = "fake-key-id-0000";
const FAKE_SECRET = "ZmFrZS1zZWNyZXQta2V5LXZhbHVlLWZvci10ZXN0cw==";

function harness(responseBody: unknown, status = 200) {
  const signer = vi.fn(async () => "ZmFrZS1zaWduYXR1cmU=");
  const transport = vi.fn(
    async () =>
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  const deps: PmusDeps = {
    credentials: { keyId: FAKE_KEY_ID, secretKey: FAKE_SECRET },
    signer,
    transport,
    now: () => 1_700_000_000_000,
  };
  return { signer, transport, deps };
}

describe("allowed capabilities", () => {
  it("balances works", async () => {
    const { deps, signer, transport } = harness({ balances: [{ currency: "USD", buyingPower: 25 }] });
    const result = await getBalances(deps);
    expect(result.ok).toBe(true);
    expect(signer).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toBe("https://api.polymarket.us/v1/account/balances");
  });

  it("positions works", async () => {
    const { deps, transport } = harness({ positions: [] });
    const result = await getPositions(deps);
    expect(result.ok).toBe(true);
    expect(transport.mock.calls[0]?.[0]).toBe("https://api.polymarket.us/v1/portfolio/positions");
  });

  it("preview works and never uses an order-submission path", async () => {
    const { deps, transport } = harness({ order: { quantity: 10, avgPx: { value: "0.42" } } });
    const result = await previewOrder(
      {
        marketSlug: "will-it-rain-in-nyc",
        outcomeSide: "OUTCOME_SIDE_YES",
        action: "ORDER_ACTION_BUY",
        quantity: 10,
        limitPrice: 0.42,
      },
      deps,
    );
    expect(result.ok).toBe(true);
    const url = String(transport.mock.calls[0]?.[0]);
    expect(url).toBe("https://api.polymarket.us/v1/order/preview");
    expect(url).not.toContain("/v1/orders");
  });

  it("sends the documented auth headers and no bearer token", async () => {
    const { deps, transport } = harness({ balances: [] });
    await getBalances(deps);
    const init = transport.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-PM-Access-Key"]).toBe(FAKE_KEY_ID);
    expect(headers["X-PM-Timestamp"]).toBe("1700000000000");
    expect(headers["X-PM-Signature"]).toBe("ZmFrZS1zaWduYXR1cmU=");
    expect(headers["Authorization"]).toBeUndefined();
  });
});

const FORBIDDEN: ReadonlyArray<readonly [string, string, string]> = [
  ["live order submission", "POST", "/v1/orders"],
  ["cancel order", "DELETE", "/v1/orders/abc123"],
  ["cancel order (post form)", "POST", "/v1/order/cancel"],
  ["modify order", "PATCH", "/v1/orders/abc123"],
  ["modify order (post form)", "POST", "/v1/order/modify"],
  ["close position", "POST", "/v1/portfolio/positions/close"],
  ["batch orders", "POST", "/v1/orders/batch"],
  ["unknown authenticated GET", "GET", "/v1/secret/thing"],
  ["unknown authenticated POST", "POST", "/v1/secret/thing"],
  ["trailing slash bypass", "POST", "/v1/order/preview/"],
  ["query string bypass", "GET", "/v1/account/balances?x=1"],
  ["absolute URL bypass", "POST", "https://api.polymarket.us/v1/orders"],
  ["protocol-relative bypass", "POST", "//evil.example/v1/order/preview"],
  ["backslash bypass", "POST", "/v1\\order/preview"],
  ["lowercase method bypass", "get", "/v1/account/balances"],
  ["fragment bypass", "GET", "/v1/account/balances#/v1/orders"],
];

describe.each(FORBIDDEN)("rejected operation: %s", (_name, method, path) => {
  it("never reaches the signer or the transport", async () => {
    const { deps, signer, transport } = harness({ ok: true });
    const result = await __testOnly.attemptOperation({ method, path }, deps);
    expect(result.ok).toBe(false);
    expect(signer).toHaveBeenCalledTimes(0);
    expect(transport).toHaveBeenCalledTimes(0);
    expect(isAllowedOperation(method, path)).toBe(false);
  });

  it("uses a constant message that never echoes the caller path", async () => {
    const { deps } = harness({ ok: true });
    const result = await __testOnly.attemptOperation({ method, path }, deps);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error).toBe(REJECTED_OPERATION_MESSAGE);
    expect(result.error).not.toContain(path);
  });
});

describe("secret redaction", () => {
  it("redacts the key id, secret key and signature from error bodies", async () => {
    const { deps } = harness({ ok: false }, 500);
    const failing: PmusDeps = {
      ...deps,
      transport: async () =>
        new Response(`bad key ${FAKE_KEY_ID} secret ${FAKE_SECRET} sig ZmFrZS1zaWduYXR1cmU=`, {
          status: 401,
        }),
    };
    const result = await getBalances(failing);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).not.toContain(FAKE_KEY_ID);
    expect(result.error).not.toContain(FAKE_SECRET);
  });

  it("redacts before truncating at the truncation boundary", () => {
    const filler = "x".repeat(MAX_MESSAGE_LENGTH - 5);
    const message = safeErrorMessage(`${filler}${FAKE_SECRET}`, [FAKE_KEY_ID, FAKE_SECRET]);
    expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH + 1);
    expect(message).not.toContain(FAKE_SECRET);
  });

  it("redacts secrets that straddle the truncation boundary", () => {
    const filler = "y".repeat(MAX_MESSAGE_LENGTH - 10);
    const message = safeErrorMessage(
      `${filler}${FAKE_SECRET} trailing detail`,
      [FAKE_SECRET],
    );
    expect(message).not.toContain(FAKE_SECRET.slice(0, 12));
  });

  it("redacts urls, paths, query strings and auth headers", () => {
    const message = safeErrorMessage(
      "GET https://api.polymarket.us/v1/account/balances?token=abc failed; X-PM-Signature: abc123",
    );
    expect(message).not.toContain("https://api.polymarket.us");
    expect(message).not.toContain("token=abc");
    expect(message).not.toContain("abc123");
  });

  it("handles non-JSON bodies and transport errors safely", async () => {
    const { deps } = harness({});
    const nonJson: PmusDeps = {
      ...deps,
      transport: async () => new Response("<html>oops</html>", { status: 200 }),
    };
    const a = await getBalances(nonJson);
    expect(a.ok).toBe(false);

    const throwing: PmusDeps = {
      ...deps,
      transport: async () => {
        throw new Error(`network down for ${FAKE_SECRET}`);
      },
    };
    const b = await getBalances(throwing);
    if (b.ok) throw new Error("expected failure");
    expect(b.error).not.toContain(FAKE_SECRET);
  });
});

describe("market compatibility gate", () => {
  const active = { slug: "rain-nyc", active: true, closed: false, archived: false };

  it("EXACT_MATCH only for a single active market with the same slug", () => {
    expect(classifyCompatibility("rain-nyc", [active]).compatibility).toBe("EXACT_MATCH");
  });

  it("AMBIGUOUS when several US markets share the slug", () => {
    expect(classifyCompatibility("rain-nyc", [active, active]).compatibility).toBe("AMBIGUOUS");
  });

  it("POSSIBLE_MATCH when the slug match is closed or inactive", () => {
    expect(
      classifyCompatibility("rain-nyc", [{ ...active, closed: true }]).compatibility,
    ).toBe("POSSIBLE_MATCH");
  });

  it("POSSIBLE_MATCH when only similar markets come back", () => {
    expect(
      classifyCompatibility("rain-nyc", [{ slug: "rain-nyc-2", active: true }]).compatibility,
    ).toBe("POSSIBLE_MATCH");
  });

  it("NO_MATCH with no candidates or no slug", () => {
    expect(classifyCompatibility("rain-nyc", []).compatibility).toBe("NO_MATCH");
    expect(classifyCompatibility(null, [active]).compatibility).toBe("NO_MATCH");
  });

  it("never returns a US slug unless the match is exact", () => {
    for (const result of [
      classifyCompatibility("rain-nyc", [active, active]),
      classifyCompatibility("rain-nyc", [{ ...active, active: false }]),
      classifyCompatibility("rain-nyc", []),
    ]) {
      expect(result.usMarketSlug).toBeNull();
    }
  });
});

describe("preview helpers", () => {
  it("maps only yes/no outcomes", () => {
    expect(mapOutcomeSide("Yes")).toBe("OUTCOME_SIDE_YES");
    expect(mapOutcomeSide("no")).toBe("OUTCOME_SIDE_NO");
    expect(mapOutcomeSide("Above 70°F")).toBeNull();
    expect(mapOutcomeSide(null)).toBeNull();
  });

  it("reads USD buying power as available balance", () => {
    expect(availableUsdBalance([{ currency: "USD", buyingPower: 12.5 }])).toBe(12.5);
    expect(availableUsdBalance([{ currency: "EUR", buyingPower: 5 }])).toBeNull();
    expect(availableUsdBalance(undefined)).toBeNull();
  });
});