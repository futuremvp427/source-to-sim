/**
 * PostgREST returns at most `PAGE_ROWS` rows per request regardless of `.limit()`.
 * Any full-history read (event replay, observation scoring) MUST page with
 * explicit ranges, otherwise it silently sees only the first page and derives
 * wrong totals.
 */

export const PAGE_ROWS = 1000;

/** Hard stop so a runaway table can never loop forever. */
export const MAX_PAGES = 200;

export type PagedResult<T> = {
  rows: T[];
  pages: number;
  /** False when MAX_PAGES was hit, i.e. the read is truncated and unsafe to trust. */
  complete: boolean;
};

/**
 * Reads every row by requesting successive [from, to] ranges until a short page
 * arrives. `fetchPage` must apply a stable total ordering.
 */
export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  options: { pageRows?: number; maxPages?: number } = {},
): Promise<PagedResult<T>> {
  const pageRows = options.pageRows ?? PAGE_ROWS;
  const maxPages = options.maxPages ?? MAX_PAGES;
  const rows: T[] = [];
  let pages = 0;

  while (pages < maxPages) {
    const from = pages * pageRows;
    const page = await fetchPage(from, from + pageRows - 1);
    pages += 1;
    rows.push(...page);
    if (page.length < pageRows) return { rows, pages, complete: true };
  }
  return { rows, pages, complete: false };
}
