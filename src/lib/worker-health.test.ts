import { describe, expect, it } from "vitest";

import {
  classifyWorker,
  findAbandonedWorkers,
  orderByStaleness,
  type WorkerRow,
} from "./worker-health";

const NOW = Date.parse("2026-08-12T00:00:00.000Z");
const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

function row(patch: Partial<WorkerRow>): WorkerRow {
  return {
    id: "ingest:x",
    state: "idle",
    heartbeat_at: iso(5),
    last_poll_at: iso(30),
    last_success_at: iso(30),
    lease_expires_at: iso(30),
    poll_failures: 0,
    ...patch,
  };
}

describe("worker health classification", () => {
  it("passes a worker that recently completed a cycle", () => {
    expect(classifyWorker(row({}), NOW).status).toBe("PASS");
  });

  it("does not trust a fresh heartbeat when no cycle has completed", () => {
    const stuck = row({
      state: "running",
      heartbeat_at: iso(2),
      last_poll_at: iso(21_000),
      last_success_at: iso(21_000),
      lease_expires_at: new Date(NOW + 120_000).toISOString(),
    });
    const verdict = classifyWorker(stuck, NOW);
    expect(verdict.status).toBe("FAIL");
    expect(verdict.successAgeSeconds).toBe(21_000);
  });

  it("flags a running row whose lease already lapsed as abandoned", () => {
    const abandoned = row({ state: "running", lease_expires_at: iso(10), last_poll_at: iso(1200) });
    expect(classifyWorker(abandoned, NOW).abandoned).toBe(true);
    expect(findAbandonedWorkers([abandoned, row({})], NOW)).toHaveLength(1);
  });

  it("treats a never-completed worker as FAIL", () => {
    expect(classifyWorker(row({ last_poll_at: null, last_success_at: null }), NOW).status).toBe("FAIL");
  });

  it("warns between the warn and fail windows", () => {
    expect(classifyWorker(row({ last_success_at: iso(900), last_poll_at: iso(900) }), NOW).status).toBe("WARN");
  });
});

describe("starvation-free ordering", () => {
  it("serves the least recently completed worker first", () => {
    const items = [{ name: "a" }, { name: "b" }, { name: "c" }];
    const ages: Record<string, number | null> = { a: NOW - 1000, b: NOW - 90_000, c: NOW - 5000 };
    expect(orderByStaleness(items, (i) => ages[i.name] ?? null).map((i) => i.name)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("puts never-run workers first and is deterministic on ties", () => {
    const items = [{ name: "z" }, { name: "a" }, { name: "n" }];
    const ages: Record<string, number | null> = { z: NOW, a: NOW, n: null };
    expect(orderByStaleness(items, (i) => ages[i.name] ?? null).map((i) => i.name)).toEqual([
      "n",
      "a",
      "z",
    ]);
  });
});
