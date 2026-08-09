import { describe, expect, it } from "vitest";

import {
  decideResolution,
  decideResolutionWithGammaFallback,
  type GammaResolutionEvidence,
  type PublicMarketResolution,
} from "./settlement-core";

const YES = "yes-token";
const NO = "no-token";

function clob(winner: "YES" | "NO" | null = null): PublicMarketResolution {
  return {
    closed: true,
    tokens: [
      { tokenId: YES, outcome: "Yes", winner: winner === "YES" },
      { tokenId: NO, outcome: "No", winner: winner === "NO" },
    ],
  };
}

function gamma(prices: number[] = [0, 1]): GammaResolutionEvidence {
  return {
    closed: true,
    conditionId: "0xcondition",
    outcomes: ["Yes", "No"],
    outcomePrices: prices,
    clobTokenIds: [YES, NO],
  };
}

describe("settlement resolution verification", () => {
  it("keeps the canonical CLOB winner flag path unchanged", () => {
    expect(decideResolution(YES, clob("YES"))).toEqual({
      verified: true,
      won: true,
      outcome: "Yes",
      payoutPerShare: 1,
    });
  });

  it("uses exact terminal Gamma 1/0 evidence when a closed CLOB payload has no winner flag", () => {
    expect(decideResolutionWithGammaFallback(YES, clob(null), gamma([0, 1]))).toEqual({
      verified: true,
      won: false,
      outcome: "Yes",
      payoutPerShare: 0,
    });
    expect(decideResolutionWithGammaFallback(NO, clob(null), gamma([0, 1]))).toEqual({
      verified: true,
      won: true,
      outcome: "No",
      payoutPerShare: 1,
    });
  });

  it("fails closed when Gamma prices are not terminal", () => {
    expect(decideResolutionWithGammaFallback(YES, clob(null), gamma([0.01, 0.99]))).toEqual({
      verified: false,
      reason: "Gamma does not provide a single terminal 1/0 outcome",
    });
  });

  it("fails closed when Gamma has multiple winners or no winner", () => {
    expect(decideResolutionWithGammaFallback(YES, clob(null), gamma([1, 1]))).toEqual({
      verified: false,
      reason: "Gamma does not provide a single terminal 1/0 outcome",
    });
    expect(decideResolutionWithGammaFallback(YES, clob(null), gamma([0, 0]))).toEqual({
      verified: false,
      reason: "Gamma does not provide a single terminal 1/0 outcome",
    });
  });

  it("fails closed when the held token cannot be mapped", () => {
    expect(decideResolutionWithGammaFallback("other-token", clob(null), gamma([0, 1]))).toEqual({
      verified: false,
      reason: "Held asset is not part of the Gamma-resolved market",
    });
  });

  it("fails closed on mismatched or duplicate Gamma mappings", () => {
    const mismatched = { ...gamma(), outcomePrices: [1] };
    expect(decideResolutionWithGammaFallback(YES, clob(null), mismatched)).toEqual({
      verified: false,
      reason: "Gamma resolution arrays do not map 1:1",
    });

    const duplicate = { ...gamma(), clobTokenIds: [YES, YES] };
    expect(decideResolutionWithGammaFallback(YES, clob(null), duplicate)).toEqual({
      verified: false,
      reason: "Gamma resolution token mapping is invalid",
    });
  });

  it("never uses Gamma to override an open CLOB market", () => {
    const open: PublicMarketResolution = { ...clob(null), closed: false };
    expect(decideResolutionWithGammaFallback(YES, open, gamma([0, 1]))).toEqual({
      verified: false,
      reason: "Market is not closed",
    });
  });

  it("fails closed when Gamma token IDs do not match the CLOB token set", () => {
    const foreign = { ...gamma(), clobTokenIds: [YES, "other-token"] };
    expect(decideResolutionWithGammaFallback(YES, clob(null), foreign)).toEqual({
      verified: false,
      reason: "Gamma token IDs do not match the CLOB token set for this market",
    });
  });

  it("fails closed when CLOB and Gamma disagree on the held asset's outcome label", () => {
    const swapped = { ...gamma(), outcomes: ["No", "Yes"] };
    expect(decideResolutionWithGammaFallback(YES, clob(null), swapped)).toEqual({
      verified: false,
      reason: "CLOB and Gamma disagree on the outcome label for the held asset",
    });
  });

  it("never uses Gamma to override an open CLOB market (duplicate guard)", () => {
    const open: PublicMarketResolution = { ...clob(null), closed: false };
    expect(decideResolutionWithGammaFallback(YES, open, gamma([0, 1]))).toEqual({
      verified: false,
      reason: "Market is not closed",
    });
  });
});
