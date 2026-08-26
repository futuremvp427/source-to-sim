#!/usr/bin/env bun

/**
 * Weather Lab forward collector.
 *
 * Read-only. Snapshots live US weather markets with full depth, builds an
 * independent probability distribution from public weather feeds, prices the
 * net edge after fees and slippage, and simulates paper fills under every
 * adverse scenario.
 *
 * It never submits an order. There is no code path in this file, or anything it
 * imports, that can place a real trade.
 *
 * Output: research-output/weather-lab-collection.{md,json}. Persistence to
 * Supabase is intentionally a separate step so a collection run cannot be
 * blocked by, or corrupt, database state.
 */

import { mkdir, writeFile } from "node:fs/promises";

import { parseBucket, validateBucketSet, type RawKalshiMarket, type TemperatureBucket } from "../src/lib/weather-lab/buckets";
import { classifyStrategy, computeEdge, decideEntry, edgeUnderScenarios, type EntryGate } from "../src/lib/weather-lab/edge";
import { assertPaperOnly, freezeExperiment, type ExperimentConfig } from "../src/lib/weather-lab/experiment";
import { FEE_MODEL_VERSION, type FeeSchedule } from "../src/lib/weather-lab/fees";
import { noAskLadderFromYesBids, simulateAllScenarios, yesAskLadderFromNoBids } from "../src/lib/weather-lab/execution";
import { buildDistribution, distributionSum, type ModelForecast } from "../src/lib/weather-lab/probability";
import { admitAll, type ProvenancedDatum, type StalenessPolicy } from "../src/lib/weather-lab/provenance";
import { assessSettlement, settlementRuleFromKalshi } from "../src/lib/weather-lab/settlement";
import {
  fetchDeterministicForecasts,
  fetchEnsembleForecast,
  fetchObservedMax,
  forecastSigmaF,
  localDateFor,
  observationFloorApplies,
  SITES,
  type StationSite,
} from "../src/lib/weather-lab/sources";

const API = "https://api.elections.kalshi.com/trade-api/v2";
const SERIES: Record<string, string> = {
  NYC: "KXHIGHNY",
  Chicago: "KXHIGHCHI",
  LosAngeles: "KXHIGHLAX",
  SanFrancisco: "KXHIGHTSFO",
  Miami: "KXHIGHMIA",
};

const ENABLED_CITIES = (process.env["WEATHER_LAB_CITIES"] ?? "NYC").split(",").map((c) => c.trim()).filter(Boolean);
const POSITION_CONTRACTS = Number(process.env["WEATHER_LAB_CONTRACTS"] ?? "100");

/**
 * FROZEN research configuration.
 *
 * These thresholds are pre-registered. They were chosen before any forward
 * result existed and must not be edited in response to observed performance —
 * a change moves the config hash and starts a NEW experiment.
 */
const GATE: EntryGate = {
  minNetEdge: 0.05,
  maxPriceUsd: 0.9,
  minPriceUsd: 0.02,
  minConfidence: 0.25,
  maxModelDispersionF: 6,
  // Only the class with a defined rule is enabled. The others exist in the
  // taxonomy but stay off until each has its own pre-registered rule.
  enabledStrategyClasses: ["INTRADAY_OBSERVATION_EDGE"],
  requireVerifiedSettlement: true,
};

const STALENESS: StalenessPolicy = { maxIssueAgeMs: 6 * 3600_000, maxRetrievalAgeMs: 15 * 60_000 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string, attempts = 4): Promise<{ data: T; latencyMs: number }> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    const started = Date.now();
    try {
      const res = await fetch(url, { headers: { "User-Agent": "source-to-sim-weather-lab/1.0 (research)" } });
      if (res.ok) return { data: (await res.json()) as T, latencyMs: Date.now() - started };
      last = new Error(`${res.status} ${res.statusText}`);
    } catch (e) {
      last = e;
    }
    await sleep(Math.min(4000, 300 * 2 ** i));
  }
  throw last;
}

type KalshiMarket = RawKalshiMarket & {
  event_ticker: string;
  status?: string;
  rules_primary?: string;
  volume?: number;
  open_interest_fp?: string;
  close_time?: string;
};

type Row = {
  city: string;
  station: string;
  eventTicker: string;
  weatherDate: string;
  ticker: string;
  label: string;
  modelProbability: number;
  yesAskUsd: number | null;
  executablePriceUsd: number | null;
  netEdge: number | null;
  feePerContractUsd: number | null;
  fillStatus: string;
  decision: string;
  rejectReasons: string[];
  strategyClass: string | null;
  scenarioEdges: Array<{ scenario: string; netEdge: number | null; fillStatus: string }>;
};

async function collectCity(cityKey: string, now: Date) {
  const site: StationSite | undefined = SITES[cityKey];
  const series = SERIES[cityKey];
  if (!site || !series) return { city: cityKey, error: `city ${cityKey} is not an audited site`, rows: [] as Row[] };

  const { data: marketsRes } = await getJson<{ markets?: KalshiMarket[] }>(
    `${API}/markets?series_ticker=${series}&status=open&limit=50`,
  );
  const markets = marketsRes.markets ?? [];
  if (markets.length === 0) return { city: cityKey, error: "no open markets", rows: [] as Row[] };

  const { data: seriesRes } = await getJson<{
    series?: { fee_type?: string; fee_multiplier?: number; settlement_sources?: Array<{ name?: string; url?: string }> };
  }>(`${API}/series/${series}`);

  const schedule: FeeSchedule = {
    feeType: seriesRes.series?.fee_type ?? "unknown",
    feeMultiplier: seriesRes.series?.fee_multiplier ?? 0,
  };

  // Group into station-day events.
  const byEvent = new Map<string, KalshiMarket[]>();
  for (const m of markets) {
    const list = byEvent.get(m.event_ticker);
    if (list) list.push(m);
    else byEvent.set(m.event_ticker, [m]);
  }

  const rows: Row[] = [];
  const events: Array<Record<string, unknown>> = [];

  for (const [eventTicker, legs] of [...byEvent].sort()) {
    const settlementRule = settlementRuleFromKalshi({
      seriesSettlementSources: seriesRes.series?.settlement_sources ?? null,
      rulesPrimary: legs[0]?.rules_primary ?? null,
      timezone: site.timezone,
    });
    const settlement = assessSettlement(settlementRule);

    let buckets: TemperatureBucket[];
    try {
      buckets = legs.map(parseBucket);
    } catch (e) {
      events.push({ eventTicker, skipped: "BUCKET_PARSE_FAILED", detail: (e as Error).message });
      continue;
    }
    const bucketSet = validateBucketSet(buckets);
    if (bucketSet.status !== "VALID") {
      events.push({ eventTicker, skipped: "BUCKET_SET_INVALID", detail: bucketSet.reason });
      continue;
    }

    // Target date from the event's close time, in site-local terms.
    const closeTime = legs[0]?.close_time ? new Date(legs[0].close_time) : null;
    const weatherDate = closeTime ? localDateFor(site, new Date(closeTime.getTime() - 6 * 3600_000)) : localDateFor(site, now);

    // --- weather feeds -----------------------------------------------------
    // The observation floor is only meaningful for the event whose settlement
    // window is running RIGHT NOW. Today's observed maximum says nothing about
    // tomorrow's maximum, and applying it to a next-day event would both distort
    // the distribution and mislabel that event as INTRADAY_OBSERVATION_EDGE.
    const isSameDayEvent = observationFloorApplies(site, weatherDate, now);

    const [obs, deterministic, ensemble] = await Promise.all([
      isSameDayEvent
        ? fetchObservedMax(site, now)
        : Promise.resolve({
            ok: false as const,
            sourceId: `api.weather.gov/stations/${site.observationStation}`,
            source: "STATION_OBSERVATION" as const,
            reason: `event date ${weatherDate} is not the current local day; observation floor does not apply`,
          }),
      fetchDeterministicForecasts(site, weatherDate, now),
      fetchEnsembleForecast(site, weatherDate, now),
    ]);

    const okData: Array<ProvenancedDatum<unknown>> = [];
    const rejected: Array<{ sourceId: string; reason: string }> = [];
    for (const r of [...deterministic, ensemble]) {
      if (r.ok) okData.push(r.datum as ProvenancedDatum<unknown>);
      else rejected.push({ sourceId: r.sourceId, reason: r.reason });
    }
    if (obs.ok) okData.push(obs.datum as ProvenancedDatum<unknown>);
    else rejected.push({ sourceId: obs.sourceId, reason: obs.reason });

    const { admitted, rejected: staleRejected } = admitAll(okData, now, STALENESS);
    rejected.push(...staleRejected);

    const ensembleSpread = ensemble.ok ? ensemble.datum.value.spreadF : null;
    const hoursToClose = closeTime ? (closeTime.getTime() - now.getTime()) / 3_600_000 : 24;
    const sigma = forecastSigmaF({ ensembleSpreadF: ensembleSpread, hoursToWindowClose: hoursToClose });

    const forecasts: ModelForecast[] = admitted
      .filter((d) => d.source !== "STATION_OBSERVATION")
      .map((d) => {
        const v = d.value as { maxF: number };
        // Open-Meteo feeds are GRID basis; the NWS station observation is STATION
        // basis. Declaring this lets the engine refuse to difference them.
        return { source: d.source, sourceId: d.sourceId, basis: "GRID" as const, meanF: v.maxF, sdF: sigma.sigmaF, weight: 1 };
      });

    if (forecasts.length === 0) {
      events.push({ eventTicker, skipped: "NO_ADMITTED_FORECASTS", rejected });
      continue;
    }

    const observedMaxF = obs.ok && admitted.some((d) => d.source === "STATION_OBSERVATION")
      ? obs.datum.value.observedMaxF
      : null;

    // Local decision hour drives the frozen intraday conditioning schedule.
    const decisionLocalHour = Number(
      new Intl.DateTimeFormat("en-GB", { timeZone: site.timezone, hour: "2-digit", hour12: false }).format(now),
    );

    const distribution = buildDistribution({
      buckets,
      forecasts,
      observedMaxF,
      observationBasis: "STATION",
      decisionLocalHour,
    });

    // --- market side -------------------------------------------------------
    for (const leg of legs) {
      const bucket = buckets.find((b) => b.ticker === leg.ticker);
      const prob = distribution.buckets.find((b) => b.ticker === leg.ticker);
      if (!bucket || !prob) continue;

      const { data: bookRes } = await getJson<{
        orderbook_fp?: { yes_dollars?: Array<[string, string]>; no_dollars?: Array<[string, string]> };
      }>(`${API}/markets/${encodeURIComponent(leg.ticker)}/orderbook?depth=100`);

      const yesAskLadder = yesAskLadderFromNoBids(bookRes.orderbook_fp?.no_dollars ?? []);
      const noAskLadder = noAskLadderFromYesBids(bookRes.orderbook_fp?.yes_dollars ?? []);
      const bestYesAsk = yesAskLadder[0]?.price ?? null;

      const fills = simulateAllScenarios({
        ladder: yesAskLadder,
        contracts: POSITION_CONTRACTS,
        schedule,
        maxPriceUsd: GATE.maxPriceUsd,
        marketClosed: leg.status !== "active",
      });
      const base = fills.BASE;

      const executablePriceUsd = base.averagePriceUsd;
      let netEdge: number | null = null;
      let feePerContractUsd: number | null = null;
      let decision = "REJECT";
      let rejectReasons: string[] = ["NOT_FILLABLE"];
      let strategyClass: string | null = null;

      if (executablePriceUsd !== null) {
        const inputs = {
          modelProbability: prob.probability,
          executablePriceUsd,
          contracts: base.filledContracts,
          schedule,
          slippageBufferUsd: 0.01,
          bestBidUsd: null,
          bestAskUsd: bestYesAsk,
        };
        const edge = computeEdge(inputs);
        netEdge = edge.netEdge;
        feePerContractUsd = edge.feePerContractUsd;

        const d = decideEntry({
          inputs,
          gate: GATE,
          confidence: distribution.confidence,
          modelDispersionF: distribution.modelDispersionF,
          settlementVerified: settlement.status === "SETTLEMENT_VERIFIED",
          observationFloorApplied: distribution.observationFloorF !== null,
          basisMismatch: distribution.basisMismatch,
          fill: base,
        });
        decision = d.decision;
        rejectReasons = d.reasons;
        strategyClass = d.strategyClass;

        // Paper only. Never reached with anything but "PAPER".
        if (d.decision === "ENTER") assertPaperOnly("PAPER", `weather-lab-collect:${leg.ticker}`);
      } else {
        strategyClass = classifyStrategy({
          executablePriceUsd: 1,
          observationFloorApplied: distribution.observationFloorF !== null,
          modelDispersionF: distribution.modelDispersionF,
          enabled: GATE.enabledStrategyClasses,
        });
      }

      rows.push({
        city: cityKey,
        station: site.station,
        eventTicker,
        weatherDate,
        ticker: leg.ticker,
        label: bucket.label,
        modelProbability: prob.probability,
        yesAskUsd: bestYesAsk,
        executablePriceUsd,
        netEdge,
        feePerContractUsd,
        fillStatus: base.status,
        decision,
        rejectReasons,
        strategyClass,
        scenarioEdges: edgeUnderScenarios({
          modelProbability: prob.probability,
          fills,
          schedule,
          slippageBufferUsd: 0.01,
        }).map((s) => ({ scenario: s.scenario, netEdge: s.netEdge, fillStatus: s.fillStatus })),
      });

      void noAskLadder;
      await sleep(40);
    }

    events.push({
      eventTicker,
      weatherDate,
      settlementStatus: settlement.status,
      settlementProblems: settlement.problems,
      settlementFingerprint: settlement.fingerprint,
      feeSchedule: schedule,
      distributionSum: distributionSum(distribution),
      consensusMeanF: distribution.consensusMeanF,
      modelDispersionF: distribution.modelDispersionF,
      confidence: distribution.confidence,
      observationFloorF: distribution.observationFloorF,
      decisionLocalHour,
      intradayWeight: distribution.intradayWeight,
      intradaySigmaScale: distribution.intradaySigmaScale,
      basisMismatch: distribution.basisMismatch,
      mismatchedBases: distribution.mismatchedBases,
      sigmaBasis: sigma.basis,
      sigmaF: sigma.sigmaF,
      contributingSources: distribution.contributingSources,
      rejectedSources: rejected,
    });
  }

  return { city: cityKey, error: null, rows, events };
}

async function main() {
  const now = new Date();

  const config: ExperimentConfig = {
    strategyVersion: "weather-intraday-v1",
    enabledCities: ENABLED_CITIES,
    modelWeights: { "open-meteo/gfs_seamless": 1, "open-meteo/ecmwf_ifs025": 1, "open-meteo/icon_seamless": 1, "open-meteo-ensemble/gfs025": 1 },
    gate: GATE,
    positionSizeContracts: POSITION_CONTRACTS,
    maxNotionalPerMarketUsd: 25,
    maxNotionalPerStationDayUsd: 75,
    maxConcurrentStationDays: 5,
    slippageBufferUsd: 0.01,
    maxQuoteAgeMs: STALENESS.maxRetrievalAgeMs,
    maxForecastAgeMs: STALENESS.maxIssueAgeMs,
    feeModelVersion: FEE_MODEL_VERSION,
    admittedSettlementFingerprints: Object.fromEntries(ENABLED_CITIES.map((c) => [c, "PENDING_FIRST_OBSERVATION"])),
  };

  const results = [];
  for (const city of ENABLED_CITIES) {
    process.stdout.write(`collecting ${city} ... `);
    try {
      results.push(await collectCity(city, now));
      console.log("done");
    } catch (e) {
      console.log("failed");
      results.push({ city, error: (e as Error).message, rows: [] as Row[], events: [] });
    }
  }

  const allRows = results.flatMap((r) => r.rows ?? []);
  const entries = allRows.filter((r) => r.decision === "ENTER");

  let md = `# Weather Lab Collection\n\n**PAPER / RESEARCH ONLY. No orders were placed. \`LIVE_EXECUTION_IMPLEMENTED=false\`.**\n\n`;
  md += `Run at ${now.toISOString()}. Strategy \`${config.strategyVersion}\`, ${POSITION_CONTRACTS} contracts per candidate.\n\n`;
  md += `Frozen gate: min net edge ${GATE.minNetEdge}, price band ${GATE.minPriceUsd}-${GATE.maxPriceUsd}, min confidence ${GATE.minConfidence}, max dispersion ${GATE.maxModelDispersionF}F, enabled classes ${GATE.enabledStrategyClasses.join(", ")}.\n\n`;
  md += `## Summary\n\n- contracts priced: ${allRows.length}\n- paper entries: **${entries.length}**\n- not fillable at requested size: ${allRows.filter((r) => r.fillStatus === "NO_FILL").length}\n\n`;
  md += `## Model vs market\n\n| City | Bucket | Model | YES ask | Executable | Fee/ct | Net edge | Fill | Decision |\n|---|---|---:|---:|---:|---:|---:|---|---|\n`;
  for (const r of allRows) {
    const f = (v: number | null, d = 3) => (v === null ? "n/a" : v.toFixed(d));
    md += `| ${r.city} | ${r.label} | ${f(r.modelProbability)} | ${f(r.yesAskUsd)} | ${f(r.executablePriceUsd)} | ${f(r.feePerContractUsd, 4)} | ${f(r.netEdge)} | ${r.fillStatus} | ${r.decision}${r.decision === "REJECT" && r.rejectReasons.length ? ` (${r.rejectReasons[0]})` : ""} |\n`;
  }
  md += `\n## Guardrails\n\n- A signal that could not fill at the requested size is NO_FILL and is not a trade.\n- Settlement must be verified before any paper entry; unverified contracts are rejected.\n- Thresholds are frozen; changing one starts a new experiment.\n- No credentials, no orders, no live execution path exists in this collector.\n`;

  await mkdir("research-output", { recursive: true });
  await writeFile("research-output/weather-lab-collection.md", md);
  await writeFile(
    "research-output/weather-lab-collection.json",
    JSON.stringify({ generatedAt: now.toISOString(), config, frozen: freezeExperiment({ experimentId: "weather-intraday-v1", config, frozenAt: now }), results }, null, 2) + "\n",
  );
  console.log(md);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exitCode = 1;
});
