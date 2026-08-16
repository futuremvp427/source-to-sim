import { describe, expect, it } from "vitest";

import { isImportantAlertKind, shouldDisableTelegramNotification } from "./notify.server";

describe("notification routing", () => {
  it("notifies only important alert kinds", () => {
    expect(isImportantAlertKind("paper_buy")).toBe(true);
    expect(isImportantAlertKind("paper_sell")).toBe(true);
    expect(isImportantAlertKind("settlement")).toBe(true);
    expect(isImportantAlertKind("position_settled")).toBe(true);
    expect(isImportantAlertKind("LOW_SPENDABLE_CASH")).toBe(true);
    expect(isImportantAlertKind("CASH_RESERVE_REACHED")).toBe(true);
    expect(isImportantAlertKind("poll_failure")).toBe(true);
    expect(isImportantAlertKind("reconciliation_mismatch")).toBe(true);
    expect(isImportantAlertKind("reconciliation_incomplete")).toBe(true);
    expect(isImportantAlertKind("paper_copy_skips")).toBe(false);
    expect(isImportantAlertKind("follower_started")).toBe(false);
  });

  it("no longer pushes new_source_trades to Telegram (diagnostics-only)", () => {
    expect(isImportantAlertKind("new_source_trades")).toBe(false);
  });

  it("delivers actual paper BUY alerts as normal pushes while ordinary info stays silent", () => {
    expect(shouldDisableTelegramNotification("info", "paper_buy")).toBe(false);
    expect(shouldDisableTelegramNotification("info", "new_source_trades")).toBe(true);
    expect(shouldDisableTelegramNotification("warn", "poll_failure")).toBe(false);
  });
});
