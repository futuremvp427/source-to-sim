import { describe, expect, it } from "vitest";

import { isImportantAlertKind } from "./notify.server";

describe("notification routing", () => {
  it("notifies only important alert kinds", () => {
    expect(isImportantAlertKind("new_source_trades")).toBe(true);
    expect(isImportantAlertKind("LOW_SPENDABLE_CASH")).toBe(true);
    expect(isImportantAlertKind("CASH_RESERVE_REACHED")).toBe(true);
    expect(isImportantAlertKind("poll_failure")).toBe(true);
    expect(isImportantAlertKind("reconciliation_mismatch")).toBe(true);
    expect(isImportantAlertKind("paper_copy_skips")).toBe(false);
    expect(isImportantAlertKind("follower_started")).toBe(false);
  });
});