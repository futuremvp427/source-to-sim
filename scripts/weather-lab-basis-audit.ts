#!/usr/bin/env bun

/**
 * NBM station-basis audit.
 *
 * Answers one question: is NBM station-text guidance actually on the same
 * measurement basis as the station observation, or is it — as NOAA documents —
 * simply the nearest usable grid point wearing a station label?
 *
 * Method: for short forecast leads (FHR 1..6), forecast error is small, so the
 * residual is dominated by representativeness rather than skill.
 *
 *   basis_error = observed_station_temperature - nbm_station_guidance
 *
 * Read-only. Public NOAA and NWS sources. No orders, no trading, no writes to
 * any production system.
 */

import { mkdir, writeFile } from "node:fs/promises";

import { nbmBulletinUrl, parseNbmBulletin, temperatureSeries } from "../src/lib/weather-lab/sources/nbm";
import { SITES, type StationSite } from "../src/lib/weather-lab/sources";

const DAYS = Number(process.env["BASIS_AUDIT_DAYS"] ?? "25");
const CYCLES = (process.env["BASIS_AUDIT_CYCLES"] ?? "12,15,18,21").split(",").map(Number);
const MAX_FHR = Number(process.env["BASIS_AUDIT_MAX_FHR"] ?? "6");
/** An observation this far from the forecast valid time is not a match. */
const MATCH_TOLERANCE_MS = 35 * 60_000;

const sites = Object.values(SITES);
const stations = sites.map((s) => s.observationStation);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string, attempts = 4): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "source-to-sim-weather-lab/1.0 (research)" } });
      if (res.ok) return await res.text();
      if (res.status === 404) return null;
    } catch {
      /* retry */
    }
    await sleep(Math.min(5000, 400 * 2 ** i));
  }
  return null;
}

async function getJson<T>(url: string, attempts = 4): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "source-to-sim-weather-lab/1.0 (research)" } });
      if (res.ok) return (await res.json()) as T;
      if (res.status === 404) return null;
    } catch {
      /* retry */
    }
    await sleep(Math.min(5000, 400 * 2 ** i));
  }
  return null;
}

const celsiusToF = (c: number) => (c * 9) / 5 + 32;

/** Observations keyed by the UTC hour they are closest to. */
type ObsIndex = Map<number, { at: Date; valueF: number }>;

async function loadObservations(site: StationSite, start: Date, end: Date): Promise<ObsIndex> {
  const index: ObsIndex = new Map();
  // The endpoint caps results, so walk the window in chunks.
  const CHUNK_MS = 5 * 86_400_000;
  for (let t = start.getTime(); t < end.getTime(); t += CHUNK_MS) {
    const chunkStart = new Date(t);
    const chunkEnd = new Date(Math.min(end.getTime(), t + CHUNK_MS));
    const url =
      `https://api.weather.gov/stations/${site.observationStation}/observations` +
      `?start=${encodeURIComponent(chunkStart.toISOString())}&end=${encodeURIComponent(chunkEnd.toISOString())}&limit=500`;
    const raw = await getJson<{
      features?: Array<{ properties?: { timestamp?: string; temperature?: { value?: number | null; unitCode?: string } } }>;
    }>(url);
    for (const f of raw?.features ?? []) {
      const p = f.properties;
      const v = p?.temperature?.value;
      if (v === null || v === undefined || !p?.timestamp) continue;
      const valueF = p.temperature?.unitCode?.includes("degF") ? v : celsiusToF(v);
      if (!Number.isFinite(valueF)) continue;
      const at = new Date(p.timestamp);
      // Snap to the nearest whole UTC hour.
      const snapped = new Date(Math.round(at.getTime() / 3_600_000) * 3_600_000);
      const key = snapped.getTime();
      const existing = index.get(key);
      if (!existing || Math.abs(at.getTime() - key) < Math.abs(existing.at.getTime() - key)) {
        index.set(key, { at, valueF });
      }
    }
    await sleep(120);
  }
  return index;
}

type Sample = {
  station: string;
  city: string;
  cycleIso: string;
  validIso: string;
  forecastHour: number;
  localHour: number;
  forecastF: number;
  forecastSdF: number | null;
  observedF: number;
  observedAtIso: string;
  matchOffsetMin: number;
  basisErrorF: number;
};

function stats(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]!;
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return {
    n,
    meanBiasF: mean,
    medianBiasF: q(0.5),
    maeF: values.reduce((a, b) => a + Math.abs(b), 0) / n,
    rmseF: Math.sqrt(values.reduce((a, b) => a + b * b, 0) / n),
    sdF: Math.sqrt(variance),
    p10: q(0.1),
    p25: q(0.25),
    p75: q(0.75),
    p90: q(0.9),
    maxPositiveF: sorted[sorted.length - 1]!,
    maxNegativeF: sorted[0]!,
  };
}

async function main() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - DAYS * 86_400_000);

  console.log(`Loading observations for ${stations.join(", ")} ...`);
  const obs = new Map<string, ObsIndex>();
  for (const site of sites) {
    obs.set(site.observationStation, await loadObservations(site, start, new Date(now.getTime())));
    console.log(`  ${site.observationStation}: ${obs.get(site.observationStation)!.size} hourly observations`);
  }

  const samples: Sample[] = [];
  let bulletinsFetched = 0;
  let bulletinsMissing = 0;

  for (let d = 0; d < DAYS; d++) {
    const day = new Date(start.getTime() + d * 86_400_000);
    for (const cycleHour of CYCLES) {
      const cycle = new Date(
        Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), cycleHour),
      );
      if (cycle.getTime() > now.getTime()) continue;

      const text = await getText(nbmBulletinUrl("NBH", cycle));
      if (!text) {
        bulletinsMissing++;
        continue;
      }
      bulletinsFetched++;

      const parsed = parseNbmBulletin(text, stations);
      for (const site of sites) {
        const f = parsed.get(site.observationStation);
        if (!f) continue;
        for (const s of temperatureSeries(f)) {
          if (s.forecastHour > MAX_FHR) continue;
          const key = Math.round(s.validTime.getTime() / 3_600_000) * 3_600_000;
          const o = obs.get(site.observationStation)?.get(key);
          if (!o) continue;
          const offset = Math.abs(o.at.getTime() - s.validTime.getTime());
          if (offset > MATCH_TOLERANCE_MS) continue;

          samples.push({
            station: site.observationStation,
            city: site.city,
            cycleIso: f.cycleTime.toISOString(),
            validIso: s.validTime.toISOString(),
            forecastHour: s.forecastHour,
            localHour: Number(
              new Intl.DateTimeFormat("en-GB", { timeZone: site.timezone, hour: "2-digit", hour12: false }).format(
                s.validTime,
              ),
            ),
            forecastF: s.temperatureF,
            forecastSdF: s.sdF,
            observedF: o.valueF,
            observedAtIso: o.at.toISOString(),
            matchOffsetMin: Math.round(offset / 60_000),
            basisErrorF: o.valueF - s.temperatureF,
          });
        }
      }
      process.stdout.write(`\r  bulletins ${bulletinsFetched} fetched / ${bulletinsMissing} missing, samples ${samples.length}   `);
    }
  }
  console.log("");

  const byStation = sites.map((site) => {
    const rows = samples.filter((s) => s.station === site.observationStation);
    const byHour = [...new Set(rows.map((r) => r.localHour))].sort((a, b) => a - b).map((h) => ({
      localHour: h,
      ...(stats(rows.filter((r) => r.localHour === h).map((r) => r.basisErrorF)) ?? {}),
    }));
    const byFhr = [...new Set(rows.map((r) => r.forecastHour))].sort((a, b) => a - b).map((fh) => ({
      forecastHour: fh,
      ...(stats(rows.filter((r) => r.forecastHour === fh).map((r) => r.basisErrorF)) ?? {}),
    }));
    const byCycle = [...new Set(rows.map((r) => new Date(r.cycleIso).getUTCHours()))].sort((a, b) => a - b).map((c) => ({
      cycleHourUtc: c,
      ...(stats(rows.filter((r) => new Date(r.cycleIso).getUTCHours() === c).map((r) => r.basisErrorF)) ?? {}),
    }));
    return {
      city: site.city,
      station: site.observationStation,
      settlementStation: site.station,
      overall: stats(rows.map((r) => r.basisErrorF)),
      byLocalHour: byHour,
      byForecastHour: byFhr,
      byCycle,
    };
  });

  const f2 = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : x.toFixed(2));

  let md = `# NBM Station-Basis Audit\n\n`;
  md += `Read-only. Quantifies whether NBM station-text guidance sits on the same measurement basis as the station observation.\n\n`;
  md += `NOAA generates these bulletins from the closest usable NBM grid point, so a station-ID match is **not** automatically an observation-basis match. This is the measurement, not an assumption.\n\n`;
  md += `Window: ${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)} (${DAYS} days). Cycles ${CYCLES.map((c) => `${String(c).padStart(2, "0")}Z`).join(", ")}. Forecast hours 1-${MAX_FHR}, where forecast skill error is small so the residual is dominated by representativeness.\n\n`;
  md += `Bulletins: ${bulletinsFetched} fetched, ${bulletinsMissing} missing. Total matched samples: **${samples.length}**.\n\n`;
  md += `\`basis_error = observed_station_temperature - nbm_station_guidance\` (degrees F).\n\n`;
  md += `## Per station\n\n| City | Station | n | Mean bias | Median | MAE | RMSE | SD | p10 | p90 | Max + | Max - |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
  for (const s of byStation) {
    const o = s.overall;
    md += `| ${s.city} | ${s.station} | ${o?.n ?? 0} | ${f2(o?.meanBiasF)} | ${f2(o?.medianBiasF)} | ${f2(o?.maeF)} | ${f2(o?.rmseF)} | ${f2(o?.sdF)} | ${f2(o?.p10)} | ${f2(o?.p90)} | ${f2(o?.maxPositiveF)} | ${f2(o?.maxNegativeF)} |\n`;
  }

  for (const s of byStation) {
    md += `\n### ${s.city} (${s.station}) by local hour\n\n| Local hour | n | Mean bias | MAE | SD |\n|---:|---:|---:|---:|---:|\n`;
    for (const h of s.byLocalHour) {
      md += `| ${String(h.localHour).padStart(2, "0")} | ${h.n ?? 0} | ${f2(h.meanBiasF)} | ${f2(h.maeF)} | ${f2(h.sdF)} |\n`;
    }
  }

  md += `\n## Interpretation guardrails\n\n`;
  md += `- A small mean bias with a small SD means the station bulletin is usable directly.\n`;
  md += `- A stable non-zero mean bias is correctable, but the correction must be built causally from data strictly preceding each decision.\n`;
  md += `- A large SD is NOT correctable by a bias constant and means the station should stay unverified.\n`;
  md += `- These residuals still contain a little genuine short-lead forecast error, so they are an upper bound on pure representativeness error.\n`;
  md += `- No orders, no trading, no production writes.\n`;

  await mkdir("research-output", { recursive: true });
  await writeFile("research-output/weather-lab-basis-audit.md", md);
  await writeFile(
    "research-output/weather-lab-basis-audit.json",
    JSON.stringify(
      { generatedAt: now.toISOString(), window: { start, end, days: DAYS }, cycles: CYCLES, maxFhr: MAX_FHR, bulletinsFetched, bulletinsMissing, byStation, samples },
      null,
      2,
    ) + "\n",
  );
  console.log(md);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exitCode = 1;
});
