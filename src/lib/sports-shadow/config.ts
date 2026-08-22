/**
 * Sports Forward Shadow worker configuration — PURE parsing/validation only.
 *
 * Turns raw environment strings into a validated SportsShadowConfig, or an explicit
 * failure reason. No process.env access here (that belongs to worker.server.ts's env
 * read) — this module only ever sees a plain Record so tests can inject config
 * directly rather than mutate real environment globals.
 *
 * Fails CLOSED throughout: any malformed/missing required value when the feature is
 * enabled produces a ConfigResult with ok:false, which the orchestrator must treat as
 * "do no source-forward work this cycle" rather than guessing a default.
 */

/** Sane bounded ceiling on the configured wallet cohort — well above the known 3-wallet Phase 1 cohort, but never unbounded. */
export const SPORTS_SHADOW_WALLET_MAX = 10;

const WALLET_PATTERN = /^0x[0-9a-f]{40}$/;

export type SportsShadowConfig = {
  enabled: boolean;
  /** Lowercase, deduplicated, validated 0x+40-hex addresses. Empty when disabled. */
  wallets: string[];
  /** Epoch ms. Null when disabled (irrelevant); always a finite number when enabled. */
  goLiveAtMs: number | null;
  /**
   * FINAL BUILD Part 17/analytics: attached to every experiment epoch created from this
   * config (epoch.server.ts's ensureCurrentEpoch) so a milestone snapshot can always name
   * the exact code revision it was produced under. Metadata only -- never fails config
   * validation when absent, unlike wallets/goLiveAt which are safety-relevant.
   */
  gitSha: string;
};

export type ConfigResult = { ok: true; config: SportsShadowConfig } | { ok: false; reason: string };

function parseWallets(raw: string): { ok: true; wallets: string[] } | { ok: false; reason: string } {
  let rawList: string[];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ok: false, reason: "SPORTS_SHADOW_WALLETS looks like JSON but failed to parse" };
    }
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
      return { ok: false, reason: "SPORTS_SHADOW_WALLETS JSON must be an array of strings" };
    }
    rawList = parsed;
  } else {
    rawList = trimmed.split(",").map((s) => s.trim());
  }

  const seen = new Set<string>();
  const wallets: string[] = [];
  for (const entry of rawList) {
    if (entry.length === 0) continue;
    const lower = entry.toLowerCase();
    if (!WALLET_PATTERN.test(lower)) {
      return { ok: false, reason: `SPORTS_SHADOW_WALLETS contains a malformed address (expected 0x + 40 hex chars): '${entry}'` };
    }
    if (!seen.has(lower)) {
      seen.add(lower);
      wallets.push(lower);
    }
  }

  if (wallets.length === 0) {
    return { ok: false, reason: "SPORTS_SHADOW_WALLETS is enabled but resolves to an empty wallet cohort" };
  }
  if (wallets.length > SPORTS_SHADOW_WALLET_MAX) {
    return { ok: false, reason: `SPORTS_SHADOW_WALLETS has ${wallets.length} addresses, exceeding the bounded maximum of ${SPORTS_SHADOW_WALLET_MAX}` };
  }
  // Sorted (not just deduplicated) so wallet processing order is fully deterministic
  // regardless of any incidental ordering in the raw env string.
  wallets.sort();
  return { ok: true, wallets };
}

function parseGoLiveAt(raw: string): { ok: true; goLiveAtMs: number } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "SPORTS_SHADOW_GO_LIVE_AT is enabled but missing" };
  // Strict: only a real, parseable ISO-8601 (or otherwise Date-parseable) timestamp is
  // accepted. Never defaults to Date.now() — a fixed, durable configuration value must
  // produce the identical goLiveAtMs on every invocation, forever, regardless of when
  // that invocation happens to run.
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    return { ok: false, reason: `SPORTS_SHADOW_GO_LIVE_AT is not a parseable timestamp: '${raw}'` };
  }
  return { ok: true, goLiveAtMs: ms };
}

/**
 * `env` is a plain string map (e.g. `process.env` at the call site, or an injected
 * fixture in tests) — this function performs no I/O and has no side effects.
 */
export function parseSportsShadowConfig(env: Record<string, string | undefined>): ConfigResult {
  const enabledRaw = (env["SPORTS_SHADOW_ENABLED"] ?? "").trim().toLowerCase();
  const enabled = enabledRaw === "true" || enabledRaw === "1";

  const gitSha = (env["SPORTS_SHADOW_GIT_SHA"] ?? "").trim() || "unknown";

  if (!enabled) {
    return { ok: true, config: { enabled: false, wallets: [], goLiveAtMs: null, gitSha } };
  }

  const walletsRaw = env["SPORTS_SHADOW_WALLETS"] ?? "";
  const walletsResult = parseWallets(walletsRaw);
  if (!walletsResult.ok) return { ok: false, reason: walletsResult.reason };

  const goLiveRaw = env["SPORTS_SHADOW_GO_LIVE_AT"] ?? "";
  const goLiveResult = parseGoLiveAt(goLiveRaw);
  if (!goLiveResult.ok) return { ok: false, reason: goLiveResult.reason };

  return {
    ok: true,
    config: { enabled: true, wallets: walletsResult.wallets, goLiveAtMs: goLiveResult.goLiveAtMs, gitSha },
  };
}

/**
 * Constant-time-irrelevant but explicit fail-closed comparison for the scheduler hook
 * secret: an absent/empty expected secret (env var not configured) or a missing/mismatched
 * provided header both fail identically, so a misconfigured deployment can never be
 * accidentally left open.
 */
export function checkSportsShadowSecret(provided: string | null, expected: string | undefined): boolean {
  const exp = expected ?? "";
  return exp.length > 0 && provided === exp;
}

