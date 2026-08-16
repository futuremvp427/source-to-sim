import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the alerts claim/retry state machine: pending
 * claim, failed retry, stale-sending recovery, status transition protection,
 * and successful notified_at completion — against a minimal in-memory fake
 * of the exact supabase-js query shapes notify.server.ts issues.
 */

type Row = Record<string, unknown>;

function makeFakeDb() {
  const tables: Record<string, Row[]> = { alerts: [] };

  type Filter =
    | { type: "eq"; col: string; val: unknown }
    | { type: "is"; col: string; val: null }
    | { type: "in"; col: string; val: unknown[] }
    | { type: "lt"; col: string; val: string }
    | { type: "gte"; col: string; val: string };

  function matches(row: Row, filters: Filter[]): boolean {
    for (const f of filters) {
      if (f.type === "eq" && row[f.col] !== f.val) return false;
      if (f.type === "is" && row[f.col] !== null) return false;
      if (f.type === "in" && !f.val.includes(row[f.col])) return false;
      if (f.type === "lt" && !((row[f.col] as string | null) !== null && (row[f.col] as string) < f.val)) return false;
      if (f.type === "gte" && !((row[f.col] as string | null) !== null && (row[f.col] as string) >= f.val)) return false;
    }
    return true;
  }

  function makeBuilder(table: string) {
    const filters: Filter[] = [];
    const orderBys: Array<{ col: string; ascending: boolean }> = [];
    let limitN: number | null = null;
    let mode: "select" | "update" = "select";
    let updatePatch: Row | null = null;

    async function execute(): Promise<{ data: Row[] | null; error: null }> {
      if (mode === "update") {
        const rows = tables[table]!.filter((r) => matches(r, filters));
        for (const r of rows) Object.assign(r, updatePatch);
        return { data: rows.map((r) => ({ id: r["id"] })), error: null };
      }
      let rows = tables[table]!.filter((r) => matches(r, filters));
      for (const ob of [...orderBys].reverse()) {
        rows = [...rows].sort((a, b) => {
          const av = a[ob.col] as string;
          const bv = b[ob.col] as string;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (ob.ascending ? 1 : -1);
        });
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return { data: rows, error: null };
    }

    const builder = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push({ type: "eq", col, val });
        return builder;
      },
      is(col: string, val: null) {
        filters.push({ type: "is", col, val });
        return builder;
      },
      in(col: string, val: unknown[]) {
        filters.push({ type: "in", col, val });
        return builder;
      },
      lt(col: string, val: string) {
        filters.push({ type: "lt", col, val });
        return builder;
      },
      gte(col: string, val: string) {
        filters.push({ type: "gte", col, val });
        return builder;
      },
      order(col: string, opts: { ascending: boolean }) {
        orderBys.push({ col, ascending: opts.ascending });
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      update(patch: Row) {
        mode = "update";
        updatePatch = patch;
        return builder;
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return execute().then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    tables,
    supabaseAdmin: { from: (table: string) => makeBuilder(table) },
  };
}

const fake = makeFakeDb();

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return fake.supabaseAdmin;
  },
}));

const { notifyAlert, retryPendingTelegramAlerts, isImportantAlertKind, shouldDisableTelegramNotification } = await import("./notify.server");

const ALERT = { level: "info", kind: "paper_buy", message: "test" };

beforeEach(() => {
  fake.tables["alerts"]!.length = 0;
  process.env["TELEGRAM_BOT_TOKEN"] = "test-token";
  process.env["TELEGRAM_CHAT_ID"] = "test-chat";
});

afterEach(() => {
  delete process.env["TELEGRAM_BOT_TOKEN"];
  delete process.env["TELEGRAM_CHAT_ID"];
  vi.unstubAllGlobals();
});

function mockFetchOk(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  );
}

describe("pending claim and successful completion", () => {
  it("claims a pending alert, sends it, and marks notified_at + sent", async () => {
    mockFetchOk();
    fake.tables["alerts"]!.push({
      id: "a1",
      ...ALERT,
      notified_at: null,
      notification_status: "pending",
      notification_attempted_at: null,
    });
    const result = await notifyAlert({ id: "a1", ...ALERT });
    expect(result.sent).toBe(true);
    const row = fake.tables["alerts"]!.find((r) => r["id"] === "a1")!;
    expect(row["notification_status"]).toBe("sent");
    expect(row["notified_at"]).not.toBeNull();
  });
});

describe("failed retry", () => {
  it("re-claims and successfully retries a previously-failed alert", async () => {
    mockFetchOk();
    fake.tables["alerts"]!.push({
      id: "a1",
      ...ALERT,
      notified_at: null,
      notification_status: "failed",
      notification_attempted_at: "2026-08-01T00:00:00.000Z",
    });
    const result = await notifyAlert({ id: "a1", ...ALERT });
    expect(result.sent).toBe(true);
    const row = fake.tables["alerts"]!.find((r) => r["id"] === "a1")!;
    expect(row["notification_status"]).toBe("sent");
  });

  it("filters non-important rows before LIMIT so old in-app alerts cannot starve a new paper BUY", async () => {
    mockFetchOk();
    for (let i = 0; i < 25; i += 1) {
      fake.tables["alerts"]!.push({
        id: `noise-${i}`,
        level: "info",
        kind: "paper_copy_skips",
        message: "in-app only",
        notified_at: null,
        notification_status: "pending",
        notification_attempted_at: null,
        created_at: `2026-08-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }
    fake.tables["alerts"]!.push({
      id: "buy-1",
      level: "info",
      kind: "paper_buy",
      message: "actual paper buy",
      notified_at: null,
      notification_status: "pending",
      notification_attempted_at: null,
      created_at: "2026-08-16T17:30:00.000Z",
    });

    const result = await retryPendingTelegramAlerts(1);
    expect(result).toEqual({ attempted: 1, sent: 1 });
    expect(fake.tables["alerts"]!.find((r) => r["id"] === "buy-1")?.["notification_status"]).toBe("sent");
    expect(fake.tables["alerts"]!.filter((r) => String(r["id"]).startsWith("noise-")).every((r) => r["notification_status"] === "pending")).toBe(true);
  });
});

describe("status transition protection", () => {
  it("refuses to claim an already-sent alert (notified_at already set)", async () => {
    mockFetchOk();
    fake.tables["alerts"]!.push({
      id: "a1",
      ...ALERT,
      notified_at: "2026-08-01T00:00:00.000Z",
      notification_status: "sent",
      notification_attempted_at: "2026-08-01T00:00:00.000Z",
    });
    const result = await notifyAlert({ id: "a1", ...ALERT });
    expect(result.sent).toBe(false);
    expect(result.status).toBe("SKIPPED");
    const row = fake.tables["alerts"]!.find((r) => r["id"] === "a1")!;
    expect(row["notification_status"]).toBe("sent"); // untouched
  });

  it("does not touch or retry a fresh (not-yet-stale) 'sending' row", async () => {
    mockFetchOk();
    fake.tables["alerts"]!.push({
      id: "a1",
      ...ALERT,
      notified_at: null,
      notification_status: "sending",
      notification_attempted_at: new Date().toISOString(),
    });
    const result = await retryPendingTelegramAlerts();
    expect(result.attempted).toBe(0);
    const row = fake.tables["alerts"]!.find((r) => r["id"] === "a1")!;
    expect(row["notification_status"]).toBe("sending"); // still owned by whoever is sending it
  });
});

describe("stale-sending recovery", () => {
  it("resets an old 'sending' claim to failed and then successfully retries it in the same pass", async () => {
    mockFetchOk();
    fake.tables["alerts"]!.push({
      id: "a1",
      ...ALERT,
      notified_at: null,
      notification_status: "sending",
      notification_attempted_at: "2020-01-01T00:00:00.000Z", // far in the past
      created_at: "2020-01-01T00:00:00.000Z",
    });
    const result = await retryPendingTelegramAlerts();
    expect(result.attempted).toBe(1);
    expect(result.sent).toBe(1);
    const row = fake.tables["alerts"]!.find((r) => r["id"] === "a1")!;
    expect(row["notification_status"]).toBe("sent");
    expect(row["notified_at"]).not.toBeNull();
  });
});

describe("at-least-once delivery is documented, not claimed as exactly-once", () => {
  it("the source explicitly documents at-least-once semantics and the duplicate-delivery window", () => {
    const src = readFileSync(new URL("./notify.server.ts", import.meta.url), "utf8");
    expect(src).toMatch(/at-least-once/i);
    expect(src).not.toMatch(/exactly-once delivery is (guaranteed|achieved)/i);
  });
});

const HOUR = 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function pushAlert(row: Row): void {
  fake.tables["alerts"]!.push({
    notified_at: null,
    notification_status: "pending",
    notification_attempted_at: null,
    level: "warn",
    message: "m",
    ...row,
  });
}

const statusOf = (id: string) => fake.tables["alerts"]!.find((r) => r["id"] === id)?.["notification_status"];

describe("two-tier retry priority", () => {
  it("attempts the fresh paper_buy first even with 200 older operational alerts and limit=1", async () => {
    mockFetchOk();
    for (let i = 0; i < 100; i += 1) {
      pushAlert({ id: `settled-${i}`, kind: "position_settled", created_at: iso(6 * HOUR + i) });
      pushAlert({ id: `poll-${i}`, kind: "poll_failure", created_at: iso(6 * HOUR + i) });
    }
    pushAlert({ id: "buy-1", kind: "paper_buy", level: "info", created_at: iso(60_000) });

    expect(await retryPendingTelegramAlerts(1)).toEqual({ attempted: 1, sent: 1 });
    expect(statusOf("buy-1")).toBe("sent");
    expect(fake.tables["alerts"]!.filter((r) => r["kind"] !== "paper_buy").every((r) => r["notification_status"] === "pending")).toBe(true);
  });

  it("delivers the older paper_buy first (FIFO among BUYs)", async () => {
    mockFetchOk();
    pushAlert({ id: "buy-new", kind: "paper_buy", created_at: iso(60_000) });
    pushAlert({ id: "buy-old", kind: "paper_buy", created_at: iso(10 * HOUR) });
    expect(await retryPendingTelegramAlerts(1)).toEqual({ attempted: 1, sent: 1 });
    expect(statusOf("buy-old")).toBe("sent");
    expect(statusOf("buy-new")).toBe("pending");
  });

  it("selects all 7 pending paper_buy rows before any tier-2 row and never exceeds the total limit", async () => {
    mockFetchOk();
    for (let i = 0; i < 7; i += 1) pushAlert({ id: `buy-${i}`, kind: "paper_buy", created_at: iso(5 * HOUR - i) });
    for (let i = 0; i < 40; i += 1) pushAlert({ id: `fresh-${i}`, kind: "poll_failure", created_at: iso(30 * 60 * 1000 + i) });

    const result = await retryPendingTelegramAlerts(20);
    expect(result.attempted).toBe(20);
    expect(result.sent).toBe(20);
    for (let i = 0; i < 7; i += 1) expect(statusOf(`buy-${i}`)).toBe("sent");
    expect(fake.tables["alerts"]!.filter((r) => r["kind"] === "poll_failure" && r["notification_status"] === "sent")).toHaveLength(13);
  });

  it("never retries an operational alert older than the 2-hour window, but keeps the row stored", async () => {
    mockFetchOk();
    pushAlert({ id: "ancient", kind: "position_settled", created_at: iso(200 * HOUR) });
    expect(await retryPendingTelegramAlerts(20)).toEqual({ attempted: 0, sent: 0 });
    expect(statusOf("ancient")).toBe("pending");
    expect(fake.tables["alerts"]!).toHaveLength(1);
  });

  it("delivers a fresh poll_failure with the capacity left after pending BUYs", async () => {
    mockFetchOk();
    pushAlert({ id: "buy-1", kind: "paper_buy", created_at: iso(HOUR) });
    pushAlert({ id: "poll-fresh", kind: "poll_failure", created_at: iso(5 * 60 * 1000) });
    expect(await retryPendingTelegramAlerts(5)).toEqual({ attempted: 2, sent: 2 });
    expect(statusOf("buy-1")).toBe("sent");
    expect(statusOf("poll-fresh")).toBe("sent");
  });

  it("keeps new_source_trades out of Telegram while paper_buy stays important and non-silent", async () => {
    mockFetchOk();
    pushAlert({ id: "src-1", kind: "new_source_trades", created_at: iso(60_000) });
    expect(isImportantAlertKind("new_source_trades")).toBe(false);
    expect(isImportantAlertKind("paper_buy")).toBe(true);
    expect(shouldDisableTelegramNotification("info", "paper_buy")).toBe(false);
    expect(await retryPendingTelegramAlerts(20)).toEqual({ attempted: 0, sent: 0 });
    expect(statusOf("src-1")).toBe("pending");
  });

  it("keeps a failed paper_buy retryable and introduces no delete/purge path", async () => {
    mockFetchOk();
    pushAlert({ id: "buy-failed", kind: "paper_buy", notification_status: "failed", notification_attempted_at: iso(10 * 60 * 1000), created_at: iso(3 * HOUR) });
    expect(await retryPendingTelegramAlerts(5)).toEqual({ attempted: 1, sent: 1 });
    expect(statusOf("buy-failed")).toBe("sent");
    const src = readFileSync(new URL("./notify.server.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\.delete\(|truncate/i);
  });
});
