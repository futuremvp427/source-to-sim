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
    | { type: "lt"; col: string; val: string };

  function matches(row: Row, filters: Filter[]): boolean {
    for (const f of filters) {
      if (f.type === "eq" && row[f.col] !== f.val) return false;
      if (f.type === "is" && row[f.col] !== null) return false;
      if (f.type === "in" && !f.val.includes(row[f.col])) return false;
      if (f.type === "lt" && !((row[f.col] as string | null) !== null && (row[f.col] as string) < f.val)) return false;
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

const { notifyAlert, retryPendingTelegramAlerts } = await import("./notify.server");

const ALERT = { level: "info", kind: "new_source_trades", message: "test" };

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
