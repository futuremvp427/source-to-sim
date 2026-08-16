import { describe, expect, it } from "vitest";

import { formatPaperBuyMessage } from "./paper-buy-notifications.server";

describe("paper BUY Telegram message", () => {
  it("labels the alert as an executed paper BUY and includes execution details", () => {
    const message = formatPaperBuyMessage(
      "CANDIDATE: jjavi",
      [
        {
          market_title: "Will a test market resolve Yes?",
          outcome: "Yes",
          price: 0.42,
          shares: 11.9048,
          notional: 5,
          cash_after: 375,
        },
      ],
      1,
      1,
    );

    expect(message).toContain("PAPER BUY EXECUTED — CANDIDATE: jjavi");
    expect(message).toContain("$5.00");
    expect(message).toContain("11.9048 sh @ 42.0¢");
    expect(message).toContain("Yes");
    expect(message).toContain("cash $375.00");
    expect(message).toContain("Will a test market resolve Yes?");
  });

  it("marks split messages with their chunk number", () => {
    const buy = {
      market_title: "Example",
      outcome: null,
      price: 0.5,
      shares: 10,
      notional: 5,
      cash_after: 370,
    };
    expect(formatPaperBuyMessage("SHADOW V2: Poligarch", [buy], 2, 3)).toContain("(2/3)");
  });
});
