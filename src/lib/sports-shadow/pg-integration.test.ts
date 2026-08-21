/**
 * Task 12C: real PostgREST/Supabase-JS integration harness for the Sports Forward
 * Shadow subsystem, exercising the ACTUAL exported repository objects (never a fake) —
 * supabaseObservationRepository (Task 8), supabasePollRepository (Task 10),
 * supabaseWorkerRepository (Task 11), supabaseSportsLeaseRepository (Task 11 lease) —
 * against a REAL local Supabase/Postgres instance.
 *
 * CI-ONLY: skipped entirely unless SPORTS_SHADOW_PG_INTEGRATION=1 (set only by the
 * schema-contract GitHub Actions job, after `supabase start` + `supabase db reset
 * --local`). A plain `bun run test` locally never touches this file's bodies — this
 * Chromebook must never run `supabase start` per established session guidance.
 *
 * No public Polymarket/PM-US/Kalshi network calls anywhere in this file — every
 * book-fetch dependency is an injected fake, matching the mission's explicit
 * instruction. Only the Supabase/Postgres calls themselves are real.
 */
import { describe, expect, it } from "vitest";

const RUN = process.env["SPORTS_SHADOW_PG_INTEGRATION"] === "1";

describe.skipIf(!RUN)("Task 12C: real PostgREST integration (Sports Forward Shadow)", () => {
  function uniqueId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  describe("Task 8: supabaseObservationRepository + takeDueSportsShadowObservations", () => {
    it("EXACT match persists, schedules exactly five observation rows at the five legal delays; findDueObservations' embedded sports_market_matches(target_market_id, selected_side) relationship resolves target_market_id + selected_side; retry schedules zero duplicates; not-yet-due/observed rows excluded; oldest fire_at first; CAS terminal write succeeds exactly once", async () => {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { persistVenueMatch, takeDueSportsShadowObservations, supabaseObservationRepository } = await import("./observation.server");

      const signalId = uniqueId("sig");
      const wallet = "0x" + "1".repeat(40);
      const fillKey = uniqueId("fill");

      const { data: fill, error: fillErr } = await supabaseAdmin
        .from("sports_shadow_source_fills" as never)
        .insert({ event_key: fillKey, wallet, asset: "0xasset", side: "BUY", source_ts: 1, identity_basis: "source_id" } as never)
        .select("id")
        .single();
      if (fillErr) throw new Error(fillErr.message);
      const fillId = (fill as unknown as { id: string }).id;

      const { data: signal, error: signalErr } = await supabaseAdmin
        .from("sports_shadow_signals" as never)
        .insert({
          episode_key: uniqueId("episode"),
          source_wallet: wallet,
          source_asset: "0xasset",
          first_fill_id: fillId,
          source_first_fill_at: new Date().toISOString(),
          source_last_fill_at: new Date().toISOString(),
          bet_type: "MONEYLINE",
          selected_side: "TEAM",
        } as never)
        .select("id")
        .single();
      if (signalErr) throw new Error(signalErr.message);
      const realSignalId = (signal as unknown as { id: string }).id;

      const detectedAtMs = Date.now();
      const exactResult = {
        venue: "PMUS" as const,
        status: "EXACT" as const,
        reasonCode: "EXACT_MATCH" as const,
        reason: "integration test",
        sourceConditionId: "0xcondition",
        sourceMarketSlug: "slug",
        targetEventId: "ev-1",
        targetMarketId: "target-slug-123",
        targetFetchKey: "target-slug-123",
        targetGameIdentifier: "game-1",
        targetAwayTeam: "AWY",
        targetHomeTeam: "HOM",
        targetBetType: "MONEYLINE" as const,
        sourceLine: null,
        targetLine: null,
        sourceStartTime: null,
        targetStartTime: null,
        targetSide: { kind: "TEAM" as const, team: "AWY" },
        targetPmusOrientation: "LONG" as const,
        settlementCompatibility: "COMPATIBLE" as const,
        settlementProfile: { extraInnings: "EXACT_COMPATIBLE" as const, postponement: "EXACT_COMPATIBLE" as const, pushRisk: "EXACT_COMPATIBLE" as const },
        candidateCounts: { exact: 1, near: 0, unverified: 0, total: 1 },
        evidence: [],
      };

      const first = await persistVenueMatch(realSignalId, exactResult, detectedAtMs, new Date().toISOString(), null);
      expect(first.scheduled).toBe(5);

      // Retry: idempotent, zero new rows.
      const second = await persistVenueMatch(realSignalId, exactResult, detectedAtMs, new Date().toISOString(), null);
      expect(second.scheduled).toBe(0);

      // Force every scheduled row's fire_at into the past so all five are due right now.
      await supabaseAdmin
        .from("sports_quote_observations" as never)
        .update({ fire_at: new Date(Date.now() - 120_000).toISOString() } as never)
        .eq("signal_id", realSignalId);

      const { data: rowsBefore, error: rowsErr } = await supabaseAdmin
        .from("sports_quote_observations" as never)
        .select("requested_delay_ms")
        .eq("signal_id", realSignalId);
      if (rowsErr) throw new Error(rowsErr.message);
      expect(((rowsBefore ?? []) as unknown as { requested_delay_ms: number }[]).map((r) => r.requested_delay_ms).sort((a, b) => a - b)).toEqual([0, 5000, 10000, 30000, 60000]);

      // Exercise the real embedded PostgREST relationship query directly through the
      // real repository method (not a hand-rolled duplicate query).
      const due = await supabaseObservationRepository.findDueObservations("PMUS", new Date().toISOString(), 20);
      const dueForThisSignal = due.filter((d) => d.signalId === realSignalId);
      expect(dueForThisSignal).toHaveLength(5);
      for (const row of dueForThisSignal) {
        expect(row.targetFetchKey).toBe("target-slug-123"); // resolved via the embedded sports_market_matches(...) join
        expect(row.selectedSide).toBe("TEAM:AWY:LONG"); // Task 12G/P1-J: durable :LONG/:SHORT orientation suffix
      }
      // Oldest fire_at first.
      const fireAts = dueForThisSignal.map((r) => r.fireAt);
      expect([...fireAts].sort()).toEqual(fireAts);

      // Run the real collector with a fake (non-network) book fetcher.
      const fetchPmusBook = async () => ({ venue: "PMUS" as const, marketId: "x", bestBid: 0.5, bestAsk: 0.51, bidLevels: [], askLevels: [], marketStatus: null, observedAt: Date.now(), staleReason: null });
      const result = await takeDueSportsShadowObservations("PMUS", { fetchPmusBook }, 20);
      expect(result.captured).toBeGreaterThanOrEqual(5);

      // Verify CAS: every one of these five rows is now terminal (observed_at set),
      // and re-running the collector must not re-capture them (skipped/no-op, exactly-once write).
      const { data: after, error: afterErr } = await supabaseAdmin
        .from("sports_quote_observations" as never)
        .select("observed_at")
        .eq("signal_id", realSignalId);
      if (afterErr) throw new Error(afterErr.message);
      expect(((after ?? []) as unknown as { observed_at: string | null }[]).every((r) => r.observed_at !== null)).toBe(true);

      const secondPass = await takeDueSportsShadowObservations("PMUS", { fetchPmusBook }, 20);
      // The second pass may capture OTHER due rows from other concurrent test runs, but
      // must not double-count this signal's already-terminal rows -- verified by the
      // observed_at values being unchanged (single write per row).
      const { data: stillTerminal } = await supabaseAdmin
        .from("sports_quote_observations" as never)
        .select("observed_at")
        .eq("signal_id", realSignalId);
      expect(((stillTerminal ?? []) as unknown as { observed_at: string }[]).map((r) => r.observed_at)).toEqual(((after ?? []) as unknown as { observed_at: string }[]).map((r) => r.observed_at));
      void secondPass;

      // Cleanup (cascade removes matches + observations).
      await supabaseAdmin.from("sports_shadow_signals" as never).delete().eq("id", realSignalId);
      await supabaseAdmin.from("sports_shadow_source_fills" as never).delete().eq("id", fillId);
    }, 30_000);

    it("a lost CAS (already-claimed row) is not double-counted", async () => {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { buildTerminalFailurePatch } = await import("./observation");
      const { supabaseObservationRepository } = await import("./observation.server");

      const fillKey = uniqueId("fill-cas");
      const wallet = "0x" + "2".repeat(40);
      const { data: fill } = await supabaseAdmin
        .from("sports_shadow_source_fills" as never)
        .insert({ event_key: fillKey, wallet, asset: "0xasset", side: "BUY", source_ts: 1, identity_basis: "source_id" } as never)
        .select("id")
        .single();
      const fillId = (fill as unknown as { id: string }).id;
      const { data: signal } = await supabaseAdmin
        .from("sports_shadow_signals" as never)
        .insert({ episode_key: uniqueId("episode-cas"), source_wallet: wallet, source_asset: "0xasset", first_fill_id: fillId, source_first_fill_at: new Date().toISOString(), source_last_fill_at: new Date().toISOString(), bet_type: "MONEYLINE", selected_side: "TEAM" } as never)
        .select("id")
        .single();
      const realSignalId = (signal as unknown as { id: string }).id;
      const { data: match } = await supabaseAdmin
        .from("sports_market_matches" as never)
        .insert({ signal_id: realSignalId, venue: "PMUS", match_status: "EXACT", first_match_status: "EXACT" } as never)
        .select("id")
        .single();
      const matchId = (match as unknown as { id: string }).id;
      const { data: obs } = await supabaseAdmin
        .from("sports_quote_observations" as never)
        .insert({ signal_id: realSignalId, match_id: matchId, venue: "PMUS", requested_delay_ms: 0, source_timestamp: new Date().toISOString(), fire_at: new Date().toISOString() } as never)
        .select("id")
        .single();
      const obsId = (obs as unknown as { id: string }).id;

      const patch = buildTerminalFailurePatch(Date.now(), "TEST_FAILURE", "integration test", new Date().toISOString(), 0);
      const firstClaim = await supabaseObservationRepository.claimObservationTerminal(obsId, patch);
      expect(firstClaim).toBe(true);
      const secondClaim = await supabaseObservationRepository.claimObservationTerminal(obsId, patch);
      expect(secondClaim).toBe(false); // CAS loses cleanly the second time

      await supabaseAdmin.from("sports_shadow_signals" as never).delete().eq("id", realSignalId);
      await supabaseAdmin.from("sports_shadow_source_fills" as never).delete().eq("id", fillId);
    }, 20_000);
  });

  describe("Task 10: supabasePollRepository", () => {
    it("raw fill insert succeeds and is idempotent on duplicate event_key; reliable-key lookup; degraded-ordinal count; signal insert; findLatestEpisode resolves its anchor event_key through the sports_shadow_source_fills!first_fill_id(event_key) embedded relationship; episode update round-trips only the currently-schema-represented BUY fields", async () => {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { supabasePollRepository } = await import("./source-poll.server");

      const wallet = "0x" + "3".repeat(40);
      const eventKey = uniqueId("sid:fill");
      const insertResult = await supabasePollRepository.insertRawFill({
        eventKey,
        wallet,
        walletHandle: null,
        conditionId: "0xcondition",
        asset: "0xasset",
        marketTitle: "Test Market",
        outcome: "AWY",
        eventSlug: null,
        marketSlug: null,
        side: "BUY",
        shares: 10,
        price: 0.5,
        sourceTs: 1_700_000_000,
        identityBasis: "source_id",
        identityDegraded: false,
        raw: { test: true },
      });
      expect(insertResult.inserted).toBe(true);
      const dup = await supabasePollRepository.insertRawFill({
        eventKey,
        wallet,
        walletHandle: null,
        conditionId: "0xcondition",
        asset: "0xasset",
        marketTitle: "Test Market",
        outcome: "AWY",
        eventSlug: null,
        marketSlug: null,
        side: "BUY",
        shares: 10,
        price: 0.5,
        sourceTs: 1_700_000_000,
        identityBasis: "source_id",
        identityDegraded: false,
        raw: { test: true },
      });
      expect(dup.inserted).toBe(false);
      expect(dup.id).toBe(insertResult.id);

      const reliable = await supabasePollRepository.findExistingEventKeys(wallet, [eventKey, "sid:does-not-exist"]);
      expect(reliable.has(eventKey)).toBe(true);
      expect(reliable.has("sid:does-not-exist")).toBe(false);

      const ordinalPrefix = `ord:0xtx-integration:0xasset:BUY:1700000100:5:0.5#`;
      await supabasePollRepository.insertRawFill({
        eventKey: `${ordinalPrefix}0`,
        wallet,
        walletHandle: null,
        conditionId: "0xcondition",
        asset: "0xasset",
        marketTitle: "Test Market",
        outcome: "AWY",
        eventSlug: null,
        marketSlug: null,
        side: "BUY",
        shares: 5,
        price: 0.5,
        sourceTs: 1_700_000_100,
        identityBasis: "tx_hash_ordinal",
        identityDegraded: true,
        raw: {},
      });
      const counts = await supabasePollRepository.countDurableOrdinalFills(wallet, [ordinalPrefix]);
      expect(counts.get(ordinalPrefix)).toBe(1);

      const newEpisode = await supabasePollRepository.insertEpisodeAtomic(insertResult.id, {
        episodeKey: uniqueId("episode-t10"),
        wallet,
        walletHandle: null,
        conditionId: "0xcondition",
        asset: "0xasset",
        firstFillAtIso: new Date(1_700_000_000 * 1000).toISOString(),
        lastFillAtIso: new Date(1_700_000_000 * 1000).toISOString(),
        vwap: 0.5,
        shares: 10,
        notional: 5,
        fillCount: 1,
        sellSeen: false,
        league: "MLB",
        scheduledStartAt: null,
        awayTeam: "AWY",
        homeTeam: "HOM",
        betType: "MONEYLINE",
        selectedSide: "AWY",
        line: null,
        sourceEventSlug: null,
        sourceMarketSlug: null,
        sourceOutcome: "AWY",
      });

      const latest = await supabasePollRepository.findLatestEpisode(wallet, "0xcondition", "0xasset");
      expect(latest).not.toBeNull();
      expect(latest?.id).toBe(newEpisode.id);
      // Proves the sports_shadow_source_fills!first_fill_id(event_key) embedded
      // relationship genuinely resolves against the real schema.
      expect(latest?.state.anchorEventKey).toBe(eventKey);
      expect(latest?.state.totalShares).toBe(10);
      expect(latest?.state.vwap).toBeCloseTo(0.5);
      // No assumption that first_sell_at/last_sell_at/sell_count exist on the schema --
      // only the boolean sellSeen is round-tripped, matching the documented limitation.
      expect(latest?.state.sellSeen).toBe(false);
      expect(latest?.state.firstSellAt).toBeNull();
      expect(latest?.state.lastSellAt).toBeNull();
      expect(latest?.state.sellCount).toBe(0);

      // insertEpisodeAtomic must have atomically marked the anchor fill COMPLETE (Task 12D/P1-A).
      const { data: anchorFillRow } = await supabaseAdmin.from("sports_shadow_source_fills" as never).select("downstream_status").eq("id", insertResult.id).single();
      expect((anchorFillRow as unknown as { downstream_status: string }).downstream_status).toBe("COMPLETE");

      await supabasePollRepository.updateEpisodeAtomic(insertResult.id, newEpisode.id, { ...latest!.state, totalShares: 20, vwap: 0.6, buyFillCount: 2, sellSeen: true });
      const afterUpdate = await supabasePollRepository.findLatestEpisode(wallet, "0xcondition", "0xasset");
      expect(afterUpdate?.state.totalShares).toBe(20);
      expect(afterUpdate?.state.vwap).toBeCloseTo(0.6);
      expect(afterUpdate?.state.sellSeen).toBe(true);

      const hasAny = await supabasePollRepository.hasAnyFillsForWallet(wallet);
      expect(hasAny).toBe(true);

      await supabaseAdmin.from("sports_shadow_signals" as never).delete().eq("source_wallet", wallet);
      await supabaseAdmin.from("sports_shadow_source_fills" as never).delete().eq("wallet", wallet);
    }, 30_000);

    it("Task 12D/P1-A HARD DESIGN GATE, real Postgres: a failed insertEpisodeAtomic call rolls back BOTH the episode insert and the fill's downstream_status together (real transactional proof, not a fake's approximation)", async () => {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { supabasePollRepository } = await import("./source-poll.server");

      const wallet = "0x" + "5".repeat(40);
      const eventKey = uniqueId("sid:fill-gate");
      const insertResult = await supabasePollRepository.insertRawFill({
        eventKey,
        wallet,
        walletHandle: null,
        conditionId: "0xcondition",
        asset: "0xasset",
        marketTitle: "Test Market",
        outcome: "AWY",
        eventSlug: null,
        marketSlug: null,
        side: "BUY",
        shares: 10,
        price: 0.5,
        sourceTs: 1_700_000_000,
        identityBasis: "source_id",
        identityDegraded: false,
        raw: {},
      });

      // Deliberately violate the CHECK constraint on bet_type so the RPC's INSERT fails
      // partway through its own transaction -- proving the REAL database rolls back the
      // whole function call, not just the JS layer's happy-path assumption.
      await expect(
        supabasePollRepository.insertEpisodeAtomic(insertResult.id, {
          episodeKey: uniqueId("episode-gate"),
          wallet,
          walletHandle: null,
          conditionId: "0xcondition",
          asset: "0xasset",
          firstFillAtIso: new Date().toISOString(),
          lastFillAtIso: new Date().toISOString(),
          vwap: 0.5,
          shares: 10,
          notional: 5,
          fillCount: 1,
          sellSeen: false,
          league: "MLB",
          scheduledStartAt: null,
          awayTeam: "AWY",
          homeTeam: "HOM",
          betType: "INVALID_BET_TYPE" as never,
          selectedSide: "AWY",
          line: null,
          sourceEventSlug: null,
          sourceMarketSlug: null,
          sourceOutcome: "AWY",
        }),
      ).rejects.toThrow();

      // Neither side effect landed: no episode row, and the fill is still PENDING.
      const { data: episodeRows } = await supabaseAdmin.from("sports_shadow_signals" as never).select("id").eq("source_wallet", wallet);
      expect(((episodeRows ?? []) as unknown[]).length).toBe(0);
      const { data: fillRow } = await supabaseAdmin.from("sports_shadow_source_fills" as never).select("downstream_status").eq("id", insertResult.id).single();
      expect((fillRow as unknown as { downstream_status: string }).downstream_status).toBe("PENDING");

      await supabaseAdmin.from("sports_shadow_source_fills" as never).delete().eq("id", insertResult.id);
    }, 20_000);

    it("findPendingDownstreamFills returns only PENDING fills for the wallet, oldest source_ts first, bounded", async () => {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { supabasePollRepository } = await import("./source-poll.server");
      const wallet = "0x" + "6".repeat(40);

      const older = await supabasePollRepository.insertRawFill({
        eventKey: uniqueId("sid:older"), wallet, walletHandle: null, conditionId: "0xcondition", asset: "0xasset",
        marketTitle: "M", outcome: "AWY", eventSlug: null, marketSlug: null, side: "BUY", shares: 1, price: 0.5,
        sourceTs: 1_700_000_000, identityBasis: "source_id", identityDegraded: false, raw: {},
      });
      const newer = await supabasePollRepository.insertRawFill({
        eventKey: uniqueId("sid:newer"), wallet, walletHandle: null, conditionId: "0xcondition", asset: "0xasset",
        marketTitle: "M", outcome: "AWY", eventSlug: null, marketSlug: null, side: "BUY", shares: 1, price: 0.5,
        sourceTs: 1_700_000_100, identityBasis: "source_id", identityDegraded: false, raw: {},
      });
      await supabasePollRepository.markFillTerminal(newer.id, "TERMINAL_INVALID"); // no longer PENDING

      const pending = await supabasePollRepository.findPendingDownstreamFills(wallet, 10);
      expect(pending.map((p) => p.id)).toEqual([older.id]); // newer excluded (terminal), older included, oldest-first trivially satisfied

      await supabaseAdmin.from("sports_shadow_source_fills" as never).delete().eq("wallet", wallet);
    }, 20_000);
  });

  describe("Task 11: supabaseWorkerRepository.findPendingSignalsForVenue (RPC application-mapping semantics, Task 12D/P1-C venue-scoped)", () => {
    it("maps missing_pmus/missing_kalshi correctly from find_pending_sports_shadow_signals(p_venue, p_limit) and respects the caller-supplied limit, per venue independently", async () => {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { supabaseWorkerRepository } = await import("./worker.server");

      const wallet = "0x" + "4".repeat(40);
      const fillKey = uniqueId("fill-t11");
      const { data: fill } = await supabaseAdmin
        .from("sports_shadow_source_fills" as never)
        .insert({ event_key: fillKey, wallet, asset: "0xasset", side: "BUY", source_ts: 1, identity_basis: "source_id" } as never)
        .select("id")
        .single();
      const fillId = (fill as unknown as { id: string }).id;
      const episodeKey = uniqueId("episode-t11");
      const { data: signal } = await supabaseAdmin
        .from("sports_shadow_signals" as never)
        .insert({ episode_key: episodeKey, source_wallet: wallet, source_asset: "0xasset", source_condition_id: "0xcondition", first_fill_id: fillId, source_first_fill_at: new Date().toISOString(), source_last_fill_at: new Date().toISOString(), bet_type: "MONEYLINE", selected_side: "AWY" } as never)
        .select("id")
        .single();
      const realSignalId = (signal as unknown as { id: string }).id;
      await supabaseAdmin.from("sports_market_matches" as never).insert({ signal_id: realSignalId, venue: "KALSHI", match_status: "EXACT", first_match_status: "EXACT" } as never);

      const pmusPending = await supabaseWorkerRepository.findPendingSignalsForVenue("PMUS", 1000);
      const ours = pmusPending.find((p) => p.id === realSignalId);
      expect(ours).toBeDefined();
      expect(ours?.missingPmus).toBe(true);
      expect(ours?.missingKalshi).toBe(false);
      expect(ours?.conditionId).toBe("0xcondition");
      expect(ours?.betType).toBe("MONEYLINE");

      // Task 12D/P1-C: this signal is already resolved for KALSHI, so the KALSHI-scoped
      // query must NOT return it -- proving the RPC genuinely filters per venue, not combined.
      const kalshiPending = await supabaseWorkerRepository.findPendingSignalsForVenue("KALSHI", 1000);
      expect(kalshiPending.find((p) => p.id === realSignalId)).toBeUndefined();

      const bounded = await supabaseWorkerRepository.findPendingSignalsForVenue("PMUS", 1);
      expect(bounded.length).toBeLessThanOrEqual(1);

      await supabaseAdmin.from("sports_shadow_signals" as never).delete().eq("id", realSignalId);
      await supabaseAdmin.from("sports_shadow_source_fills" as never).delete().eq("id", fillId);
    }, 20_000);

    it("Task 12D/P1-C real Postgres: a saturated PMUS-missing batch does not prevent an independent KALSHI-missing signal from being returned", async () => {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { supabaseWorkerRepository } = await import("./worker.server");
      const wallet = "0x" + "7".repeat(40);
      const fillIds: string[] = [];
      const signalIds: string[] = [];

      // 3 old signals missing ONLY PMUS (KALSHI already resolved).
      for (let i = 0; i < 3; i += 1) {
        const { data: fill } = await supabaseAdmin
          .from("sports_shadow_source_fills" as never)
          .insert({ event_key: uniqueId(`sid:pc-old-${i}`), wallet, asset: "0xasset", side: "BUY", source_ts: 1, identity_basis: "source_id" } as never)
          .select("id").single();
        const fillId = (fill as unknown as { id: string }).id;
        fillIds.push(fillId);
        const { data: signal } = await supabaseAdmin
          .from("sports_shadow_signals" as never)
          .insert({ episode_key: uniqueId(`ep-pc-old-${i}`), source_wallet: wallet, source_asset: "0xasset", source_condition_id: "0xcondition", first_fill_id: fillId, source_first_fill_at: new Date(2026, 0, 1 + i).toISOString(), source_last_fill_at: new Date().toISOString(), bet_type: "MONEYLINE", selected_side: "AWY", created_at: new Date(2026, 0, 1 + i).toISOString() } as never)
          .select("id").single();
        const sid = (signal as unknown as { id: string }).id;
        signalIds.push(sid);
        await supabaseAdmin.from("sports_market_matches" as never).insert({ signal_id: sid, venue: "KALSHI", match_status: "EXACT", first_match_status: "EXACT" } as never);
      }

      // 1 NEWER signal missing ONLY KALSHI.
      const { data: newerFill } = await supabaseAdmin
        .from("sports_shadow_source_fills" as never)
        .insert({ event_key: uniqueId("sid:pc-newer"), wallet, asset: "0xasset", side: "BUY", source_ts: 1, identity_basis: "source_id" } as never)
        .select("id").single();
      const newerFillId = (newerFill as unknown as { id: string }).id;
      fillIds.push(newerFillId);
      const { data: newerSignal } = await supabaseAdmin
        .from("sports_shadow_signals" as never)
        .insert({ episode_key: uniqueId("ep-pc-newer"), source_wallet: wallet, source_asset: "0xasset", source_condition_id: "0xcondition", first_fill_id: newerFillId, source_first_fill_at: new Date().toISOString(), source_last_fill_at: new Date().toISOString(), bet_type: "MONEYLINE", selected_side: "AWY", created_at: new Date(2026, 0, 10).toISOString() } as never)
        .select("id").single();
      const newerSignalId = (newerSignal as unknown as { id: string }).id;
      signalIds.push(newerSignalId);
      await supabaseAdmin.from("sports_market_matches" as never).insert({ signal_id: newerSignalId, venue: "PMUS", match_status: "EXACT", first_match_status: "EXACT" } as never);

      const pmusPending = await supabaseWorkerRepository.findPendingSignalsForVenue("PMUS", 1000);
      expect(pmusPending.map((p) => p.id)).toEqual(expect.arrayContaining(signalIds.slice(0, 3)));
      expect(pmusPending.find((p) => p.id === newerSignalId)).toBeUndefined(); // resolved for PMUS

      const kalshiPending = await supabaseWorkerRepository.findPendingSignalsForVenue("KALSHI", 1000);
      expect(kalshiPending.find((p) => p.id === newerSignalId)).toBeDefined(); // independent -- not blocked by PMUS backlog
      for (const oldId of signalIds.slice(0, 3)) expect(kalshiPending.find((p) => p.id === oldId)).toBeUndefined(); // already resolved for KALSHI

      await supabaseAdmin.from("sports_shadow_signals" as never).delete().in("id", signalIds);
      await supabaseAdmin.from("sports_shadow_source_fills" as never).delete().in("id", fillIds);
    }, 20_000);
  });

  describe("Task 12D/P1-B: wallet rotation cursor, real Postgres", () => {
    it("supabaseWorkerRepository.getWalletCursor/setWalletCursor round-trip through the real sports_shadow_wallet_cursor table", async () => {
      const { supabaseWorkerRepository } = await import("./worker.server");
      const before = await supabaseWorkerRepository.getWalletCursor();
      await supabaseWorkerRepository.setWalletCursor(before + 1);
      const after = await supabaseWorkerRepository.getWalletCursor();
      expect(after).toBe(before + 1);
      await supabaseWorkerRepository.setWalletCursor(before); // restore
    }, 15_000);
  });

  describe("Sports lease: supabaseSportsLeaseRepository (acquire_worker_lease)", () => {
    it("observation and source locks are independent; first owner acquires; a competing owner cannot acquire a live lease; clean release allows the next owner; fence increments; a stale owner cannot clobber a newer owner's lease", async () => {
      const { supabaseSportsLeaseRepository } = await import("./sports-lease.server");
      const obsLock = uniqueId("lock-obs");
      const srcLock = uniqueId("lock-src");

      const obsFence = await supabaseSportsLeaseRepository.acquire(obsLock, "worker-a", 5);
      const srcFence = await supabaseSportsLeaseRepository.acquire(srcLock, "worker-a", 5);
      expect(obsFence).not.toBeNull();
      expect(srcFence).not.toBeNull(); // independent lock ids never contend

      const competing = await supabaseSportsLeaseRepository.acquire(obsLock, "worker-b", 5);
      expect(competing).toBeNull(); // still held by worker-a

      await supabaseSportsLeaseRepository.release({ lockId: obsLock, workerId: "worker-a", fence: obsFence! }, { state: "idle", lastError: null });
      const nextOwnerFence = await supabaseSportsLeaseRepository.acquire(obsLock, "worker-c", 5);
      expect(nextOwnerFence).not.toBeNull();
      expect(nextOwnerFence).toBe(obsFence! + 1); // fence increments

      // Stale owner (worker-a, old fence) cannot release worker-c's newer lease.
      await supabaseSportsLeaseRepository.release({ lockId: obsLock, workerId: "worker-a", fence: obsFence! }, { state: "idle", lastError: null });
      const stillHeld = await supabaseSportsLeaseRepository.acquire(obsLock, "worker-d", 5);
      expect(stillHeld).toBeNull(); // worker-c's lease is still live -- the stale release was a no-op
    }, 20_000);
  });
});
