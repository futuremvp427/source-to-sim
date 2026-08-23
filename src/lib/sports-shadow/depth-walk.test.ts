import { describe, expect, it } from "vitest";
import { evaluateNotionalTiers, SPORTS_SHADOW_NOTIONALS_USD, walkBuyDepth, walkSellDepth } from "./depth-walk";
import type { DepthLevel } from "./types";

describe("walkBuyDepth — core walk", () => {
  it("1. $5 single-level full fill", () => {
    const r = walkBuyDepth([{ price: 0.5, size: 100 }], 5);
    expect(r.status).toBe("FULL");
    expect(r.filledNotionalUsd).toBe(5);
    expect(r.contractsFilled).toBeCloseTo(10, 9);
  });

  it("2. multi-level full fill (mission's own worked example: 0.40x10 + 0.50 remainder = 12 contracts @ VWAP 0.41666...)", () => {
    const r = walkBuyDepth([{ price: 0.4, size: 10 }, { price: 0.5, size: 100 }], 5);
    expect(r.status).toBe("FULL");
    expect(r.filledNotionalUsd).toBe(5);
    expect(r.contractsFilled).toBeCloseTo(12, 9);
    expect(r.averageExecutionPrice).toBeCloseTo(5 / 12, 9);
  });

  it("3. exact boundary at one level (requested notional exactly equals one level's capacity)", () => {
    const r = walkBuyDepth([{ price: 0.5, size: 10 }], 5); // capacity = 0.5*10 = 5 exactly
    expect(r.status).toBe("FULL");
    expect(r.contractsFilled).toBeCloseTo(10, 9);
    expect(r.levelsConsumed).toBe(1);
  });

  it("4. exact boundary across multiple levels (requested equals full captured depth exactly)", () => {
    const levels = [{ price: 0.4, size: 10 }, { price: 0.5, size: 2 }]; // 4.00 + 1.00 = 5.00 exactly
    const r = walkBuyDepth(levels, 5);
    expect(r.status).toBe("FULL");
    expect(r.levelsConsumed).toBe(2);
  });

  it("5. partial fill when requested exceeds captured depth", () => {
    const levels = [{ price: 0.5, size: 10 }]; // total capacity = $5
    const r = walkBuyDepth(levels, 100);
    expect(r.status).toBe("PARTIAL");
    expect(r.filledNotionalUsd).toBeCloseTo(5, 9);
    expect(r.unfilledNotionalUsd).toBeCloseTo(95, 9);
    expect(r.fillRatio).toBeCloseTo(0.05, 9);
  });

  it("6. empty depth yields NONE", () => {
    const r = walkBuyDepth([], 5);
    expect(r.status).toBe("NONE");
    expect(r.filledNotionalUsd).toBe(0);
    expect(r.contractsFilled).toBe(0);
  });

  it("7/8/9/10. contractsFilled, filledNotional, unfilledNotional, fillRatio are all correct for a realistic partial scenario", () => {
    // mission's example: $100 requested, top-5 book only supports $63.42
    const levels = [
      { price: 0.5, size: 20 }, // $10
      { price: 0.55, size: 20 }, // $11
      { price: 0.6, size: 20 }, // $12
      { price: 0.65, size: 20 }, // $13
      { price: 0.7, size: 24.6 }, // $17.22
    ];
    const totalCapacity = levels.reduce((s, l) => s + l.price * l.size, 0);
    const r = walkBuyDepth(levels, 100);
    expect(r.status).toBe("PARTIAL");
    expect(r.filledNotionalUsd).toBeCloseTo(totalCapacity, 9);
    expect(r.unfilledNotionalUsd).toBeCloseTo(100 - totalCapacity, 9);
    expect(r.fillRatio).toBeCloseTo(totalCapacity / 100, 9);
    const expectedContracts = levels.reduce((s, l) => s + l.size, 0);
    expect(r.contractsFilled).toBeCloseTo(expectedContracts, 9);
  });

  it("11. VWAP is correct", () => {
    const r = walkBuyDepth([{ price: 0.4, size: 10 }, { price: 0.6, size: 10 }], 10); // 4 + 6 = 10 exactly, 20 contracts
    expect(r.averageExecutionPrice).toBeCloseTo(10 / 20, 9);
  });

  it("12. bestAvailablePrice is the lowest valid ask regardless of input order", () => {
    const r = walkBuyDepth([{ price: 0.6, size: 1 }, { price: 0.4, size: 1 }, { price: 0.5, size: 1 }], 5);
    expect(r.bestAvailablePrice).toBe(0.4);
  });

  it("13. worstExecutionPrice is the highest-price level actually consumed", () => {
    const r = walkBuyDepth([{ price: 0.4, size: 10 }, { price: 0.5, size: 100 }, { price: 0.9, size: 100 }], 5);
    expect(r.worstExecutionPrice).toBe(0.5); // never reaches the 0.9 level
  });

  it("14. levelsConsumed counts only levels actually touched", () => {
    const r = walkBuyDepth([{ price: 0.4, size: 100 }, { price: 0.9, size: 100 }], 5); // fully satisfied by the first level alone
    expect(r.levelsConsumed).toBe(1);
  });

  it("15/16. raw price impact and priceImpactCents are correct", () => {
    const r = walkBuyDepth([{ price: 0.4, size: 10 }, { price: 0.5, size: 100 }], 5);
    const expectedImpact = 5 / 12 - 0.4;
    expect(r.priceImpact).toBeCloseTo(expectedImpact, 9);
    expect(r.priceImpactCents).toBeCloseTo(expectedImpact * 100, 9);
  });

  it("a single-level full fill has zero price impact", () => {
    const r = walkBuyDepth([{ price: 0.5, size: 100 }], 5);
    expect(r.priceImpact).toBeCloseTo(0, 9);
  });
});

describe("ordering / duplicates", () => {
  it("17. unsorted asks execute best-first regardless of stored order", () => {
    const levels = [{ price: 0.5, size: 1 }, { price: 0.41, size: 1 }, { price: 0.45, size: 1 }];
    const r = walkBuyDepth(levels, 100); // exhaust everything to observe consumption order via worstExecutionPrice progression
    expect(r.bestAvailablePrice).toBe(0.41);
  });

  it("18. the caller's input array/objects are never mutated", () => {
    const levels: DepthLevel[] = [{ price: 0.5, size: 1 }, { price: 0.4, size: 1 }];
    const snapshot = JSON.parse(JSON.stringify(levels));
    walkBuyDepth(levels, 5);
    expect(levels).toEqual(snapshot);
  });

  it("19/20. duplicate-price levels are aggregated deterministically and do not distort VWAP", () => {
    const levels = [{ price: 0.5, size: 5 }, { price: 0.5, size: 5 }]; // same price, two rows -> should behave identically to one row of size 10
    const aggregated = walkBuyDepth(levels, 5);
    const single = walkBuyDepth([{ price: 0.5, size: 10 }], 5);
    expect(aggregated.averageExecutionPrice).toBeCloseTo(single.averageExecutionPrice!, 9);
    expect(aggregated.levelsConsumed).toBe(1); // aggregated into one distinct price point
    expect(aggregated.contractsFilled).toBeCloseTo(single.contractsFilled, 9);
  });
});

describe("precision", () => {
  it("21. price 0.1234 is preserved exactly through execution (no cent rounding)", () => {
    const r = walkBuyDepth([{ price: 0.1234, size: 100 }], 5);
    // bestAvailablePrice is the raw input value, never subjected to arithmetic -- exact.
    expect(r.bestAvailablePrice).toBe(0.1234);
    // averageExecutionPrice is a derived division (5 / (5/0.1234)) -- per the mission,
    // derived VWAP values use tolerance, not exact equality (1-ULP float round-trip).
    expect(r.averageExecutionPrice).toBeCloseTo(0.1234, 9);
  });

  it("22. fractional quantity 301.17 is preserved (not rounded to whole contracts)", () => {
    const r = walkBuyDepth([{ price: 0.1234, size: 301.17 }], 5);
    // level capacity = 0.1234 * 301.17 ≈ 37.16 >> 5, so fully filled within this one level
    expect(r.status).toBe("FULL");
    expect(r.contractsFilled).toBeCloseTo(5 / 0.1234, 9);
  });

  it("23. sub-cent price impact survives (0.0005 does not collapse to 0)", () => {
    const r = walkBuyDepth([{ price: 0.5001, size: 3 }, { price: 0.5011, size: 100 }], 5);
    expect(r.priceImpact).toBeGreaterThan(0);
    expect(r.priceImpact).toBeLessThan(0.001);
  });

  it("24. 0.5001 and 0.5002 remain distinguishable as separate levels", () => {
    // $0.30 requested is within level 1's own capacity (0.5001 * 1 = $0.5001), so it
    // must be satisfied entirely by the better-priced level -- proving 0.5001 and 0.5002
    // are tracked as genuinely distinct price points, not collapsed to a shared 0.50.
    const r = walkBuyDepth([{ price: 0.5002, size: 1 }, { price: 0.5001, size: 1 }], 0.3);
    expect(r.bestAvailablePrice).toBe(0.5001);
    expect(r.levelsConsumed).toBe(1);
    expect(r.worstExecutionPrice).toBe(0.5001);
  });

  it("25. no cent rounding is applied anywhere in the walk", () => {
    const r = walkBuyDepth([{ price: 0.1233, size: 1 }, { price: 0.1234, size: 100 }], 1);
    // both prices would round to the same cent (0.12) -- if cent-rounded, level order/impact would collapse; verify they don't.
    expect(r.bestAvailablePrice).toBe(0.1233);
    expect(r.worstExecutionPrice).not.toBe(r.bestAvailablePrice);
  });

  it("26. a repeating-decimal VWAP (1/3-style) is handled with appropriate tolerance, not truncated", () => {
    const r = walkBuyDepth([{ price: 0.3, size: 10 }, { price: 0.6, size: 10 }, { price: 0.9, size: 10 }], 9); // 3+6=9 exactly across two levels -> not actually repeating, use a genuinely repeating case below
    expect(r.status).toBe("FULL");
    const repeating = walkBuyDepth([{ price: 1 / 3, size: 30 }], 10); // 1/3 * 30 = 10 exactly
    expect(repeating.status).toBe("FULL");
    expect(repeating.averageExecutionPrice).toBeCloseTo(1 / 3, 9);
  });

  it("27. floating dust does not turn an exact full fill into PARTIAL", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; construct a case whose naive summation drifts by dust.
    const levels = [{ price: 0.1, size: 10 }, { price: 0.2, size: 10 }]; // 1.0 + 2.0 = 3.0 requested
    const r = walkBuyDepth(levels, 3);
    expect(r.status).toBe("FULL");
    expect(r.unfilledNotionalUsd).toBe(0);
    expect(r.filledNotionalUsd).toBe(3);
  });
});

describe("validation — fails closed, never silently clamps", () => {
  it("28. price 0 is rejected", () => {
    expect(walkBuyDepth([{ price: 0, size: 1 }], 5).status).toBe("INVALID");
  });
  it("29. price > 1 is rejected", () => {
    expect(walkBuyDepth([{ price: 1.5, size: 1 }], 5).status).toBe("INVALID");
  });
  it("30. negative price is rejected", () => {
    expect(walkBuyDepth([{ price: -0.5, size: 1 }], 5).status).toBe("INVALID");
  });
  it("31. NaN price is rejected", () => {
    expect(walkBuyDepth([{ price: Number.NaN, size: 1 }], 5).status).toBe("INVALID");
  });
  it("32. Infinity price is rejected", () => {
    expect(walkBuyDepth([{ price: Number.POSITIVE_INFINITY, size: 1 }], 5).status).toBe("INVALID");
  });
  it("33. zero quantity is rejected", () => {
    expect(walkBuyDepth([{ price: 0.5, size: 0 }], 5).status).toBe("INVALID");
  });
  it("34. negative quantity is rejected", () => {
    expect(walkBuyDepth([{ price: 0.5, size: -1 }], 5).status).toBe("INVALID");
  });
  it("35. NaN quantity is rejected", () => {
    expect(walkBuyDepth([{ price: 0.5, size: Number.NaN }], 5).status).toBe("INVALID");
  });
  it("36. Infinity quantity is rejected", () => {
    expect(walkBuyDepth([{ price: 0.5, size: Number.POSITIVE_INFINITY }], 5).status).toBe("INVALID");
  });
  it("37. zero requested notional is rejected", () => {
    expect(walkBuyDepth([{ price: 0.5, size: 1 }], 0).status).toBe("INVALID");
  });
  it("38. negative requested notional is rejected", () => {
    expect(walkBuyDepth([{ price: 0.5, size: 1 }], -5).status).toBe("INVALID");
  });
  it("39. NaN/Infinity requested notional is rejected", () => {
    expect(walkBuyDepth([{ price: 0.5, size: 1 }], Number.NaN).status).toBe("INVALID");
    expect(walkBuyDepth([{ price: 0.5, size: 1 }], Number.POSITIVE_INFINITY).status).toBe("INVALID");
  });
  it("40. one malformed level among otherwise-valid levels invalidates the ENTIRE walk (fail closed, never quietly excluded)", () => {
    const r = walkBuyDepth([{ price: 0.5, size: 10 }, { price: Number.NaN, size: 5 }, { price: 0.4, size: 10 }], 5);
    expect(r.status).toBe("INVALID");
    expect(r.invalidReason).toMatch(/level 1/);
    // the otherwise-abundant valid depth (0.5 and 0.4 levels) must NOT be silently used.
    expect(r.filledNotionalUsd).toBe(0);
  });
});

describe("evaluateNotionalTiers — tier evaluation", () => {
  it("41. tiers are exactly [5,10,25,50,100]", () => {
    expect(SPORTS_SHADOW_NOTIONALS_USD).toEqual([5, 10, 25, 50, 100]);
  });

  it("42. exactly five results are produced", () => {
    const results = evaluateNotionalTiers([{ price: 0.5, size: 1000 }]);
    expect(Object.keys(results)).toHaveLength(5);
  });

  it("43/CRITICAL. the $10 evaluation does not see depth already consumed by the hypothetical $5 evaluation — each tier starts from the same original snapshot", () => {
    const levels: DepthLevel[] = [{ price: 0.5, size: 10 }]; // exactly $5 of capacity
    const results = evaluateNotionalTiers(levels);
    // $5 tier: fully filled using all $5 of capacity.
    expect(results[5].status).toBe("FULL");
    expect(results[5].filledNotionalUsd).toBe(5);
    // $10 tier: if it had seen the $5 tier's "depleted" book, it would see 0 capacity left.
    // Instead it must independently see the SAME full $5 of capacity from the original book.
    expect(results[10].status).toBe("PARTIAL");
    expect(results[10].filledNotionalUsd).toBeCloseTo(5, 9); // not 0
    // Directly compare against a standalone call on the pristine array, proving no cross-tier state leaked.
    const standalone10 = walkBuyDepth(levels, 10);
    expect(results[10]).toEqual(standalone10);
  });

  it("44. $5 tier is correct", () => {
    const results = evaluateNotionalTiers([{ price: 0.5, size: 1000 }]);
    expect(results[5].status).toBe("FULL");
    expect(results[5].requestedNotionalUsd).toBe(5);
  });
  it("45. $10 tier is correct", () => {
    const results = evaluateNotionalTiers([{ price: 0.5, size: 1000 }]);
    expect(results[10].status).toBe("FULL");
    expect(results[10].requestedNotionalUsd).toBe(10);
  });
  it("46. $25 tier is correct", () => {
    const results = evaluateNotionalTiers([{ price: 0.5, size: 1000 }]);
    expect(results[25].status).toBe("FULL");
    expect(results[25].requestedNotionalUsd).toBe(25);
  });
  it("47. $50 tier is correct", () => {
    const results = evaluateNotionalTiers([{ price: 0.5, size: 1000 }]);
    expect(results[50].status).toBe("FULL");
    expect(results[50].requestedNotionalUsd).toBe(50);
  });
  it("48. $100 tier is correct", () => {
    const results = evaluateNotionalTiers([{ price: 0.5, size: 1000 }]);
    expect(results[100].status).toBe("FULL");
    expect(results[100].requestedNotionalUsd).toBe(100);
  });

  it("49. insufficient depth yields progressively lower fill ratio for larger tiers", () => {
    const results = evaluateNotionalTiers([{ price: 0.5, size: 20 }]); // total capacity = $10
    expect(results[5].fillRatio).toBeCloseTo(1, 9);
    expect(results[10].fillRatio).toBeCloseTo(1, 9);
    expect(results[25].fillRatio).toBeCloseTo(10 / 25, 9);
    expect(results[50].fillRatio).toBeCloseTo(10 / 50, 9);
    expect(results[100].fillRatio).toBeCloseTo(10 / 100, 9);
    // strictly non-increasing as notional grows past the capacity point
    expect(results[25].fillRatio).toBeGreaterThan(results[50].fillRatio);
    expect(results[50].fillRatio).toBeGreaterThan(results[100].fillRatio);
  });

  it("50. no tier mutates another tier's result or the shared input", () => {
    const levels: DepthLevel[] = [{ price: 0.5, size: 20 }];
    const snapshot = JSON.parse(JSON.stringify(levels));
    const results = evaluateNotionalTiers(levels);
    expect(levels).toEqual(snapshot); // input untouched
    // re-run and confirm identical results (no hidden state carried between calls)
    const results2 = evaluateNotionalTiers(levels);
    expect(results).toEqual(results2);
  });
});

describe("CODEX P1-3: walkSellDepth -- EXIT-side bid walk, denominated in contracts not USD", () => {
  it("single-level full fill: sells exactly the requested contracts at the best (highest) bid", () => {
    const r = walkSellDepth([{ price: 0.5, size: 100 }], 10);
    expect(r.status).toBe("FULL");
    expect(r.filledContracts).toBeCloseTo(10, 9);
    expect(r.proceedsUsd).toBeCloseTo(5, 9);
    expect(r.averageExecutionPrice).toBeCloseTo(0.5, 9);
  });

  it("multi-level: walks the HIGHEST bid first, then progressively worse (lower) bids -- the mirror of walkBuyDepth's ascending ask sort", () => {
    const r = walkSellDepth(
      [
        { price: 0.4, size: 100 }, // worse bid -- must NOT be consumed first
        { price: 0.5, size: 5 }, // best bid -- consumed first
      ],
      10,
    );
    expect(r.status).toBe("FULL");
    expect(r.fills).toEqual([
      { price: 0.5, contracts: 5 },
      { price: 0.4, contracts: 5 },
    ]);
    expect(r.proceedsUsd).toBeCloseTo(0.5 * 5 + 0.4 * 5, 9);
  });

  it("partial fill: insufficient bid depth for the requested contract count", () => {
    const r = walkSellDepth([{ price: 0.5, size: 4 }], 10);
    expect(r.status).toBe("PARTIAL");
    expect(r.filledContracts).toBeCloseTo(4, 9);
    expect(r.unfilledContracts).toBeCloseTo(6, 9);
    expect(r.fillRatio).toBeCloseTo(0.4, 9);
  });

  it("no bid depth at all: NONE, never a fabricated fill", () => {
    const r = walkSellDepth([], 10);
    expect(r.status).toBe("NONE");
    expect(r.proceedsUsd).toBe(0);
  });

  it("priceImpact is the mirror sign of walkBuyDepth's -- a seller RECEIVES LESS as depth worsens, never more", () => {
    const r = walkSellDepth(
      [
        { price: 0.4, size: 100 },
        { price: 0.5, size: 5 },
      ],
      10,
    );
    expect(r.bestAvailablePrice).toBe(0.5);
    expect(r.averageExecutionPrice!).toBeLessThan(0.5);
    expect(r.priceImpact).toBeGreaterThan(0);
  });

  it("fails closed to INVALID on a malformed level or non-positive requested contract count", () => {
    expect(walkSellDepth([{ price: 1.5, size: 10 }], 5).status).toBe("INVALID");
    expect(walkSellDepth([{ price: 0.5, size: 10 }], 0).status).toBe("INVALID");
    expect(walkSellDepth([{ price: 0.5, size: 10 }], -5).status).toBe("INVALID");
  });

  it("fills are directly consumable by fees.ts's computeTakerFeeForFills -- same ConsumedLevel shape as walkBuyDepth", () => {
    const r = walkSellDepth([{ price: 0.5, size: 100 }], 10);
    expect(r.fills[0]).toEqual({ price: 0.5, contracts: 10 });
  });
});

describe("safety / scope", () => {
  it("51/52/53/54/55/56/57. this module contains no venue branching, network/Supabase imports, fee schedule, order API, or Task 10/11 concerns", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(path.resolve(import.meta.dirname, "depth-walk.ts"), "utf8");
    expect(src).not.toMatch(/venue\s*===\s*["']KALSHI["']|venue\s*===\s*["']PMUS["']/);
    const importLines = [...src.matchAll(/^import .*$/gm)].map((m) => m[0]);
    for (const line of importLines) {
      expect(line).not.toMatch(/supabase|fetch|http-rate-limit|pmus\.server|kalshi\.server|credentials|signer/i);
    }
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of ["fee", "Fee", "createOrder", "cancelOrder", "previewOrder", "wallet", "scheduler", "cron"]) {
      expect(stripped).not.toContain(forbidden);
    }
  });
});
