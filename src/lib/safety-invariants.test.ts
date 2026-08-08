import { describe, expect, it } from "vitest";

import { decideResolution, settlementCredit } from "./settlement-core";
import { buildTradesUrl, workerIdFor, EXPERIMENT_NAME, WORKER_ID } from "./shadow.server";
import { normalizeSourceEvents } from "./shadow-core";

const resolvedMarket = (winnerToken: string) => ({
  closed: true,
  tokens: [
    { tokenId: "tokA", outcome: "Yes", winner: winnerToken === "tokA" },
    { tokenId: "tokB", outcome: "No", winner: winnerToken === "tokB" },
  ],
});

describe("safety invariant: experiment isolation", () => {
  it("gives every experiment its own worker/checkpoint row and its own wallet URL", () => {
    const reference = { id: "ref-id", name: EXPERIMENT_NAME };
    const candidate = { id: "cand-id", name: "SHADOW:Poligarch" };
    expect(workerIdFor(reference)).toBe(WORKER_ID);
    expect(workerIdFor(candidate)).toBe("ingest:cand-id");
    expect(workerIdFor(candidate)).not.toBe(workerIdFor(reference));
    expect(buildTradesUrl(100, 0, "0xaaa")).toContain("user=0xaaa");
    expect(buildTradesUrl(100, 0, "0xbbb")).not.toContain("0xaaa");
  });
});

describe("safety invariant: same-second distinctness and double-copy prevention", () => {
  const at = 1_786_000_000;
  const raw = [
    { transactionHash: "0xdead", logIndex: 0, asset: "tokA", side: "BUY", size: 5, price: 0.4, timestamp: at, title: "M" },
    { transactionHash: "0xdead", logIndex: 1, asset: "tokA", side: "BUY", size: 5, price: 0.4, timestamp: at, title: "M" },
  ];

  it("keeps two legitimate identical same-second fills as distinct events", () => {
    const events = normalizeSourceEvents(raw as never, "0xwallet");
    expect(events).toHaveLength(2);
    expect(events[0]!.eventKey).not.toBe(events[1]!.eventKey);
  });

  it("derives a stable key so a re-poll of the same fill cannot copy twice", () => {
    const a = normalizeSourceEvents(raw as never, "0xwallet")[0]!;
    const b = normalizeSourceEvents(raw as never, "0xwallet")[0]!;
    expect(a.eventKey).toBe(b.eventKey);
    expect(a.identityBasis).toBe("tx_hash_log_index");
  });
});

describe("safety invariant: settlement is verified and idempotent", () => {
  it("refuses to settle an open or ambiguous market", () => {
    expect(decideResolution("tokA", { closed: false, tokens: resolvedMarket("tokA").tokens }).verified).toBe(false);
    expect(
      decideResolution("tokA", {
        closed: true,
        tokens: [
          { tokenId: "tokA", outcome: "Yes", winner: true },
          { tokenId: "tokB", outcome: "No", winner: true },
        ],
      }).verified,
    ).toBe(false);
  });

  it("credits exactly $1 per winning share and $0 for a loss", () => {
    const win = decideResolution("tokA", resolvedMarket("tokA"));
    const loss = decideResolution("tokA", resolvedMarket("tokB"));
    expect(win.verified && win.payoutPerShare).toBe(1);
    expect(loss.verified && loss.payoutPerShare).toBe(0);
    expect(settlementCredit({ shares: 25, costBasis: 10, payoutPerShare: 1 })).toEqual({
      payout: 25,
      realizedPnl: 15,
    });
    expect(settlementCredit({ shares: 25, costBasis: 10, payoutPerShare: 0 })).toEqual({
      payout: 0,
      realizedPnl: -10,
    });
  });

  it("computes the same credit on replay, so a repeated pass cannot change the book", () => {
    const first = settlementCredit({ shares: 12.5, costBasis: 6.25, payoutPerShare: 1 });
    const second = settlementCredit({ shares: 12.5, costBasis: 6.25, payoutPerShare: 1 });
    expect(second).toEqual(first);
  });
});
