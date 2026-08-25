import { describe, expect, it } from "vitest";
import { checkSportsShadowSecret, parseSportsShadowConfig, SPORTS_SHADOW_WALLET_MAX } from "./config";

const WALLET_A = "0xa71093cafc0c099b4ccab24c3cb8018d817923c4";
const WALLET_B = "0x32ed517a571c01b6e9adecf61ba81ca48ff2f960";

describe("parseSportsShadowConfig — disabled", () => {
  it("absent SPORTS_SHADOW_ENABLED disables everything", () => {
    const result = parseSportsShadowConfig({});
    expect(result).toEqual({ ok: true, config: { enabled: false, wallets: [], goLiveAtMs: null, gitSha: "unknown" } });
  });

  it("SPORTS_SHADOW_ENABLED=false disables everything", () => {
    const result = parseSportsShadowConfig({ SPORTS_SHADOW_ENABLED: "false" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.config.enabled).toBe(false);
  });

  it("disabled config never validates wallets/goLiveAt, even if malformed", () => {
    const result = parseSportsShadowConfig({ SPORTS_SHADOW_ENABLED: "false", SPORTS_SHADOW_WALLETS: "not-an-address", SPORTS_SHADOW_GO_LIVE_AT: "garbage" });
    expect(result.ok).toBe(true);
  });
});

describe("parseSportsShadowConfig — gitSha", () => {
  it("fails closed when enabled and no deployment SHA is available", () => {
    const result = parseSportsShadowConfig({ SPORTS_SHADOW_ENABLED: "true", SPORTS_SHADOW_WALLETS: WALLET_A, SPORTS_SHADOW_GO_LIVE_AT: "2026-08-19T00:00:00Z" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/deployment commit sha/i);
  });

  it("passes through SPORTS_SHADOW_GIT_SHA when set", () => {
    const result = parseSportsShadowConfig({
      SPORTS_SHADOW_ENABLED: "true",
      SPORTS_SHADOW_WALLETS: WALLET_A,
      SPORTS_SHADOW_GO_LIVE_AT: "2026-08-19T00:00:00Z",
      SPORTS_SHADOW_GIT_SHA: "abc1234",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.config.gitSha).toBe("abc1234");
  });

  it("prefers provider deployment SHA over a stale manual SPORTS_SHADOW_GIT_SHA", () => {
    const result = parseSportsShadowConfig({
      SPORTS_SHADOW_ENABLED: "true",
      SPORTS_SHADOW_WALLETS: WALLET_A,
      SPORTS_SHADOW_GO_LIVE_AT: "2026-08-19T00:00:00Z",
      CF_PAGES_COMMIT_SHA: "09faae89f97f4e128f6f1318b1ded558afd8096c",
      SPORTS_SHADOW_GIT_SHA: "e2ac939a89ccba5964930d4e147f8dc855ca51f4",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.config.gitSha).toBe("09faae89f97f4e128f6f1318b1ded558afd8096c");
  });

  it("rejects invalid deployment SHA values when enabled", () => {
    const result = parseSportsShadowConfig({
      SPORTS_SHADOW_ENABLED: "true",
      SPORTS_SHADOW_WALLETS: WALLET_A,
      SPORTS_SHADOW_GO_LIVE_AT: "2026-08-19T00:00:00Z",
      SPORTS_SHADOW_GIT_SHA: "not-a-sha",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/git commit sha/i);
  });
});

describe("parseSportsShadowConfig — enabled, wallets", () => {
  it("accepts a comma-separated list, normalizes to lowercase, dedupes, and sorts deterministically", () => {
    const result = parseSportsShadowConfig({
      SPORTS_SHADOW_ENABLED: "true",
      SPORTS_SHADOW_WALLETS: `${WALLET_A.toUpperCase()},${WALLET_B},${WALLET_A}`,
      SPORTS_SHADOW_GO_LIVE_AT: "2026-08-19T00:00:00Z",
      SPORTS_SHADOW_GIT_SHA: "abcdef1",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.config.wallets).toEqual([WALLET_A, WALLET_B].sort());
  });

  it("accepts a JSON array form", () => {
    const result = parseSportsShadowConfig({
      SPORTS_SHADOW_ENABLED: "true",
      SPORTS_SHADOW_WALLETS: JSON.stringify([WALLET_A, WALLET_B]),
      SPORTS_SHADOW_GO_LIVE_AT: "2026-08-19T00:00:00Z",
      SPORTS_SHADOW_GIT_SHA: "abcdef1",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects malformed addresses rather than silently dropping them", () => {
    const result = parseSportsShadowConfig({ SPORTS_SHADOW_ENABLED: "true", SPORTS_SHADOW_WALLETS: `${WALLET_A},not-a-wallet`, SPORTS_SHADOW_GO_LIVE_AT: "2026-08-19T00:00:00Z", SPORTS_SHADOW_GIT_SHA: "abcdef1" });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty resolved cohort", () => {
    const result = parseSportsShadowConfig({ SPORTS_SHADOW_ENABLED: "true", SPORTS_SHADOW_WALLETS: "  ,  ", SPORTS_SHADOW_GO_LIVE_AT: "2026-08-19T00:00:00Z", SPORTS_SHADOW_GIT_SHA: "abcdef1" });
    expect(result.ok).toBe(false);
  });

  it("rejects a cohort exceeding SPORTS_SHADOW_WALLET_MAX", () => {
    const many = Array.from({ length: SPORTS_SHADOW_WALLET_MAX + 1 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`).join(",");
    const result = parseSportsShadowConfig({ SPORTS_SHADOW_ENABLED: "true", SPORTS_SHADOW_WALLETS: many, SPORTS_SHADOW_GO_LIVE_AT: "2026-08-19T00:00:00Z", SPORTS_SHADOW_GIT_SHA: "abcdef1" });
    expect(result.ok).toBe(false);
  });

  it("missing SPORTS_SHADOW_WALLETS while enabled fails closed", () => {
    const result = parseSportsShadowConfig({ SPORTS_SHADOW_ENABLED: "true", SPORTS_SHADOW_GO_LIVE_AT: "2026-08-19T00:00:00Z", SPORTS_SHADOW_GIT_SHA: "abcdef1" });
    expect(result.ok).toBe(false);
  });
});

describe("parseSportsShadowConfig — enabled, go-live", () => {
  it("requires SPORTS_SHADOW_GO_LIVE_AT when enabled", () => {
    const result = parseSportsShadowConfig({ SPORTS_SHADOW_ENABLED: "true", SPORTS_SHADOW_WALLETS: WALLET_A, SPORTS_SHADOW_GIT_SHA: "abcdef1" });
    expect(result.ok).toBe(false);
  });

  it("rejects an unparseable go-live timestamp", () => {
    const result = parseSportsShadowConfig({ SPORTS_SHADOW_ENABLED: "true", SPORTS_SHADOW_WALLETS: WALLET_A, SPORTS_SHADOW_GO_LIVE_AT: "not-a-date", SPORTS_SHADOW_GIT_SHA: "abcdef1" });
    expect(result.ok).toBe(false);
  });

  it("parses a valid ISO timestamp to a fixed epoch-ms value, never Date.now()", () => {
    const result = parseSportsShadowConfig({ SPORTS_SHADOW_ENABLED: "true", SPORTS_SHADOW_WALLETS: WALLET_A, SPORTS_SHADOW_GO_LIVE_AT: "2026-08-19T00:00:00Z", SPORTS_SHADOW_GIT_SHA: "abcdef1" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.config.goLiveAtMs).toBe(Date.parse("2026-08-19T00:00:00Z"));
  });

  it("the same config string always produces the identical goLiveAtMs across repeated calls (fixed/durable, not wall-clock-derived)", () => {
    const env = { SPORTS_SHADOW_ENABLED: "true", SPORTS_SHADOW_WALLETS: WALLET_A, SPORTS_SHADOW_GO_LIVE_AT: "2026-08-19T00:00:00Z", SPORTS_SHADOW_GIT_SHA: "abcdef1" };
    const first = parseSportsShadowConfig(env);
    const second = parseSportsShadowConfig(env);
    expect(first.ok && second.ok && first.config.goLiveAtMs === second.config.goLiveAtMs).toBe(true);
  });
});

describe("checkSportsShadowSecret", () => {
  it("rejects a missing header", () => {
    expect(checkSportsShadowSecret(null, "expected-secret")).toBe(false);
  });

  it("rejects a wrong secret", () => {
    expect(checkSportsShadowSecret("wrong", "expected-secret")).toBe(false);
  });

  it("accepts a matching secret", () => {
    expect(checkSportsShadowSecret("expected-secret", "expected-secret")).toBe(true);
  });

  it("fails closed when the expected env secret is undefined, even if a header happens to be an empty string", () => {
    expect(checkSportsShadowSecret("", undefined)).toBe(false);
  });

  it("fails closed when the expected env secret is an empty string, even for an empty provided header", () => {
    expect(checkSportsShadowSecret("", "")).toBe(false);
  });
});
