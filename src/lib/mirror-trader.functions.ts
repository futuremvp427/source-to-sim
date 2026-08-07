import { createServerFn } from "@tanstack/react-start";

import { DEMO_RAW_POSITIONS, DEMO_RAW_TRADES } from "./mirror-demo-data";
import {
  TARGET_WALLET,
  normalizePositions,
  normalizeTrades,
  type MirrorSnapshot,
} from "./mirror-trader";

const DATA_API = "https://data-api.polymarket.com";
const TRADES_URL = `${DATA_API}/trades?user=${TARGET_WALLET}&limit=100`;
const POSITIONS_URL = `${DATA_API}/positions?user=${TARGET_WALLET}&limit=100&sortBy=CURRENT&sortDirection=DESC`;

async function getJson(url: string): Promise<unknown[]> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`${url.split("?")[0]} responded ${res.status}`);
  const json: unknown = await res.json();
  if (Array.isArray(json)) return json as unknown[];
  if (json && typeof json === "object" && Array.isArray((json as { data?: unknown[] }).data)) {
    return (json as { data: unknown[] }).data;
  }
  throw new Error(`${url.split("?")[0]} returned an unexpected shape`);
}

/** Read-only public data fetch. No credentials, no signing, no mutations. */
export const getMirrorSnapshot = createServerFn({ method: "GET" }).handler(
  async (): Promise<MirrorSnapshot> => {
    const fetchedAt = new Date().toISOString();
    const sources = [`${DATA_API}/trades`, `${DATA_API}/positions`];

    try {
      const [rawTrades, rawPositions] = await Promise.all([
        getJson(TRADES_URL),
        getJson(POSITIONS_URL),
      ]);
      const trades = normalizeTrades(rawTrades as Record<string, unknown>[]);
      const positions = normalizePositions(rawPositions as Record<string, unknown>[]);
      const warnings: string[] = [];
      if (trades.some((t) => t.idBasis === "tx_hash_ordinal")) {
        warnings.push(
          "Public trade records expose no trade id or log index. Identity falls back to transaction hash plus a stable local ordinal, so identical same-second fills stay distinct.",
        );
      }
      if (trades.length === 0) warnings.push("No source trades returned for this wallet.");
      return {
        mode: "LIVE",
        fetchedAt,
        wallet: TARGET_WALLET,
        trades,
        positions,
        fallbackReason: null,
        sources,
        warnings,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown network error";
      return {
        mode: "DEMO",
        fetchedAt,
        wallet: TARGET_WALLET,
        trades: normalizeTrades(DEMO_RAW_TRADES as unknown as Record<string, unknown>[]),
        positions: normalizePositions(DEMO_RAW_POSITIONS as unknown as Record<string, unknown>[]),
        fallbackReason: `Live public Polymarket data was unreachable from the server runtime (${reason}). Everything below is DEMO/SAMPLE data, not live activity.`,
        sources,
        warnings: ["Demo fallback active — no live values are shown anywhere on this page."],
      };
    }
  },
);