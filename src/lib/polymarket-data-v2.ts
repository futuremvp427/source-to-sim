/** Public source-data transport only. No credentials, orders, or venue matching. */
export type TradeRow = Record<string, unknown>;
type PageInfo = { hasMore: boolean; nextCursor: string | null };
const pageInfo = new WeakMap<TradeRow[], PageInfo>();

export class DataV2PageError extends Error {}

/** Retain pagination with the array, so existing coverage walkers cannot infer
 * exhaustion from a short page when v2 explicitly says more history exists. */
export function decodeV2TradePage(value: unknown): TradeRow[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DataV2PageError("Data API v2 trades response must be an envelope");
  }
  const body = value as Record<string, unknown>;
  const rows = body["data"];
  const pagination = body["pagination"];
  if (!Array.isArray(rows) || rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))) {
    throw new DataV2PageError("Data API v2 trades data must contain row objects");
  }
  if (!pagination || typeof pagination !== "object" || Array.isArray(pagination)) {
    throw new DataV2PageError("Data API v2 trades pagination is missing");
  }
  const p = pagination as Record<string, unknown>;
  if (typeof p["has_more"] !== "boolean") {
    throw new DataV2PageError("Data API v2 trades has_more is missing");
  }
  const hasMore = p["has_more"];
  const next = p["next_cursor"];
  if (hasMore && (rows.length === 0 || typeof next !== "string" || next.trim() === "")) {
    throw new DataV2PageError("Data API v2 trades continuation is inconsistent");
  }
  if (!hasMore && next != null && next !== "") {
    throw new DataV2PageError("Data API v2 terminal page unexpectedly has a continuation");
  }
  const out = rows as TradeRow[];
  pageInfo.set(out, { hasMore, nextCursor: hasMore ? next as string : null });
  return out;
}

/** Plain arrays remain supported by the pure legacy pagination test harness.
 * Actual v2 network responses must pass decodeV2TradePage before reaching here. */
export function tradePageHasMore(rows: TradeRow[], pageSize: number): boolean {
  return pageInfo.get(rows)?.hasMore ?? rows.length >= pageSize;
}

export function buildV2TradesUrl(wallet: string, limit: number, cursor?: string | null, endTs?: number): string {
  const url = new URL("https://data-api.polymarket.com/v2/trades");
  url.searchParams.set("user", wallet.toLowerCase());
  url.searchParams.set("taker_only", "false");
  url.searchParams.set("limit", String(limit));
  if (endTs !== undefined) url.searchParams.set("end", String(endTs));
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.toString();
}

/** Compatibility bridge for existing checkpoint/window walkers. `offset` is
 * ONLY a local page ordinal; it is never sent to v2. Each walk/window owns its
 * own cursor chain. Checkpoints, leases and incomplete scans stay with callers.
 * No cursor is persisted as a new study boundary or shared between wallets. */
export function createV2TradesReader(
  wallet: string,
  pageSize: number,
  fetchRows: (url: string) => Promise<TradeRow[]>,
): (offset: number, endTs?: number) => Promise<TradeRow[]> {
  let expectedOffset = 0;
  let end: number | undefined;
  let cursor: string | null = null;
  let terminal = false;
  let started = false;
  const seen = new Set<string>();
  return async (offset, endTs) => {
    if (offset === 0) {
      expectedOffset = 0;
      end = endTs;
      cursor = null;
      terminal = false;
      started = true;
      seen.clear();
    }
    if (!started || offset !== expectedOffset || end !== endTs) {
      throw new DataV2PageError("Data API v2 cursor walk requested a nonsequential page");
    }
    if (terminal) return decodeV2TradePage({ data: [], pagination: { has_more: false, next_cursor: null } });
    const rows = await fetchRows(buildV2TradesUrl(wallet, pageSize, cursor, endTs));
    const info = pageInfo.get(rows);
    if (!info) throw new DataV2PageError("Data API v2 page was not validated");
    if (info.nextCursor) {
      if (info.nextCursor === cursor || seen.has(info.nextCursor)) {
        throw new DataV2PageError("Data API v2 cursor did not advance");
      }
      seen.add(info.nextCursor);
    }
    cursor = info.nextCursor;
    terminal = !info.hasMore;
    expectedOffset += pageSize;
    return rows;
  };
}
