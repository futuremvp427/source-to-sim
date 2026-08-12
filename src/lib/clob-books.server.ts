/**
 * SERVER-ONLY batched public CLOB book reader.
 *
 * The public CLOB exposes POST /books, which returns every requested book in a
 * single round trip. Fetching one book per request could not cover a large open
 * book (200+ positions) inside one scheduler cycle: it produced rate limits,
 * cycle-deadline failures and therefore stale/absent marks. This module is
 * read-only: no signing, no credentials, no order path.
 */

const CLOB_API = "https://clob.polymarket.com";
/** Server-side observed limit: 200+ token ids answer in well under a second. */
const BOOKS_CHUNK = 100;
const ATTEMPTS = 3;

export type BookSnapshot = {
  bid: number | null;
  ask: number | null;
  bidDepth: number | null;
  askDepth: number | null;
  ts: number;
};

type Level = { price?: string; size?: string };
type RawBook = { asset_id?: string; bids?: Level[]; asks?: Level[]; timestamp?: string };

function best(levels: Level[] | undefined, pick: "max" | "min"): { price: number | null; size: number | null } {
  const parsed = (levels ?? [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.size));
  if (parsed.length === 0) return { price: null, size: null };
  const top = parsed.reduce((a, b) => (pick === "max" ? (b.price > a.price ? b : a) : b.price < a.price ? b : a));
  return { price: top.price, size: top.size };
}

async function postChunk(assets: string[]): Promise<RawBook[]> {
  let lastErr: unknown;
  for (let i = 0; i < ATTEMPTS; i += 1) {
    try {
      const res = await fetch(`${CLOB_API}/books`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(assets.map((token_id) => ({ token_id }))),
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) throw new Error(`clob /books responded ${res.status}`);
      const json = (await res.json()) as unknown;
      if (!Array.isArray(json)) throw new Error("clob /books returned an unexpected shape");
      return json as RawBook[];
    } catch (err) {
      lastErr = err;
      if (i < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 300 * 2 ** i));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("clob /books request failed");
}

/**
 * Returns one snapshot per asset that the CLOB answered for. Assets with no
 * public book are simply absent from the map — callers must treat that as
 * "Unavailable" and never substitute a fabricated price.
 */
export async function fetchBooksBatched(assets: string[]): Promise<Map<string, BookSnapshot>> {
  const unique = [...new Set(assets.filter(Boolean))];
  const out = new Map<string, BookSnapshot>();
  for (let i = 0; i < unique.length; i += BOOKS_CHUNK) {
    const chunk = unique.slice(i, i + BOOKS_CHUNK);
    let books: RawBook[];
    try {
      books = await postChunk(chunk);
    } catch {
      continue; // chunk unavailable: those assets stay unmarked (fail-closed)
    }
    for (const book of books) {
      const asset = typeof book.asset_id === "string" ? book.asset_id : null;
      if (!asset) continue;
      const bid = best(book.bids, "max");
      const ask = best(book.asks, "min");
      const ts = Number(book.timestamp);
      out.set(asset, {
        bid: bid.price,
        ask: ask.price,
        bidDepth: bid.size,
        askDepth: ask.size,
        ts: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
      });
    }
  }
  return out;
}
