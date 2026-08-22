/**
 * FINAL BUILD Part 16: correlation/independence clustering — PURE math only.
 *
 * The system already collapses one wallet's own DCA fills into ONE episode
 * (episode.ts's AGGREGATION_WINDOW_SECONDS). This module addresses the DIFFERENT
 * problem the mission explicitly calls out: multiple wallets (or the same wallet
 * across separate episodes) trading around the SAME underlying sports event are not
 * automatically independent global observations for statistical purposes, even though
 * each is a perfectly legitimate, separate wallet-level signal worth tracking on its
 * own. Clustering here is deliberately at the GAME level (away team + home team +
 * scheduled start time, doubleheader-safe since two games between the same teams on
 * the same day have distinct start times) rather than at the specific
 * contract/side/line level: opposite sides of the same game are still outcomes of the
 * identical underlying random event, so the mission's own "100 correlated copies of
 * the same MLB game cannot masquerade as N=100 independent bets" bar is only genuinely
 * met by clustering at the event level, the most conservative (fewest independent
 * clusters) correct choice.
 */

export type ClusterableSignal = {
  signalId: string;
  awayTeam: string | null;
  homeTeam: string | null;
  /** ISO timestamp. Must be the SCHEDULED game start, not detection/fill time -- doubleheader games between the same two teams share teams but differ here. */
  scheduledStartAt: string | null;
};

/**
 * Returns null when the signal lacks enough identity to safely cluster (missing
 * team/schedule data) -- NEVER fabricates a cluster key from partial information. A
 * null-keyed signal is treated as its own singleton cluster by computeIndependence
 * (see that function's doc comment for why fail-open, not fail-closed, is the correct
 * default here).
 */
export function computeClusterKey(signal: ClusterableSignal): string | null {
  if (!signal.awayTeam || !signal.homeTeam || !signal.scheduledStartAt) return null;
  return `${signal.awayTeam.trim().toLowerCase()}|${signal.homeTeam.trim().toLowerCase()}|${signal.scheduledStartAt}`;
}

export type ClusterInfo = { clusterKey: string; episodeCount: number; signalIds: string[] };

export type IndependenceSummary = {
  /** Total episodes considered -- one row per sports_shadow_signals episode, exactly what the raw milestone counter already tracks today. */
  rawEpisodeCount: number;
  /**
   * The number the mission's 100/300 milestones actually refer to: one count per
   * DISTINCT cluster (game), never per raw episode. A game with 12 correlated wallet
   * signals contributes exactly 1 to this number, not 12.
   */
  independentEpisodeCount: number;
  clusters: ClusterInfo[];
  /**
   * Signals lacking identity to cluster (missing team/schedule data) are counted as
   * their own singleton clusters -- NOT merged into one giant "unknown" cluster (which
   * would incorrectly treat two genuinely unrelated games as correlated) and NOT
   * silently dropped from the independent count (which would understate the sample).
   * Their count is surfaced separately so a large value is visible as a data-quality
   * signal in its own right.
   */
  unclusterableCount: number;
};

export function computeIndependence(signals: readonly ClusterableSignal[]): IndependenceSummary {
  const byCluster = new Map<string, string[]>();
  let unclusterableCount = 0;
  let singletonSeq = 0;

  for (const signal of signals) {
    const key = computeClusterKey(signal);
    if (key === null) {
      unclusterableCount += 1;
      singletonSeq += 1;
      byCluster.set(`__unclusterable_${singletonSeq}_${signal.signalId}`, [signal.signalId]);
      continue;
    }
    const list = byCluster.get(key);
    if (list) list.push(signal.signalId);
    else byCluster.set(key, [signal.signalId]);
  }

  const clusters: ClusterInfo[] = [...byCluster.entries()].map(([clusterKey, signalIds]) => ({
    clusterKey,
    episodeCount: signalIds.length,
    signalIds,
  }));

  return {
    rawEpisodeCount: signals.length,
    independentEpisodeCount: clusters.length,
    clusters,
    unclusterableCount,
  };
}
