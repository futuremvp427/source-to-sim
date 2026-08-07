/**
 * Presentation helpers shared by the dashboard.
 * The paper-trading engine lives in shadow-core.ts / shadow.server.ts; the
 * older standalone simulation helpers that used to live here were removed
 * because they conflicted with the real proportional-SELL engine.
 */

export const TARGET_WALLET = "0x8fbd7cf5f806f563080864694415829f7229a959";

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

export function formatUsd(v: number): string {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatShares(v: number): string {
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/* ------------------------------------------------------------------ */
/* Weather classification (HEURISTIC — title/slug keywords only)        */
/* ------------------------------------------------------------------ */

/** Transparent keyword list used for the weather heuristic. Not authoritative. */
export const WEATHER_KEYWORDS = [
  "temperature",
  "temp in",
  "rain",
  "rainfall",
  "snow",
  "snowfall",
  "hurricane",
  "tropical storm",
  "tornado",
  "wildfire",
  "heat index",
  "humidity",
  "wind speed",
  "weather",
  "degrees",
  "°c",
  "°f",
  "el nino",
  "el niño",
  "la nina",
  "la niña",
];

/** HEURISTIC: matches known weather keywords in the market title or slug. */
export function isWeatherMarket(title: string, slug?: string): boolean {
  const hay = `${title} ${slug ?? ""}`.toLowerCase();
  return WEATHER_KEYWORDS.some((k) => hay.includes(k));
}
