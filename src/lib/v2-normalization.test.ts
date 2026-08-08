import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  applyBuy,
  applySell,
  cashBreakdown,
  decideDynamicBuy,
  SIZING_RULE_VERSION,
} from "./shadow-core";
import {
  V2_COHORT,
  V2_RESERVE_USD,
  V2_SIZING_RULE,
  V2_STARTING_CASH,
  experimentCohort,
  isEligibleForV2Copy,
  isV2Name,
  v2SeedRows,
} from "./v2-cohort";
import { ALLOWED_OPERATIONS, isAllowedOperation } from "./pmus/capabilities.server";

const GO_LIVE = 1_786_155_989;

/** Minimal deterministic replica of the autonomous copy loop, per experiment. */
type Book = {
  cash: number;
  startingCash: number;
  position: { shares: number; costBasis: number; avgPrice: number; realizedPnl: number };
  trades: { eventKey: string; action: string; notional: number }[];
  seen: Set<string>;
};

function newBook(startingCash = V2_STARTING_CASH): Book {
  return {
    cash: startingCash,
    startingCash,
    position: { shares: 0, costBasis: 0, avgPrice: 0, realizedPnl: 0 },
    trades: [],
    seen: new Set(),
  };
}

function copyFill(
  book: Book,
  fill: { eventKey: string; sourceTs: number; price: number },
  followFromTs = GO_LIVE,
): "COPIED" | "SKIPPED_HISTORICAL" | "DUPLICATE" | "SKIPPED_RESERVE" {
  if (book.seen.has(fill.eventKey)) return "DUPLICATE";
  if (!isEligibleForV2Copy(fill.sourceTs, followFromTs)) return "SKIPPED_HISTORICAL";
  const decision = decideDynamicBuy({
    price: fill.price,
    startingCash: book.startingCash,
    cash: book.cash,
  });
  book.seen.add(fill.eventKey);
  if (decision.action !== "BUY") return "SKIPPED_RESERVE";
  const applied = applyBuy(book.position, book.cash, decision.shares, decision.notional);
  book.position = applied.position;
  book.cash = applied.cash;
  book.trades.push({ eventKey: fill.eventKey, action: "BUY", notional: decision.notional });
  return "COPIED";
}

describe("V2 cohort initialization", () => {
  const seeds = v2SeedRows(GO_LIVE);

  it("defines exactly the five followed wallets", () => {
    expect(seeds).toHaveLength(5);
    expect(seeds.map((s) => s.name)).toEqual([
      "SHADOW V2: badatmath.",
      "SHADOW V2: Poligarch",
      "SHADOW V2: gghff",
      "SHADOW V2: Weather-Guru",
      "SHADOW V2: HighTempTation",
    ]);
    expect(new Set(seeds.map((s) => s.wallet_address)).size).toBe(5);
  });

  it("initializes every V2 experiment at $380 with zero positions and zero P&L", () => {
    for (const seed of seeds) {
      expect(seed.starting_cash).toBe(380);
      expect(seed.cash).toBe(380);
      expect(seed.realized_pnl).toBe(0);
      expect(seed.enabled).toBe(true);
      expect(seed.simulated).toBe(true);
      expect(seed.follow_from_ts).toBe(GO_LIVE);
    }
  });

  it("uses dynamic-v1 sizing with a $38 reserve", () => {
    expect(V2_SIZING_RULE).toBe(SIZING_RULE_VERSION);
    for (const seed of seeds) expect(seed.sizing_rule).toBe("dynamic-v1");
    expect(V2_RESERVE_USD).toBe(38);
    expect(cashBreakdown({ startingCash: 380, cash: 380 })).toEqual({
      availableCash: 380,
      reservedCash: 38,
      spendableCash: 342,
    });
  });

  it("separates the V2 cohort from frozen V1 names", () => {
    expect(isV2Name("SHADOW V2: gghff")).toBe(true);
    expect(isV2Name("SHADOW:gghff")).toBe(false);
    expect(experimentCohort("SHADOW")).toBe("V1");
    expect(experimentCohort("SHADOW V2: badatmath.")).toBe("V2");
    for (const member of V2_COHORT) expect(member.v1Name.startsWith("SHADOW")).toBe(true);
  });
});

describe("V2 go-live eligibility", () => {
  it("never copies a fill from before go-live", () => {
    const book = newBook();
    expect(copyFill(book, { eventKey: "old-1", sourceTs: GO_LIVE - 1, price: 0.5 })).toBe(
      "SKIPPED_HISTORICAL",
    );
    expect(copyFill(book, { eventKey: "old-2", sourceTs: GO_LIVE - 86_400, price: 0.5 })).toBe(
      "SKIPPED_HISTORICAL",
    );
    expect(book.trades).toHaveLength(0);
    expect(book.cash).toBe(380);
  });

  it("copies an eligible post-go-live fill exactly once, autonomously", () => {
    const book = newBook();
    expect(copyFill(book, { eventKey: "new-1", sourceTs: GO_LIVE + 5, price: 0.5 })).toBe("COPIED");
    // No approval step exists in the paper path: the trade is already recorded.
    expect(book.trades).toHaveLength(1);
    expect(book.trades[0]!.notional).toBe(3.8);
  });

  it("duplicate polling of the same event cannot duplicate the paper trade", () => {
    const book = newBook();
    const fill = { eventKey: "new-1", sourceTs: GO_LIVE + 5, price: 0.5 };
    copyFill(book, fill);
    expect(copyFill(book, fill)).toBe("DUPLICATE");
    expect(copyFill(book, fill)).toBe("DUPLICATE");
    expect(book.trades).toHaveLength(1);
  });
});

describe("dynamic-v1 sizing under V2", () => {
  it("targets min($5, 1% of cash) with a $1 floor", () => {
    expect(decideDynamicBuy({ price: 0.5, startingCash: 380, cash: 380 }).notional).toBe(3.8);
    expect(decideDynamicBuy({ price: 0.5, startingCash: 380, cash: 900 }).notional).toBe(5);
    expect(decideDynamicBuy({ price: 0.5, startingCash: 380, cash: 60 }).notional).toBe(1);
  });

  it("never breaches the 10% starting-bankroll reserve", () => {
    const book = newBook();
    for (let i = 0; i < 5000; i += 1) {
      copyFill(book, { eventKey: `e-${i}`, sourceTs: GO_LIVE + i, price: 0.5 });
      expect(book.cash).toBeGreaterThanOrEqual(V2_RESERVE_USD - 1);
    }
    expect(book.cash).toBeGreaterThanOrEqual(37);
    const last = copyFill(book, { eventKey: "final", sourceTs: GO_LIVE + 9999, price: 0.5 });
    expect(last).toBe("SKIPPED_RESERVE");
  });

  it("restores spendable cash from SELL proceeds", () => {
    const book = newBook();
    copyFill(book, { eventKey: "buy-1", sourceTs: GO_LIVE + 1, price: 0.5 });
    const cashAfterBuy = book.cash;
    const sold = applySell(book.position, book.cash, book.position.shares, 0.6);
    expect(sold.cash).toBeGreaterThan(cashAfterBuy);
    expect(cashBreakdown({ startingCash: 380, cash: sold.cash }).reservedCash).toBe(38);
  });
});

describe("V2 isolation", () => {
  it("keeps cash, positions and P&L independent per experiment", () => {
    const a = newBook();
    const b = newBook();
    for (let i = 0; i < 20; i += 1) {
      copyFill(a, { eventKey: `a-${i}`, sourceTs: GO_LIVE + i, price: 0.5 });
    }
    expect(a.cash).toBeLessThan(380);
    expect(b.cash).toBe(380);
    expect(b.position.shares).toBe(0);
    expect(b.trades).toHaveLength(0);
  });

  it("one experiment exhausting its cash cannot affect another", () => {
    const drained = newBook();
    for (let i = 0; i < 5000; i += 1) {
      copyFill(drained, { eventKey: `d-${i}`, sourceTs: GO_LIVE + i, price: 0.5 });
    }
    expect(copyFill(drained, { eventKey: "d-last", sourceTs: GO_LIVE + 9999, price: 0.5 })).toBe(
      "SKIPPED_RESERVE",
    );
    const healthy = newBook();
    expect(copyFill(healthy, { eventKey: "h-1", sourceTs: GO_LIVE + 1, price: 0.5 })).toBe("COPIED");
    expect(healthy.cash).toBeCloseTo(376.2, 6);
  });
});

describe("Polymarket US safety boundary", () => {
  it("still allows only balances, positions and order preview", () => {
    expect(Object.keys(ALLOWED_OPERATIONS).sort()).toEqual([
      "balances",
      "orderPreview",
      "positions",
    ]);
    expect(isAllowedOperation("GET", "/v1/account/balances")).toBe(true);
    expect(isAllowedOperation("GET", "/v1/portfolio/positions")).toBe(true);
    expect(isAllowedOperation("POST", "/v1/order/preview")).toBe(true);
  });

  it("rejects every live order-submission style operation", () => {
    for (const [method, path] of [
      ["POST", "/v1/order"],
      ["POST", "/v1/orders"],
      ["POST", "/v1/order/submit"],
      ["DELETE", "/v1/order/123"],
      ["PATCH", "/v1/order/123"],
      ["POST", "/v1/account/withdrawals"],
    ] as const) {
      expect(isAllowedOperation(method, path)).toBe(false);
    }
  });

  it("has no live order-submission path anywhere in the Polymarket US module", () => {
    const files = [
      "src/lib/pmus/capabilities.server.ts",
      "src/lib/pmus/previews.server.ts",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/["'`]\/v1\/order["'`]/);
      expect(source).not.toMatch(/\/v1\/order\/(submit|cancel)/);
      expect(source).not.toMatch(/\/v1\/orders/);
    }
  });
});

describe("repository hygiene", () => {
  it("ignores local environment files", () => {
    const ignore = readFileSync(".gitignore", "utf8");
    for (const pattern of [".env", ".env.local", ".env.*.local"]) {
      expect(ignore.split("\n").map((l) => l.trim())).toContain(pattern);
    }
  });
});
