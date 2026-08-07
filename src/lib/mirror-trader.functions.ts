import { createServerFn } from "@tanstack/react-start";

import { DEMO_RAW_POSITIONS, DEMO_RAW_TRADES } from "./mirror-demo-data";
import {
  TARGET_WALLET,
  normalizePositions,
  normalizeTrades,
  type HistoryCoverage,
  type MirrorSnapshot,
  type SourceTrade,
} from "./mirror-trader";

const DATA_API = "https://data-api.polymarket.com";
const POSITIONS_URL = `${DATA_API}/positions?user=${TARGET_WALLET}&limit=100&sortBy=CURRENT&sortDirection=DESC`;

/** Bounded history target — deliberately small, no huge backfills. */
const HISTORY_TARGET = 500;
const PAGE_SIZE = 250;

const SOURCE_SETTLED_NOTE =
  "Unavailable: the public Data API exposes no verified closed/settled positions endpoint, and the `closed` parameter is ignored (identical results for closed=true/false). Summing realizedPnl from currently returned positions would not be complete lifetime settled P&L, so no total is shown.";

async function getJson(url: string, attempts = 2): Promise<unknown[]> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await getJsonOnce(url);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("request failed");
}

async function getJsonOnce(url: string): Promise<unknown[]> {
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

/**
 * Fetch a bounded trade history using the Data API's limit/offset pagination.
 * If a later page fails, we keep whatever pages already succeeded and report it.
 */
async function fetchTradeHistory(): Promise<{
  raw: unknown[];
  pagesFetched: number;
  paginationSupported: boolean;
  paginationNote: string | null;
}> {
  const base = `${DATA_API}/trades?user=${TARGET_WALLET}`;
  const first = await getJson(`${base}&limit=${PAGE_SIZE}&offset=0`);
  const raw: unknown[] = [...first];
  let pagesFetched = 1;
  let paginationSupported = false;
  let paginationNote: string | null = null;

  while (raw.length < HISTORY_TARGET && first.length === PAGE_SIZE) {
    const offset = raw.length;
    let page: unknown[];
    try {
      page = await getJson(`${base}&limit=${PAGE_SIZE}&offset=${offset}`);
    } catch (err) {
      paginationNote = `Pagination stopped early at offset ${offset} (${
        err instanceof Error ? err.message : "request failed"
      }). Only the pages already fetched are shown.`;
      break;
    }
    pagesFetched += 1;
    if (page.length === 0) {
      paginationSupported = true;
      break;
    }
    const before = raw.length;
    raw.push(...page);
    if (raw.length > before) paginationSupported = true;
    if (page.length < PAGE_SIZE) break;
  }

  if (!paginationSupported && pagesFetched > 1) {
    paginationNote =
      "Offset pagination returned no additional trades, so history is limited to a single page from the public Data API.";
  }

  return { raw: raw.slice(0, HISTORY_TARGET), pagesFetched, paginationSupported, paginationNote };
}

function buildHistory(
  trades: SourceTrade[],
  pagesFetched: number,
  paginationSupported: boolean,
  note: string,
): HistoryCoverage {
  const times = trades.map((t) => t.timestamp).filter((t) => t > 0);
  return {
    count: trades.length,
    oldest: times.length ? Math.min(...times) : null,
    newest: times.length ? Math.max(...times) : null,
    pagesFetched,
    requestedTarget: HISTORY_TARGET,
    paginationSupported,
    // We can only claim completeness if the API ran out of trades before the cap.
    complete: paginationSupported && trades.length < HISTORY_TARGET,
    note,
  };
}

/** Read-only public data fetch. No credentials, no signing, no mutations. */
export const getMirrorSnapshot = createServerFn({ method: "GET" }).handler(
  async (): Promise<MirrorSnapshot> => {
    const fetchedAt = new Date().toISOString();
    const sources = [`${DATA_API}/trades`, `${DATA_API}/positions`];

    try {
      const [history, rawPositions] = await Promise.all([
        fetchTradeHistory(),
        getJson(POSITIONS_URL),
      ]);
      const trades = normalizeTrades(history.raw as Record<string, unknown>[]);
      const positions = normalizePositions(rawPositions as Record<string, unknown>[]);
      const warnings: string[] = [];
      if (trades.some((t) => t.idBasis === "tx_hash_ordinal")) {
        warnings.push(
          "Public trade records expose no trade id or log index. Identity falls back to transaction hash plus a stable local ordinal, so identical same-second fills stay distinct.",
        );
      }
      if (trades.length === 0) warnings.push("No source trades returned for this wallet.");
      if (history.paginationNote) warnings.push(history.paginationNote);
      return {
        mode: "LIVE",
        fetchedAt,
        wallet: TARGET_WALLET,
        trades,
        positions,
        fallbackReason: null,
        sources,
        warnings,
        history: buildHistory(
          trades,
          history.pagesFetched,
          history.paginationSupported,
          history.paginationNote ??
            `Loaded up to ${HISTORY_TARGET} most recent public fills via limit/offset pagination (${PAGE_SIZE} per page).`,
        ),
        sourceSettledPnl: null,
        sourceSettledNote: SOURCE_SETTLED_NOTE,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown network error";
      const demoTrades = normalizeTrades(DEMO_RAW_TRADES as unknown as Record<string, unknown>[]);
      return {
        mode: "DEMO",
        fetchedAt,
        wallet: TARGET_WALLET,
        trades: demoTrades,
        positions: normalizePositions(DEMO_RAW_POSITIONS as unknown as Record<string, unknown>[]),
        fallbackReason: `Live public Polymarket data was unreachable from the server runtime (${reason}). Everything below is DEMO/SAMPLE data, not live activity.`,
        sources,
        warnings: ["Demo fallback active — no live values are shown anywhere on this page."],
        history: buildHistory(
          demoTrades,
          0,
          false,
          "DEMO sample window only — no real history was loaded.",
        ),
        sourceSettledPnl: null,
        sourceSettledNote: "Unavailable in DEMO mode — no verified source settlement data.",
      };
    }
  },
);