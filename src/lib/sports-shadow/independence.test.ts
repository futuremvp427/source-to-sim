import { describe, expect, it } from "vitest";

import { computeClusterKey, computeIndependence, type ClusterableSignal } from "./independence";

function sig(overrides: Partial<ClusterableSignal> = {}): ClusterableSignal {
  return {
    signalId: "s1",
    awayTeam: "NYY",
    homeTeam: "BAL",
    scheduledStartAt: "2026-08-19T22:35:00Z",
    ...overrides,
  };
}

describe("FINAL BUILD Part 16: independence clustering", () => {
  it("two wallets betting the SAME game collapse into ONE cluster, even on opposite sides -- clustering is at the game level, not the side/contract level", () => {
    const a = sig({ signalId: "wallet-a" });
    const b = sig({ signalId: "wallet-b" });
    expect(computeClusterKey(a)).toBe(computeClusterKey(b));
    const summary = computeIndependence([a, b]);
    expect(summary.rawEpisodeCount).toBe(2);
    expect(summary.independentEpisodeCount).toBe(1);
    expect(summary.clusters).toHaveLength(1);
    expect(summary.clusters[0]?.episodeCount).toBe(2);
  });

  it("100 correlated copies of the same MLB game do not masquerade as 100 independent episodes", () => {
    const signals = Array.from({ length: 100 }, (_, i) => sig({ signalId: `wallet-${i}` }));
    const summary = computeIndependence(signals);
    expect(summary.rawEpisodeCount).toBe(100);
    expect(summary.independentEpisodeCount).toBe(1);
  });

  it("different games (different scheduled start times) are genuinely different clusters", () => {
    const a = sig({ signalId: "s1", scheduledStartAt: "2026-08-19T22:35:00Z" });
    const b = sig({ signalId: "s2", scheduledStartAt: "2026-08-20T22:35:00Z" });
    const summary = computeIndependence([a, b]);
    expect(summary.independentEpisodeCount).toBe(2);
  });

  it("doubleheader safety: same two teams, same day, DIFFERENT scheduled start times are different clusters", () => {
    const game1 = sig({ signalId: "s1", scheduledStartAt: "2026-08-19T18:00:00Z" });
    const game2 = sig({ signalId: "s2", scheduledStartAt: "2026-08-19T22:00:00Z" });
    const summary = computeIndependence([game1, game2]);
    expect(summary.independentEpisodeCount).toBe(2);
  });

  it("a signal missing team/schedule identity is never fabricated into a cluster key, and never silently merged with another unknown signal", () => {
    const unknown1 = sig({ signalId: "u1", awayTeam: null });
    const unknown2 = sig({ signalId: "u2", homeTeam: null });
    expect(computeClusterKey(unknown1)).toBeNull();
    const summary = computeIndependence([unknown1, unknown2]);
    expect(summary.unclusterableCount).toBe(2);
    // Each counted as its OWN singleton cluster -- not merged together, not dropped.
    expect(summary.independentEpisodeCount).toBe(2);
    expect(summary.rawEpisodeCount).toBe(2);
  });

  it("team name comparison is case-insensitive and whitespace-trimmed (same underlying game reported inconsistently by different code paths)", () => {
    const a = sig({ signalId: "s1", awayTeam: "NYY", homeTeam: "BAL" });
    const b = sig({ signalId: "s2", awayTeam: " nyy ", homeTeam: "bal" });
    expect(computeClusterKey(a)).toBe(computeClusterKey(b));
  });

  it("mixed sample: some clustered, some independent, some unclusterable -- correct combined accounting", () => {
    const gameAWallet1 = sig({ signalId: "a1", scheduledStartAt: "2026-08-19T22:35:00Z" });
    const gameAWallet2 = sig({ signalId: "a2", scheduledStartAt: "2026-08-19T22:35:00Z" });
    const gameB = sig({ signalId: "b1", awayTeam: "LAD", homeTeam: "SD", scheduledStartAt: "2026-08-19T22:35:00Z" });
    const unknown = sig({ signalId: "u1", scheduledStartAt: null });
    const summary = computeIndependence([gameAWallet1, gameAWallet2, gameB, unknown]);
    expect(summary.rawEpisodeCount).toBe(4);
    expect(summary.independentEpisodeCount).toBe(3); // game A cluster (2), game B cluster (1), unknown singleton (1)
    expect(summary.unclusterableCount).toBe(1);
  });
});
