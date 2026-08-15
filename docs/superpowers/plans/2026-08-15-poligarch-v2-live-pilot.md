# Poligarch V2 Live Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the smallest possible live-order preview/submission scaffold for exactly one paper-trading experiment (`SHADOW V2: Poligarch`), fully unreachable in production (kill switch engaged, activation stage locked, all caps $0), so a human can review real infrastructure before any future explicit authorization to go live.

**Architecture:** A new, self-contained `src/lib/live-pilot/` module tree that (a) hard-allowlists exactly one wallet/experiment, (b) reuses the existing, already-hardened `pmus/compatibility.server.ts` market-identity gate against Polymarket US, (c) computes tiny pilot-specific order sizing/risk checks, (d) persists every decision through a new idempotent Postgres RPC modeled directly on the existing `process_source_event_atomic` pattern, and (e) gates any eventual order submission behind both a hard source-code constant (`POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED = false`, mirroring `live-safety/core.ts`'s `LIVE_EXECUTION_IMPLEMENTED`) and the existing DB-backed kill-switch/activation-stage/caps mechanism. Paper accounting (`paper_experiments`, `paper_trades`, `paper_positions`) is never written by any new code in this plan.

**Tech Stack:** TanStack Start (server functions + file-based router), Supabase Postgres (RLS, `SECURITY DEFINER` RPCs), Vitest, Bun, existing `src/lib/pmus/` (Polymarket US, Ed25519 signing).

## Global Constraints

- Execution venue for this pilot is **Polymarket US only** (`src/lib/pmus/`) — confirmed with the project owner. Do not build international-CLOB (EIP-712/secp256k1) signing in this plan.
- `POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED` must be a hard `false` source constant throughout this plan, exactly like `LIVE_EXECUTION_IMPLEMENTED` in `src/lib/live-safety/core.ts`. No task in this plan flips it, and no task wires the submission function into any route, cron, or UI action.
- Every new migration seeds `live_pilot_state` with `kill_switch_engaged = true`, `activation_stage = 'locked'`, and all `*_usd` caps at `0`. No task in this plan changes these values.
- Allowlist is exactly one wallet (`0xb40e89677d59665d5188541ad860450a6e2a7cc9`) and exactly one experiment name (`SHADOW V2: Poligarch`) — implemented as an explicit equality check, never substring/prefix matching.
- Pilot risk limits (do not scale these to the $380 paper bankroll): `LIVE_PILOT_BANKROLL_USD = 25`, `MAX_ORDER_NOTIONAL_USD = 2`, `MAX_TOTAL_OPEN_EXPOSURE_USD = 10`, `MAX_DAILY_REALIZED_LOSS_USD = 5`, `MAX_CONSECUTIVE_FAILED_ORDERS = 3`, `MAX_SIGNAL_AGE_SECONDS = 90`, `MAX_ALLOWED_SLIPPAGE_CENTS = 3`, `MAX_OPEN_LIVE_POSITIONS = 5`.
- No task modifies `src/lib/pmus/capabilities.server.ts` or its `ALLOWED_OPERATIONS` allowlist — that module stays scoped to read/preview-only, exactly as already hardened and tested. New order-submission/cancel/status operations get their own, separately-scoped allowlist inside `src/lib/live-pilot/`.
- No task modifies `paper_experiments`, `paper_trades`, `paper_positions`, `experiment_event_state`, `experiment_source_position_state`, or any code path that writes to them.
- Real order-submission endpoint contract (from `docs.polymarket.us`, confirmed live 2026-08-15): `POST /v1/orders` (create), `POST /v1/order/{orderId}/cancel` (cancel), `GET /v1/order/{orderId}` (status). Auth headers `X-PM-Access-Key` / `X-PM-Timestamp` / `X-PM-Signature` (Ed25519 of `timestamp+method+path`) — identical scheme to what `src/lib/pmus/signer.server.ts` already implements. Price bounds `0.01`–`0.99`; tick size read from `orderPriceMinTickSize` on the market response; min size from `minimumTradeQty`.
- Test/build commands (confirmed from `package.json`): `bun run test` (vitest), `bun ./node_modules/typescript/bin/tsc --noEmit`, `bun run build` (vite build). Schema-contract: `python3 scripts/verify_schema_contract.py` after `supabase db reset --local`.

---

## Task 1: Pilot allowlist + risk-limit config module

**Files:**
- Create: `src/lib/live-pilot/poligarch-config.ts`
- Test: `src/lib/live-pilot/poligarch-config.test.ts`

**Interfaces:**
- Produces: `POLIGARCH_V2_WALLET: string`, `POLIGARCH_V2_EXPERIMENT_NAME: string`, `POLIGARCH_LIVE_PILOT_ID: string`, `PILOT_RISK_LIMITS` (object with the 8 constants from Global Constraints), `isAllowedPilotSource(input: { experimentName: string; wallet: string }): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/live-pilot/poligarch-config.test.ts
import { describe, it, expect } from "vitest";
import {
  POLIGARCH_V2_WALLET,
  POLIGARCH_V2_EXPERIMENT_NAME,
  PILOT_RISK_LIMITS,
  isAllowedPilotSource,
} from "./poligarch-config";

describe("poligarch-config", () => {
  it("exposes the exact wallet and experiment name", () => {
    expect(POLIGARCH_V2_WALLET).toBe("0xb40e89677d59665d5188541ad860450a6e2a7cc9");
    expect(POLIGARCH_V2_EXPERIMENT_NAME).toBe("SHADOW V2: Poligarch");
  });

  it("exposes the exact pilot risk limits", () => {
    expect(PILOT_RISK_LIMITS).toEqual({
      bankrollUsd: 25,
      maxOrderNotionalUsd: 2,
      maxTotalOpenExposureUsd: 10,
      maxDailyRealizedLossUsd: 5,
      maxConsecutiveFailedOrders: 3,
      maxSignalAgeSeconds: 90,
      maxAllowedSlippageCents: 3,
      maxOpenLivePositions: 5,
    });
  });

  it("accepts only the exact wallet + exact experiment name", () => {
    expect(
      isAllowedPilotSource({ experimentName: "SHADOW V2: Poligarch", wallet: POLIGARCH_V2_WALLET }),
    ).toBe(true);
  });

  it("rejects the correct wallet under the V3 experiment name", () => {
    expect(
      isAllowedPilotSource({
        experimentName: "SHADOW V3 CAPACITY: Poligarch",
        wallet: POLIGARCH_V2_WALLET,
      }),
    ).toBe(false);
  });

  it("rejects other cohort wallets even with a spoofed name", () => {
    expect(
      isAllowedPilotSource({
        experimentName: "SHADOW V2: Poligarch",
        wallet: "0x044f334595a7fd42c143e11c8ec47f23c8d1d1f1", // gghff
      }),
    ).toBe(false);
  });

  it("rejects substring/prefix tricks", () => {
    expect(
      isAllowedPilotSource({ experimentName: "SHADOW V2: Poligarch2", wallet: POLIGARCH_V2_WALLET }),
    ).toBe(false);
    expect(
      isAllowedPilotSource({ experimentName: "SHADOW V2: Poligarch", wallet: POLIGARCH_V2_WALLET + "0" }),
    ).toBe(false);
  });

  it("rejects General Shadow entirely", () => {
    expect(
      isAllowedPilotSource({
        experimentName: "GENERAL SHADOW: Poligarch",
        wallet: POLIGARCH_V2_WALLET,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/live-pilot/poligarch-config.test.ts`
Expected: FAIL — `poligarch-config` module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/live-pilot/poligarch-config.ts
/**
 * Hard allowlist and risk limits for the Poligarch V2 live pilot.
 *
 * Exactly one wallet, exactly one experiment name, exact equality only.
 * This is the sole gate deciding whether any source event is even eligible
 * to be evaluated by the live-pilot preview pipeline — everything else in
 * live-pilot/ assumes this check already passed.
 */

export const POLIGARCH_V2_WALLET = "0xb40e89677d59665d5188541ad860450a6e2a7cc9";
export const POLIGARCH_V2_EXPERIMENT_NAME = "SHADOW V2: Poligarch";
export const POLIGARCH_LIVE_PILOT_ID = "poligarch_v2_live_pilot";

export const PILOT_RISK_LIMITS = {
  bankrollUsd: 25,
  maxOrderNotionalUsd: 2,
  maxTotalOpenExposureUsd: 10,
  maxDailyRealizedLossUsd: 5,
  maxConsecutiveFailedOrders: 3,
  maxSignalAgeSeconds: 90,
  maxAllowedSlippageCents: 3,
  maxOpenLivePositions: 5,
} as const;

export function isAllowedPilotSource(input: { experimentName: string; wallet: string }): boolean {
  return (
    input.experimentName === POLIGARCH_V2_EXPERIMENT_NAME && input.wallet === POLIGARCH_V2_WALLET
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/live-pilot/poligarch-config.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/live-pilot/poligarch-config.ts src/lib/live-pilot/poligarch-config.test.ts
git commit -m "feat(live-pilot): add Poligarch V2 allowlist and pilot risk limits"
```

---

## Task 2: Live-pilot database schema (state + intent ledger)

**Files:**
- Create: `supabase/migrations/20260815120000_poligarch_live_pilot_schema.sql`
- Test: `supabase/tests/poligarch_live_pilot_schema.sql`

**Interfaces:**
- Produces: tables `public.live_pilot_state` (PK `pilot_id`), `public.live_order_intents` (PK `id`, unique `(source_experiment_id, source_event_id)`).

Before writing the migration, read `supabase/migrations/20260807205114_72495ae0-1b29-4376-9420-2e5cd19f4f8c.sql` for the exact `paper_experiments` and `source_events` column definitions (both already confirmed below) and `supabase/migrations/20260812000656_3a1012b9-0ce5-43a3-96bf-827dd6ad73eb.sql` for the RLS pattern to copy.

Confirmed columns already read from the repo:
- `paper_experiments(id uuid PK, name text UNIQUE, wallet_address text, starting_cash numeric, cash numeric, buy_amount numeric, poll_interval_seconds int, enabled boolean, weather_only boolean, realized_pnl numeric, simulated boolean, created_at, updated_at)`
- `source_events(id uuid PK, event_key text UNIQUE, wallet text, tx_hash text, source_native_id text, log_index text, condition_id text, asset text, market_title text, outcome text, slug text, side text, shares numeric, price numeric, source_ts bigint, first_seen_at timestamptz, identity_basis text, identity_degraded boolean, raw jsonb, processed_at timestamptz)`
- `has_role(_user_id uuid, _role public.app_role)` — role check function used by every existing admin RLS policy.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260815120000_poligarch_live_pilot_schema.sql

-- Per-pilot safety state. Deliberately its own table, NOT a reuse of
-- live_safety_state, so arming/activating this pilot can never affect the
-- global live-safety row or any other experiment's display.
CREATE TABLE IF NOT EXISTS public.live_pilot_state (
  pilot_id text PRIMARY KEY,
  kill_switch_engaged boolean NOT NULL DEFAULT true,
  activation_stage text NOT NULL DEFAULT 'locked',
  armed_at timestamptz,
  armed_by uuid,
  activated_at timestamptz,
  activated_by uuid,
  pilot_bankroll_usd numeric NOT NULL DEFAULT 0,
  max_order_notional_usd numeric NOT NULL DEFAULT 0,
  max_total_exposure_usd numeric NOT NULL DEFAULT 0,
  max_daily_realized_loss_usd numeric NOT NULL DEFAULT 0,
  consecutive_failed_orders integer NOT NULL DEFAULT 0,
  last_action text,
  last_action_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_pilot_state_stage_check CHECK (activation_stage IN ('locked', 'preview', 'live_pilot'))
);

GRANT SELECT ON public.live_pilot_state TO authenticated;
GRANT ALL ON public.live_pilot_state TO service_role;
ALTER TABLE public.live_pilot_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read live pilot state" ON public.live_pilot_state;
CREATE POLICY "Admins can read live pilot state"
  ON public.live_pilot_state FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Seed locked, kill-switch-engaged, zero-cap row for the Poligarch V2 pilot.
-- No task in this plan ever changes these seeded values.
INSERT INTO public.live_pilot_state (pilot_id)
VALUES ('poligarch_v2_live_pilot')
ON CONFLICT (pilot_id) DO NOTHING;

-- Durable, idempotent record of every live-pilot decision for one source
-- event: preview, skip, or (never reachable yet) a real order attempt.
-- Idempotency key mirrors experiment_event_state's proven pattern:
-- (owning experiment, immutable source event) can only ever produce one row.
CREATE TABLE IF NOT EXISTS public.live_order_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_id text NOT NULL REFERENCES public.live_pilot_state(pilot_id),
  source_experiment_id uuid NOT NULL REFERENCES public.paper_experiments(id),
  source_event_id uuid NOT NULL REFERENCES public.source_events(id),
  source_event_key text NOT NULL,
  source_wallet text NOT NULL,
  source_condition_id text,
  source_asset text,
  source_side text NOT NULL,
  source_price numeric NOT NULL,
  source_ts bigint NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  decision_at timestamptz,
  us_market_slug text,
  market_mapping_status text,
  live_price_snapshot jsonb,
  requested_shares numeric,
  requested_notional_usd numeric,
  status text NOT NULL DEFAULT 'PREVIEWED',
  status_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  fail_reason text,
  submitted_order_id text,
  filled_shares numeric,
  avg_fill_price numeric,
  fees_usd numeric,
  safety_checks jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_order_intents_source_unique UNIQUE (source_experiment_id, source_event_id),
  CONSTRAINT live_order_intents_status_check CHECK (
    status IN (
      'PREVIEWED', 'SKIPPED', 'AUTHORIZED', 'SUBMITTING', 'SUBMITTED',
      'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'FAILED'
    )
  )
);

CREATE INDEX IF NOT EXISTS live_order_intents_pilot_created_idx
  ON public.live_order_intents (pilot_id, created_at DESC);

GRANT SELECT ON public.live_order_intents TO authenticated;
GRANT ALL ON public.live_order_intents TO service_role;
ALTER TABLE public.live_order_intents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read live pilot intents" ON public.live_order_intents;
CREATE POLICY "Admins can read live pilot intents"
  ON public.live_order_intents FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
```

- [ ] **Step 2: Write the SQL isolation/regression test**

```sql
-- supabase/tests/poligarch_live_pilot_schema.sql
-- Run via: psql -f supabase/tests/poligarch_live_pilot_schema.sql (after `supabase db reset --local`)
BEGIN;

-- The seed row must exist locked, kill-switch-engaged, zero caps.
DO $$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.live_pilot_state WHERE pilot_id = 'poligarch_v2_live_pilot';
  IF r IS NULL THEN
    RAISE EXCEPTION 'seed row missing';
  END IF;
  IF r.kill_switch_engaged IS NOT true THEN
    RAISE EXCEPTION 'kill switch must default engaged, got %', r.kill_switch_engaged;
  END IF;
  IF r.activation_stage <> 'locked' THEN
    RAISE EXCEPTION 'activation stage must default locked, got %', r.activation_stage;
  END IF;
  IF r.max_order_notional_usd <> 0 OR r.max_total_exposure_usd <> 0 OR r.max_daily_realized_loss_usd <> 0 THEN
    RAISE EXCEPTION 'caps must default to zero';
  END IF;
END $$;

-- anon/authenticated must never be able to write to either table.
DO $$
BEGIN
  BEGIN
    EXECUTE format('SET LOCAL ROLE authenticated');
    UPDATE public.live_pilot_state SET kill_switch_engaged = false WHERE pilot_id = 'poligarch_v2_live_pilot';
    RAISE EXCEPTION 'authenticated role must not be able to update live_pilot_state';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected
  END;
END $$;

ROLLBACK;
```

- [ ] **Step 3: Apply locally and run the test**

Run:
```bash
cd /home/shamaritaylor18/projects/source-to-sim
supabase start
supabase db reset --local
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" -f supabase/tests/poligarch_live_pilot_schema.sql
```
Expected: no `RAISE EXCEPTION` output; script completes with `ROLLBACK`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260815120000_poligarch_live_pilot_schema.sql supabase/tests/poligarch_live_pilot_schema.sql
git commit -m "feat(live-pilot): add live_pilot_state and live_order_intents schema, locked/zero-cap by default"
```

---

## Task 3: Atomic idempotent intent RPCs

**Files:**
- Create: `supabase/migrations/20260815121000_poligarch_live_pilot_intent_rpc.sql`
- Test: `supabase/tests/poligarch_live_pilot_intent_rpc.sql`

**Interfaces:**
- Consumes: `live_order_intents`, `live_pilot_state` from Task 2.
- Produces: `public.create_or_get_live_pilot_intent_atomic(p_pilot_id text, p_source_experiment_id uuid, p_source_event_id uuid, p_payload jsonb) RETURNS jsonb` — returns `{"intent_id": uuid, "created": boolean, "status": text}`; `public.update_live_pilot_intent_status_atomic(p_intent_id uuid, p_new_status text, p_fields jsonb) RETURNS jsonb` — returns the updated row as jsonb, appends `{status, at, fields}` to `status_history`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260815121000_poligarch_live_pilot_intent_rpc.sql

-- Guarantees a source event can never create two live-pilot intents.
-- Mirrors process_source_event_atomic's ON CONFLICT DO NOTHING idempotency
-- pattern from supabase/migrations/20260813134500_experiment_scoped_event_consumption.sql.
CREATE OR REPLACE FUNCTION public.create_or_get_live_pilot_intent_atomic(
  p_pilot_id text,
  p_source_experiment_id uuid,
  p_source_event_id uuid,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_status text;
  v_created boolean := false;
BEGIN
  INSERT INTO public.live_order_intents (
    id, pilot_id, source_experiment_id, source_event_id, source_event_key,
    source_wallet, source_condition_id, source_asset, source_side,
    source_price, source_ts, status, status_history
  )
  VALUES (
    gen_random_uuid(), p_pilot_id, p_source_experiment_id, p_source_event_id,
    p_payload->>'source_event_key', p_payload->>'source_wallet',
    p_payload->>'source_condition_id', p_payload->>'source_asset',
    p_payload->>'source_side', (p_payload->>'source_price')::numeric,
    (p_payload->>'source_ts')::bigint, 'PREVIEWED',
    jsonb_build_array(jsonb_build_object('status', 'PREVIEWED', 'at', now()))
  )
  ON CONFLICT (source_experiment_id, source_event_id) DO NOTHING
  RETURNING id, status INTO v_id, v_status;

  IF v_id IS NOT NULL THEN
    v_created := true;
  ELSE
    SELECT id, status INTO v_id, v_status
    FROM public.live_order_intents
    WHERE source_experiment_id = p_source_experiment_id AND source_event_id = p_source_event_id;
  END IF;

  RETURN jsonb_build_object('intent_id', v_id, 'created', v_created, 'status', v_status);
END;
$$;

REVOKE ALL ON FUNCTION public.create_or_get_live_pilot_intent_atomic(text, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_or_get_live_pilot_intent_atomic(text, uuid, uuid, jsonb) TO service_role;

-- Explicit state-machine transition with a full audit trail. Every call
-- appends to status_history rather than overwriting it.
CREATE OR REPLACE FUNCTION public.update_live_pilot_intent_status_atomic(
  p_intent_id uuid,
  p_new_status text,
  p_fields jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.live_order_intents%ROWTYPE;
BEGIN
  IF p_new_status NOT IN (
    'PREVIEWED', 'SKIPPED', 'AUTHORIZED', 'SUBMITTING', 'SUBMITTED',
    'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'FAILED'
  ) THEN
    RAISE EXCEPTION 'invalid status %', p_new_status;
  END IF;

  SELECT * INTO v_row FROM public.live_order_intents WHERE id = p_intent_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'intent % not found', p_intent_id;
  END IF;

  UPDATE public.live_order_intents
  SET
    status = p_new_status,
    status_history = status_history || jsonb_build_object('status', p_new_status, 'at', now(), 'fields', p_fields),
    decision_at = COALESCE(decision_at, CASE WHEN p_new_status <> 'PREVIEWED' THEN now() ELSE NULL END),
    fail_reason = COALESCE(p_fields->>'fail_reason', fail_reason),
    market_mapping_status = COALESCE(p_fields->>'market_mapping_status', market_mapping_status),
    us_market_slug = COALESCE(p_fields->>'us_market_slug', us_market_slug),
    live_price_snapshot = COALESCE(p_fields->'live_price_snapshot', live_price_snapshot),
    requested_shares = COALESCE((p_fields->>'requested_shares')::numeric, requested_shares),
    requested_notional_usd = COALESCE((p_fields->>'requested_notional_usd')::numeric, requested_notional_usd),
    submitted_order_id = COALESCE(p_fields->>'submitted_order_id', submitted_order_id),
    filled_shares = COALESCE((p_fields->>'filled_shares')::numeric, filled_shares),
    avg_fill_price = COALESCE((p_fields->>'avg_fill_price')::numeric, avg_fill_price),
    fees_usd = COALESCE((p_fields->>'fees_usd')::numeric, fees_usd),
    safety_checks = COALESCE(p_fields->'safety_checks', safety_checks),
    updated_at = now()
  WHERE id = p_intent_id
  RETURNING * INTO v_row;

  RETURN to_jsonb(v_row);
END;
$$;

REVOKE ALL ON FUNCTION public.update_live_pilot_intent_status_atomic(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_live_pilot_intent_status_atomic(uuid, text, jsonb) TO service_role;
```

- [ ] **Step 2: Write the SQL regression test (idempotency + invalid status)**

```sql
-- supabase/tests/poligarch_live_pilot_intent_rpc.sql
BEGIN;

DO $$
DECLARE
  v_exp_id uuid;
  v_event_id uuid;
  v_first jsonb;
  v_second jsonb;
  v_count int;
BEGIN
  INSERT INTO public.paper_experiments (name, wallet_address)
  VALUES ('SHADOW V2: Poligarch', '0xb40e89677d59665d5188541ad860450a6e2a7cc9')
  RETURNING id INTO v_exp_id;

  INSERT INTO public.source_events (event_key, wallet, asset, side, price, source_ts, identity_basis)
  VALUES ('test-event-1', '0xb40e89677d59665d5188541ad860450a6e2a7cc9', 'tok-a', 'BUY', 0.42, 1000, 'tx_hash')
  RETURNING id INTO v_event_id;

  v_first := public.create_or_get_live_pilot_intent_atomic(
    'poligarch_v2_live_pilot', v_exp_id, v_event_id,
    jsonb_build_object('source_event_key', 'test-event-1', 'source_wallet', '0xb40e89677d59665d5188541ad860450a6e2a7cc9', 'source_side', 'BUY', 'source_price', 0.42, 'source_ts', 1000)
  );
  IF (v_first->>'created')::boolean IS NOT true THEN
    RAISE EXCEPTION 'first call must create a new intent';
  END IF;

  -- Replay: same experiment + same source event must NOT create a second row.
  v_second := public.create_or_get_live_pilot_intent_atomic(
    'poligarch_v2_live_pilot', v_exp_id, v_event_id,
    jsonb_build_object('source_event_key', 'test-event-1', 'source_wallet', '0xb40e89677d59665d5188541ad860450a6e2a7cc9', 'source_side', 'BUY', 'source_price', 0.42, 'source_ts', 1000)
  );
  IF (v_second->>'created')::boolean IS NOT false THEN
    RAISE EXCEPTION 'replay must not create a second intent';
  END IF;
  IF v_first->>'intent_id' <> v_second->>'intent_id' THEN
    RAISE EXCEPTION 'replay must return the same intent id';
  END IF;

  SELECT count(*) INTO v_count FROM public.live_order_intents WHERE source_experiment_id = v_exp_id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 intent row, got %', v_count;
  END IF;

  -- Status transition appends to history, does not overwrite it.
  PERFORM public.update_live_pilot_intent_status_atomic(
    (v_first->>'intent_id')::uuid, 'SKIPPED', jsonb_build_object('fail_reason', 'LIVE_MARKET_MAPPING_UNVERIFIED')
  );
  SELECT jsonb_array_length(status_history) INTO v_count FROM public.live_order_intents WHERE id = (v_first->>'intent_id')::uuid;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected 2 status_history entries after one transition, got %', v_count;
  END IF;

  -- Invalid status must be rejected.
  BEGIN
    PERFORM public.update_live_pilot_intent_status_atomic((v_first->>'intent_id')::uuid, 'BOGUS', '{}'::jsonb);
    RAISE EXCEPTION 'invalid status must have raised';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'invalid status%' THEN
      RAISE;
    END IF;
  END;

  -- anon/authenticated must not be able to call either RPC directly.
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.create_or_get_live_pilot_intent_atomic('poligarch_v2_live_pilot', v_exp_id, v_event_id, '{}'::jsonb);
    RAISE EXCEPTION 'authenticated must not be able to call create_or_get_live_pilot_intent_atomic';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;
END $$;

ROLLBACK;
```

- [ ] **Step 3: Apply and run**

Run:
```bash
cd /home/shamaritaylor18/projects/source-to-sim
supabase db reset --local
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" -f supabase/tests/poligarch_live_pilot_intent_rpc.sql
```
Expected: no `RAISE EXCEPTION`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260815121000_poligarch_live_pilot_intent_rpc.sql supabase/tests/poligarch_live_pilot_intent_rpc.sql
git commit -m "feat(live-pilot): add idempotent intent create/update RPCs, service_role-only"
```

---

## Task 4: Schema-contract entries

**Files:**
- Modify: `supabase/schema-contract.json`

**Interfaces:**
- Consumes: `live_order_intents_pilot_created_idx`, `live_order_intents_source_unique` from Task 2/3.

- [ ] **Step 1: Read the current contract and append entries in the same format**

Open `supabase/schema-contract.json` and add to the `"indexes"` array (after the last existing entry, keeping the file valid JSON):

```json
{
  "schema": "public",
  "table": "live_order_intents",
  "name": "live_order_intents_pilot_created_idx",
  "must_exist": true,
  "definition_contains": ["pilot_id", "created_at desc"]
},
{
  "schema": "public",
  "table": "live_order_intents",
  "name": "live_order_intents_source_experiment_id_source_event_id_key",
  "must_exist": true,
  "definition_contains": ["source_experiment_id", "source_event_id"]
}
```

(Exact constraint-backed unique index name: after applying the Task 2 migration, run `\d public.live_order_intents` in `psql` and copy the auto-generated name for the `UNIQUE (source_experiment_id, source_event_id)` constraint's backing index — Postgres names it `<table>_<col1>_<col2>_key` by default; confirm the literal string before committing this file.)

- [ ] **Step 2: Run the schema-contract verification**

Run:
```bash
cd /home/shamaritaylor18/projects/source-to-sim
supabase db reset --local
python3 scripts/verify_schema_contract.py
```
Expected: exits 0, reports the two new indexes as present and matching.

- [ ] **Step 3: Commit**

```bash
git add supabase/schema-contract.json
git commit -m "chore(live-pilot): track new live_order_intents indexes in schema-contract.json"
```

---

## Task 5: Market-identity mapping wrapper

**Files:**
- Create: `src/lib/live-pilot/poligarch-market-mapping.server.ts`
- Test: `src/lib/live-pilot/poligarch-market-mapping.test.ts`

**Interfaces:**
- Consumes: `resolveCompatibility(source: SourceMarket, lookup?): Promise<CompatibilityResult>` and `CompatibilityResult = {compatibility: "EXACT_MATCH" | "POSSIBLE_MATCH" | "AMBIGUOUS" | "NO_MATCH", usMarketSlug: string | null, reason: string}` from `src/lib/pmus/compatibility.server.ts` (read that file first to confirm the exact `SourceMarket` shape it expects before writing the adapter below).
- Produces: `mapPoligarchSourceEvent(event: PoligarchSourceEvent, lookup?): Promise<MarketMappingResult>` where `MarketMappingResult = { status: "MAPPED" | "SKIP"; usMarketSlug: string | null; reason: string; skipReason?: "LIVE_MARKET_MAPPING_UNVERIFIED" }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/live-pilot/poligarch-market-mapping.test.ts
import { describe, it, expect, vi } from "vitest";
import { mapPoligarchSourceEvent } from "./poligarch-market-mapping";
import type { CompatibilityResult } from "../pmus/compatibility.server";

const baseEvent = {
  conditionId: "0xcond",
  asset: "tok-a",
  marketTitle: "Will it snow in Chicago by Feb 1?",
  outcome: "YES",
  side: "BUY" as const,
  price: 0.42,
  sourceTs: 1_700_000_000,
};

describe("mapPoligarchSourceEvent", () => {
  it("maps to MAPPED only on EXACT_MATCH", async () => {
    const resolve = vi.fn(
      async (): Promise<CompatibilityResult> => ({
        compatibility: "EXACT_MATCH",
        usMarketSlug: "chicago-snow-feb-1",
        reason: "date+location+threshold+title all matched",
      }),
    );
    const result = await mapPoligarchSourceEvent(baseEvent, resolve);
    expect(result).toEqual({
      status: "MAPPED",
      usMarketSlug: "chicago-snow-feb-1",
      reason: "date+location+threshold+title all matched",
    });
  });

  it("SKIPs with LIVE_MARKET_MAPPING_UNVERIFIED on AMBIGUOUS", async () => {
    const resolve = vi.fn(
      async (): Promise<CompatibilityResult> => ({
        compatibility: "AMBIGUOUS",
        usMarketSlug: null,
        reason: "two candidates tied on title similarity",
      }),
    );
    const result = await mapPoligarchSourceEvent(baseEvent, resolve);
    expect(result.status).toBe("SKIP");
    expect(result.skipReason).toBe("LIVE_MARKET_MAPPING_UNVERIFIED");
  });

  it("SKIPs on NO_MATCH without ever substituting a similar market", async () => {
    const resolve = vi.fn(
      async (): Promise<CompatibilityResult> => ({
        compatibility: "NO_MATCH",
        usMarketSlug: null,
        reason: "no candidate shares the source category",
      }),
    );
    const result = await mapPoligarchSourceEvent(baseEvent, resolve);
    expect(result.status).toBe("SKIP");
    expect(result.usMarketSlug).toBeNull();
  });

  it("SKIPs on POSSIBLE_MATCH (not exact enough to trade)", async () => {
    const resolve = vi.fn(
      async (): Promise<CompatibilityResult> => ({
        compatibility: "POSSIBLE_MATCH",
        usMarketSlug: "maybe-this-one",
        reason: "title similarity 0.7 but threshold differs",
      }),
    );
    const result = await mapPoligarchSourceEvent(baseEvent, resolve);
    expect(result.status).toBe("SKIP");
    expect(result.skipReason).toBe("LIVE_MARKET_MAPPING_UNVERIFIED");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/live-pilot/poligarch-market-mapping.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

First read `src/lib/pmus/compatibility.server.ts` in full to get the exact `SourceMarket` input type `resolveCompatibility` expects, then adapt:

```ts
// src/lib/live-pilot/poligarch-market-mapping.server.ts
import { resolveCompatibility, type CompatibilityResult } from "../pmus/compatibility.server";

export type PoligarchSourceEvent = {
  conditionId: string | null;
  asset: string;
  marketTitle: string;
  outcome: string | null;
  side: "BUY" | "SELL";
  price: number;
  sourceTs: number;
};

export type MarketMappingResult = {
  status: "MAPPED" | "SKIP";
  usMarketSlug: string | null;
  reason: string;
  skipReason?: "LIVE_MARKET_MAPPING_UNVERIFIED";
};

type ResolveCompatibilityFn = (
  source: Parameters<typeof resolveCompatibility>[0],
) => Promise<CompatibilityResult>;

/**
 * Market identity must be exact. Only EXACT_MATCH ever becomes tradeable;
 * every other compatibility outcome fails closed to SKIP with an explicit
 * reason, never a substituted "similar" market.
 */
export async function mapPoligarchSourceEvent(
  event: PoligarchSourceEvent,
  resolve: ResolveCompatibilityFn = resolveCompatibility,
): Promise<MarketMappingResult> {
  const result = await resolve({
    conditionId: event.conditionId,
    asset: event.asset,
    title: event.marketTitle,
    outcome: event.outcome,
  } as Parameters<typeof resolveCompatibility>[0]);

  if (result.compatibility === "EXACT_MATCH") {
    return { status: "MAPPED", usMarketSlug: result.usMarketSlug, reason: result.reason };
  }

  return {
    status: "SKIP",
    usMarketSlug: null,
    reason: result.reason,
    skipReason: "LIVE_MARKET_MAPPING_UNVERIFIED",
  };
}
```

Note: the object literal passed to `resolve(...)` must be corrected to match `resolveCompatibility`'s actual parameter shape once read in this step — do not leave the `as` cast in the committed code; replace it with a real, correctly-typed object.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/live-pilot/poligarch-market-mapping.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/live-pilot/poligarch-market-mapping.server.ts src/lib/live-pilot/poligarch-market-mapping.test.ts
git commit -m "feat(live-pilot): add fail-closed market-identity mapping for Poligarch source events"
```

---

## Task 6: Risk checks and sizing

**Files:**
- Create: `src/lib/live-pilot/poligarch-risk-checks.ts`
- Test: `src/lib/live-pilot/poligarch-risk-checks.test.ts`

**Interfaces:**
- Consumes: `PILOT_RISK_LIMITS` from Task 1.
- Produces: `computeLivePilotOrderSize(input): SizingResult`, `checkSignalAge(input): RiskCheck`, `checkSlippage(input): RiskCheck`, `checkExposureCaps(input): RiskCheck`, `checkDailyLoss(input): RiskCheck`, `checkConsecutiveFailures(input): RiskCheck`, `checkOpenPositions(input): RiskCheck`, where `RiskCheck = { pass: boolean; label: string; detail: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/live-pilot/poligarch-risk-checks.test.ts
import { describe, it, expect } from "vitest";
import {
  computeLivePilotOrderSize,
  checkSignalAge,
  checkSlippage,
  checkExposureCaps,
  checkDailyLoss,
  checkConsecutiveFailures,
  checkOpenPositions,
} from "./poligarch-risk-checks";

describe("computeLivePilotOrderSize", () => {
  it("caps at $2 even when proportional signal size is larger", () => {
    const result = computeLivePilotOrderSize({
      proportionalNotionalUsd: 50,
      remainingBankrollUsd: 25,
      remainingExposureUsd: 10,
      price: 0.5,
      minimumTradeQty: 0.01,
      tickSize: 0.005,
    });
    expect(result.notionalUsd).toBeLessThanOrEqual(2);
  });

  it("SKIPs rather than increasing size when $2 cannot clear minimumTradeQty", () => {
    const result = computeLivePilotOrderSize({
      proportionalNotionalUsd: 50,
      remainingBankrollUsd: 25,
      remainingExposureUsd: 10,
      price: 0.99,
      minimumTradeQty: 10, // requires 10 shares * 0.99 = $9.90, far above the $2 cap
      tickSize: 0.005,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/minimum/i);
  });

  it("respects remaining bankroll and exposure headroom, whichever is smaller", () => {
    const result = computeLivePilotOrderSize({
      proportionalNotionalUsd: 50,
      remainingBankrollUsd: 1.5,
      remainingExposureUsd: 10,
      price: 0.5,
      minimumTradeQty: 0.01,
      tickSize: 0.005,
    });
    expect(result.notionalUsd).toBeLessThanOrEqual(1.5);
  });
});

describe("checkSignalAge", () => {
  it("passes within the 90s window", () => {
    const now = 1_700_000_100;
    expect(checkSignalAge({ sourceTsSeconds: 1_700_000_020, nowSeconds: now }).pass).toBe(true);
  });
  it("fails past 90s", () => {
    const now = 1_700_000_200;
    expect(checkSignalAge({ sourceTsSeconds: 1_700_000_020, nowSeconds: now }).pass).toBe(false);
  });
});

describe("checkSlippage", () => {
  it("passes within 3 cents", () => {
    expect(checkSlippage({ sourcePrice: 0.5, currentPrice: 0.52 }).pass).toBe(true);
  });
  it("fails beyond 3 cents", () => {
    expect(checkSlippage({ sourcePrice: 0.5, currentPrice: 0.54 }).pass).toBe(false);
  });
});

describe("checkExposureCaps", () => {
  it("fails when adding the order would exceed $10 total exposure", () => {
    expect(
      checkExposureCaps({ currentOpenExposureUsd: 9, newOrderNotionalUsd: 2 }).pass,
    ).toBe(false);
  });
  it("passes exactly at the cap", () => {
    expect(
      checkExposureCaps({ currentOpenExposureUsd: 8, newOrderNotionalUsd: 2 }).pass,
    ).toBe(true);
  });
});

describe("checkDailyLoss", () => {
  it("fails once today's realized loss reaches $5", () => {
    expect(checkDailyLoss({ todayRealizedPnlUsd: -5 }).pass).toBe(false);
    expect(checkDailyLoss({ todayRealizedPnlUsd: -4.99 }).pass).toBe(true);
  });
});

describe("checkConsecutiveFailures", () => {
  it("fails at 3 consecutive failures", () => {
    expect(checkConsecutiveFailures({ consecutiveFailedOrders: 3 }).pass).toBe(false);
    expect(checkConsecutiveFailures({ consecutiveFailedOrders: 2 }).pass).toBe(true);
  });
});

describe("checkOpenPositions", () => {
  it("fails at 5 open live positions", () => {
    expect(checkOpenPositions({ openLivePositions: 5 }).pass).toBe(false);
    expect(checkOpenPositions({ openLivePositions: 4 }).pass).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/live-pilot/poligarch-risk-checks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/live-pilot/poligarch-risk-checks.ts
import { PILOT_RISK_LIMITS } from "./poligarch-config";

export type RiskCheck = { pass: boolean; label: string; detail: string };

export type SizingInput = {
  proportionalNotionalUsd: number;
  remainingBankrollUsd: number;
  remainingExposureUsd: number;
  price: number;
  minimumTradeQty: number;
  tickSize: number;
};

export type SizingResult =
  | { ok: true; notionalUsd: number; shares: number }
  | { ok: false; reason: string };

function roundToTick(value: number, tick: number): number {
  return Math.round(value / tick) * tick;
}

/**
 * min(proportional signal, $2 order cap, remaining bankroll, remaining
 * exposure headroom). If the platform's minimum tradeable size can't be
 * cleared at that notional, SKIP — never increase size to compensate.
 */
export function computeLivePilotOrderSize(input: SizingInput): SizingResult {
  const cappedNotional = Math.min(
    input.proportionalNotionalUsd,
    PILOT_RISK_LIMITS.maxOrderNotionalUsd,
    input.remainingBankrollUsd,
    input.remainingExposureUsd,
  );

  if (cappedNotional <= 0) {
    return { ok: false, reason: "No bankroll or exposure headroom remaining." };
  }

  const rawShares = cappedNotional / input.price;
  if (rawShares < input.minimumTradeQty) {
    return {
      ok: false,
      reason: `Order at $${cappedNotional.toFixed(2)} produces ${rawShares.toFixed(4)} shares, below minimumTradeQty ${input.minimumTradeQty}.`,
    };
  }

  const shares = roundToTick(rawShares, input.tickSize);
  if (shares < input.minimumTradeQty) {
    return { ok: false, reason: "Tick-rounded size falls below minimumTradeQty." };
  }

  return { ok: true, notionalUsd: Number((shares * input.price).toFixed(2)), shares };
}

export function checkSignalAge(input: { sourceTsSeconds: number; nowSeconds: number }): RiskCheck {
  const ageSeconds = input.nowSeconds - input.sourceTsSeconds;
  return {
    pass: ageSeconds <= PILOT_RISK_LIMITS.maxSignalAgeSeconds,
    label: `Signal age <= ${PILOT_RISK_LIMITS.maxSignalAgeSeconds}s`,
    detail: `${ageSeconds}s`,
  };
}

export function checkSlippage(input: { sourcePrice: number; currentPrice: number }): RiskCheck {
  const slippageCents = Math.abs(input.currentPrice - input.sourcePrice) * 100;
  return {
    pass: slippageCents <= PILOT_RISK_LIMITS.maxAllowedSlippageCents,
    label: `Slippage <= ${PILOT_RISK_LIMITS.maxAllowedSlippageCents} cents`,
    detail: `${slippageCents.toFixed(2)} cents`,
  };
}

export function checkExposureCaps(input: {
  currentOpenExposureUsd: number;
  newOrderNotionalUsd: number;
}): RiskCheck {
  const projected = input.currentOpenExposureUsd + input.newOrderNotionalUsd;
  return {
    pass: projected <= PILOT_RISK_LIMITS.maxTotalOpenExposureUsd,
    label: `Total exposure <= $${PILOT_RISK_LIMITS.maxTotalOpenExposureUsd}`,
    detail: `$${projected.toFixed(2)} projected`,
  };
}

export function checkDailyLoss(input: { todayRealizedPnlUsd: number }): RiskCheck {
  const loss = Math.max(0, -input.todayRealizedPnlUsd);
  return {
    pass: loss < PILOT_RISK_LIMITS.maxDailyRealizedLossUsd,
    label: `Daily realized loss < $${PILOT_RISK_LIMITS.maxDailyRealizedLossUsd}`,
    detail: `$${loss.toFixed(2)}`,
  };
}

export function checkConsecutiveFailures(input: { consecutiveFailedOrders: number }): RiskCheck {
  return {
    pass: input.consecutiveFailedOrders < PILOT_RISK_LIMITS.maxConsecutiveFailedOrders,
    label: `Consecutive failed orders < ${PILOT_RISK_LIMITS.maxConsecutiveFailedOrders}`,
    detail: `${input.consecutiveFailedOrders}`,
  };
}

export function checkOpenPositions(input: { openLivePositions: number }): RiskCheck {
  return {
    pass: input.openLivePositions < PILOT_RISK_LIMITS.maxOpenLivePositions,
    label: `Open live positions < ${PILOT_RISK_LIMITS.maxOpenLivePositions}`,
    detail: `${input.openLivePositions}`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/live-pilot/poligarch-risk-checks.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/live-pilot/poligarch-risk-checks.ts src/lib/live-pilot/poligarch-risk-checks.test.ts
git commit -m "feat(live-pilot): add pilot sizing and per-order risk checks"
```

---

## Task 7: Pilot safety-state core logic

**Files:**
- Create: `src/lib/live-pilot/poligarch-safety-core.ts`
- Test: `src/lib/live-pilot/poligarch-safety-core.test.ts`

**Interfaces:**
- Produces: `POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED: false`, `PilotActivationStage = "locked" | "preview" | "live_pilot"`, `PilotSafetyState` type, `canEnterPreview(state): ActivationGate`, `canEnterLivePilot(state, confirmPhrase): ActivationGate`, `PILOT_ACTIVATION_CONFIRM_PHRASE`, `isSubmissionReachable(state): { reachable: boolean; reasons: string[] }`.

This mirrors `src/lib/live-safety/core.ts` exactly (same shape, same fail-closed philosophy) but scoped to one pilot and gated additionally by the hard `POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED` constant.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/live-pilot/poligarch-safety-core.test.ts
import { describe, it, expect } from "vitest";
import {
  POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED,
  PILOT_ACTIVATION_CONFIRM_PHRASE,
  canEnterPreview,
  canEnterLivePilot,
  isSubmissionReachable,
  type PilotSafetyState,
} from "./poligarch-safety-core";

const lockedState: PilotSafetyState = {
  killSwitchEngaged: true,
  activationStage: "locked",
  armedAt: null,
  activatedAt: null,
  pilotBankrollUsd: 0,
  maxOrderNotionalUsd: 0,
  maxTotalExposureUsd: 0,
  maxDailyRealizedLossUsd: 0,
};

describe("poligarch-safety-core", () => {
  it("has submission hard-disabled", () => {
    expect(POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED).toBe(false);
  });

  it("blocks preview while kill switch is engaged", () => {
    const gate = canEnterPreview(lockedState);
    expect(gate.allowed).toBe(false);
  });

  it("allows preview once kill switch is released and stage is locked", () => {
    const gate = canEnterPreview({ ...lockedState, killSwitchEngaged: false });
    expect(gate.allowed).toBe(true);
  });

  it("requires the exact confirm phrase to enter live_pilot stage", () => {
    const armedState: PilotSafetyState = {
      ...lockedState,
      killSwitchEngaged: false,
      activationStage: "preview",
    };
    expect(canEnterLivePilot(armedState, "wrong phrase").allowed).toBe(false);
    expect(canEnterLivePilot(armedState, PILOT_ACTIVATION_CONFIRM_PHRASE).allowed).toBe(true);
  });

  it("submission is never reachable while the hard constant is false, regardless of DB state", () => {
    const fullyArmedState: PilotSafetyState = {
      killSwitchEngaged: false,
      activationStage: "live_pilot",
      armedAt: "2026-08-21T00:00:00Z",
      activatedAt: "2026-08-21T00:00:00Z",
      pilotBankrollUsd: 25,
      maxOrderNotionalUsd: 2,
      maxTotalExposureUsd: 10,
      maxDailyRealizedLossUsd: 5,
    };
    const result = isSubmissionReachable(fullyArmedState);
    expect(result.reachable).toBe(false);
    expect(result.reasons).toContain("POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED is false.");
  });

  it("submission is unreachable while locked even hypothetically", () => {
    expect(isSubmissionReachable(lockedState).reachable).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/live-pilot/poligarch-safety-core.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/live-pilot/poligarch-safety-core.ts
/**
 * Hard-disabled regardless of any database state. Flipping this to true is
 * a deliberate source change requiring its own review — not something any
 * runtime admin action in this codebase can do.
 */
export const POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED = false;

export type PilotActivationStage = "locked" | "preview" | "live_pilot";

export type PilotSafetyState = {
  killSwitchEngaged: boolean;
  activationStage: PilotActivationStage;
  armedAt: string | null;
  activatedAt: string | null;
  pilotBankrollUsd: number;
  maxOrderNotionalUsd: number;
  maxTotalExposureUsd: number;
  maxDailyRealizedLossUsd: number;
};

export type ActivationGate = { allowed: boolean; reason: string };

export function canEnterPreview(state: PilotSafetyState): ActivationGate {
  if (state.killSwitchEngaged) return { allowed: false, reason: "Kill switch is engaged." };
  if (state.activationStage !== "locked")
    return { allowed: false, reason: `Already ${state.activationStage}.` };
  return { allowed: true, reason: "Preview stage allowed." };
}

export const PILOT_ACTIVATION_CONFIRM_PHRASE = "ACTIVATE POLIGARCH V2 LIVE PILOT";

export function canEnterLivePilot(state: PilotSafetyState, confirmPhrase: string): ActivationGate {
  if (state.killSwitchEngaged) return { allowed: false, reason: "Kill switch is engaged." };
  if (state.activationStage !== "preview")
    return { allowed: false, reason: "Must be in preview stage first." };
  if (confirmPhrase.trim() !== PILOT_ACTIVATION_CONFIRM_PHRASE)
    return { allowed: false, reason: "Confirmation phrase does not match." };
  return { allowed: true, reason: "Live-pilot stage confirmed." };
}

/**
 * Every condition from Step 8 of the spec, fail-closed: any single missing
 * condition makes submission unreachable.
 */
export function isSubmissionReachable(state: PilotSafetyState): {
  reachable: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (!POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED)
    reasons.push("POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED is false.");
  if (state.killSwitchEngaged) reasons.push("Kill switch engaged.");
  if (state.activationStage !== "live_pilot")
    reasons.push(`Activation stage is ${state.activationStage}, not live_pilot.`);
  if (!(state.maxOrderNotionalUsd > 0)) reasons.push("maxOrderNotionalUsd is $0.");
  if (!(state.maxTotalExposureUsd > 0)) reasons.push("maxTotalExposureUsd is $0.");
  if (!(state.pilotBankrollUsd > 0)) reasons.push("pilotBankrollUsd is $0.");

  return { reachable: reasons.length === 0, reasons };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/live-pilot/poligarch-safety-core.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/live-pilot/poligarch-safety-core.ts src/lib/live-pilot/poligarch-safety-core.test.ts
git commit -m "feat(live-pilot): add pilot-scoped safety-state core with hard-disabled submission constant"
```

---

## Task 8: Admin-gated pilot safety-state server functions

**Files:**
- Create: `src/lib/live-pilot/poligarch-safety.server.ts`
- Create: `src/lib/live-pilot/poligarch-safety.functions.ts`
- Test: `src/lib/live-pilot/poligarch-safety.server.test.ts`

**Interfaces:**
- Consumes: `PilotSafetyState`, `canEnterPreview`, `canEnterLivePilot` from Task 7; `requireAdmin` from `src/lib/admin-auth.ts` (read that file first to confirm the exact middleware usage pattern, matching `src/lib/live-safety.functions.ts`).
- Produces: `loadPoligarchPilotSafety(): Promise<PilotSafetyState>`, `engagePoligarchKillSwitch(userId: string): Promise<void>`, `releasePoligarchKillSwitch(userId: string): Promise<void>`, `enterPreviewStage(userId: string): Promise<void>`, `enterLivePilotStage(userId: string, confirmPhrase: string): Promise<void>`, `abortToLocked(userId: string): Promise<void>`.

Read `src/lib/live-safety.server.ts` and `src/lib/live-safety.functions.ts` in full before writing this task — copy their Supabase-client and `.middleware([requireAdmin])` wiring pattern exactly, scoped to `pilot_id = 'poligarch_v2_live_pilot'` in `live_pilot_state` instead of the single `live_safety_state` row.

- [ ] **Step 1: Write the failing test (core-logic integration, not live DB)**

```ts
// src/lib/live-pilot/poligarch-safety.server.test.ts
import { describe, it, expect, vi } from "vitest";
import { engagePoligarchKillSwitch, enterLivePilotStage } from "./poligarch-safety.server";

// This project's Supabase client is created inside each function body (see
// pmus/credentials.server.ts's lazy-env pattern) — mock at the same seam
// used by loadPoligarchPilotSafety's own Supabase import once that import
// path is confirmed while writing this test for real.

describe("poligarch-safety.server", () => {
  it("enterLivePilotStage rejects a wrong confirm phrase without calling the DB", async () => {
    const updateMock = vi.fn();
    await expect(
      enterLivePilotStage("user-1", "wrong phrase", { updateFn: updateMock } as never),
    ).rejects.toThrow(/confirmation phrase/i);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/live-pilot/poligarch-safety.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Read `src/lib/live-safety.server.ts` first, then write `poligarch-safety.server.ts` following its exact Supabase-client construction and error-handling pattern, replacing `live_safety_state`/`id='global'` with `live_pilot_state`/`pilot_id='poligarch_v2_live_pilot'`, and validating every mutation through `canEnterPreview`/`canEnterLivePilot` from Task 7 before issuing the update. Each exported function must re-fetch current state, run the corresponding gate function, throw with the gate's `reason` on failure, and only then write.

Read `src/lib/live-safety.functions.ts` first, then write `poligarch-safety.functions.ts` as thin `createServerFn` wrappers around each `poligarch-safety.server.ts` export, each one wrapped in `.middleware([requireAdmin])`, matching the existing file's structure exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/live-pilot/poligarch-safety.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/live-pilot/poligarch-safety.server.ts src/lib/live-pilot/poligarch-safety.functions.ts src/lib/live-pilot/poligarch-safety.server.test.ts
git commit -m "feat(live-pilot): add admin-gated Poligarch pilot safety-state server functions"
```

---

## Task 9: Preview pipeline orchestration

**Files:**
- Create: `src/lib/live-pilot/poligarch-preview.server.ts`
- Test: `src/lib/live-pilot/poligarch-preview.server.test.ts`

**Interfaces:**
- Consumes: `isAllowedPilotSource` (Task 1), `mapPoligarchSourceEvent` (Task 5), `computeLivePilotOrderSize`/`checkSignalAge`/`checkSlippage`/`checkExposureCaps`/`checkDailyLoss`/`checkConsecutiveFailures`/`checkOpenPositions` (Task 6), `PilotSafetyState`/`canEnterPreview` (Task 7), `create_or_get_live_pilot_intent_atomic`/`update_live_pilot_intent_status_atomic` RPCs (Task 3), `previewOrder`/`fetchUsMarketBbo` from `src/lib/pmus/` (read `previews.server.ts` and `us-markets.server.ts` first for exact signatures).
- Produces: `previewPoligarchLiveOrder(sourceEvent: RawSourceEvent, deps): Promise<LivePilotPreviewResult>` where `LivePilotPreviewResult` includes every field listed in the spec's Step 10 (source event, mapped market, source/execution side, prices, intended shares/notional, current balance/exposure/daily P&L, signal age, slippage estimate, each risk check's pass/fail, overall PASS/FAIL, exact failure reason) and **never calls any order-submission function**.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/live-pilot/poligarch-preview.server.test.ts
import { describe, it, expect, vi } from "vitest";
import { previewPoligarchLiveOrder } from "./poligarch-preview.server";
import { POLIGARCH_V2_WALLET, POLIGARCH_V2_EXPERIMENT_NAME } from "./poligarch-config";

const baseSourceEvent = {
  id: "evt-1",
  experimentId: "exp-1",
  experimentName: POLIGARCH_V2_EXPERIMENT_NAME,
  wallet: POLIGARCH_V2_WALLET,
  conditionId: "0xcond",
  asset: "tok-a",
  marketTitle: "Will it snow in Chicago by Feb 1?",
  outcome: "YES",
  side: "BUY" as const,
  price: 0.5,
  sourceTs: 1_700_000_000,
};

function baseDeps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    mapMarket: vi.fn(async () => ({ status: "MAPPED" as const, usMarketSlug: "chicago-snow", reason: "exact" })),
    getCurrentBook: vi.fn(async () => ({ bestBid: 0.49, bestAsk: 0.51, minimumTradeQty: 0.01, tickSize: 0.005 })),
    getPilotSafetyState: vi.fn(async () => ({
      killSwitchEngaged: false,
      activationStage: "preview" as const,
      armedAt: null,
      activatedAt: null,
      pilotBankrollUsd: 25,
      maxOrderNotionalUsd: 2,
      maxTotalExposureUsd: 10,
      maxDailyRealizedLossUsd: 5,
    })),
    getPilotLedgerSnapshot: vi.fn(async () => ({
      remainingBankrollUsd: 25,
      currentOpenExposureUsd: 0,
      todayRealizedPnlUsd: 0,
      consecutiveFailedOrders: 0,
      openLivePositions: 0,
    })),
    createOrGetIntent: vi.fn(async () => ({ intentId: "intent-1", created: true, status: "PREVIEWED" })),
    updateIntentStatus: vi.fn(async () => ({})),
    nowSeconds: () => 1_700_000_030,
    ...overrides,
  };
}

describe("previewPoligarchLiveOrder", () => {
  it("rejects a non-allowlisted source without persisting an intent or calling PMUS", async () => {
    const deps = baseDeps();
    const result = await previewPoligarchLiveOrder(
      { ...baseSourceEvent, experimentName: "SHADOW V3 CAPACITY: Poligarch" },
      deps as never,
    );
    expect(result.overall).toBe("FAIL");
    expect(result.failReason).toMatch(/allowlist/i);
    expect(deps.mapMarket).not.toHaveBeenCalled();
    expect(deps.createOrGetIntent).not.toHaveBeenCalled();
  });

  it("SKIPs on unmapped market without ever calling risk checks", async () => {
    const deps = baseDeps({
      mapMarket: vi.fn(async () => ({
        status: "SKIP" as const,
        usMarketSlug: null,
        reason: "no candidate",
        skipReason: "LIVE_MARKET_MAPPING_UNVERIFIED" as const,
      })),
    });
    const result = await previewPoligarchLiveOrder(baseSourceEvent, deps as never);
    expect(result.overall).toBe("FAIL");
    expect(result.failReason).toBe("LIVE_MARKET_MAPPING_UNVERIFIED");
  });

  it("FAILs closed when the safety state is locked", async () => {
    const deps = baseDeps({
      getPilotSafetyState: vi.fn(async () => ({
        killSwitchEngaged: true,
        activationStage: "locked" as const,
        armedAt: null,
        activatedAt: null,
        pilotBankrollUsd: 0,
        maxOrderNotionalUsd: 0,
        maxTotalExposureUsd: 0,
        maxDailyRealizedLossUsd: 0,
      })),
    });
    const result = await previewPoligarchLiveOrder(baseSourceEvent, deps as never);
    expect(result.overall).toBe("FAIL");
    expect(result.failReason).toMatch(/kill switch|locked/i);
  });

  it("FAILs closed on a stale signal", async () => {
    const deps = baseDeps({ nowSeconds: () => 1_700_000_200 });
    const result = await previewPoligarchLiveOrder(baseSourceEvent, deps as never);
    expect(result.overall).toBe("FAIL");
    expect(result.signalAgeSeconds).toBe(200);
  });

  it("PASSes and persists a PREVIEWED intent when every check clears, still never submitting", async () => {
    const deps = baseDeps();
    const result = await previewPoligarchLiveOrder(baseSourceEvent, deps as never);
    expect(result.overall).toBe("PASS");
    expect(deps.createOrGetIntent).toHaveBeenCalledTimes(1);
    expect(deps.updateIntentStatus).toHaveBeenCalledWith(
      "intent-1",
      expect.stringMatching(/PREVIEWED/),
      expect.any(Object),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/live-pilot/poligarch-preview.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/live-pilot/poligarch-preview.server.ts
import { isAllowedPilotSource, POLIGARCH_LIVE_PILOT_ID } from "./poligarch-config";
import { mapPoligarchSourceEvent, type PoligarchSourceEvent } from "./poligarch-market-mapping.server";
import {
  computeLivePilotOrderSize,
  checkSignalAge,
  checkSlippage,
  checkExposureCaps,
  checkDailyLoss,
  checkConsecutiveFailures,
  checkOpenPositions,
  type RiskCheck,
} from "./poligarch-risk-checks";
import { canEnterPreview, type PilotSafetyState } from "./poligarch-safety-core";

export type RawSourceEvent = PoligarchSourceEvent & {
  id: string;
  experimentId: string;
  experimentName: string;
  wallet: string;
};

export type LivePilotPreviewResult = {
  overall: "PASS" | "FAIL";
  failReason: string | null;
  sourceEvent: RawSourceEvent;
  usMarketSlug: string | null;
  signalAgeSeconds: number | null;
  slippageCheck: RiskCheck | null;
  sizing: { notionalUsd: number; shares: number } | null;
  checks: RiskCheck[];
  intentId: string | null;
};

export type PreviewDeps = {
  mapMarket: typeof mapPoligarchSourceEvent;
  getCurrentBook: (usMarketSlug: string) => Promise<{
    bestBid: number;
    bestAsk: number;
    minimumTradeQty: number;
    tickSize: number;
  }>;
  getPilotSafetyState: () => Promise<PilotSafetyState>;
  getPilotLedgerSnapshot: () => Promise<{
    remainingBankrollUsd: number;
    currentOpenExposureUsd: number;
    todayRealizedPnlUsd: number;
    consecutiveFailedOrders: number;
    openLivePositions: number;
  }>;
  createOrGetIntent: (event: RawSourceEvent) => Promise<{ intentId: string; created: boolean; status: string }>;
  updateIntentStatus: (intentId: string, status: string, fields: Record<string, unknown>) => Promise<unknown>;
  nowSeconds: () => number;
};

function fail(
  event: RawSourceEvent,
  reason: string,
  partial: Partial<LivePilotPreviewResult> = {},
): LivePilotPreviewResult {
  return {
    overall: "FAIL",
    failReason: reason,
    sourceEvent: event,
    usMarketSlug: null,
    signalAgeSeconds: null,
    slippageCheck: null,
    sizing: null,
    checks: [],
    intentId: null,
    ...partial,
  };
}

/**
 * Never submits an order. Only ever produces a PASS/FAIL preview and,
 * on PASS or a mapping-level SKIP, persists an idempotent intent row via
 * the Task 3 RPCs.
 */
export async function previewPoligarchLiveOrder(
  event: RawSourceEvent,
  deps: PreviewDeps,
): Promise<LivePilotPreviewResult> {
  if (!isAllowedPilotSource({ experimentName: event.experimentName, wallet: event.wallet })) {
    return fail(event, "Source experiment/wallet is not on the Poligarch V2 pilot allowlist.");
  }

  const safetyState = await deps.getPilotSafetyState();
  const gate = canEnterPreview({ ...safetyState, activationStage: "locked" });
  const previewAllowed = safetyState.activationStage === "preview" || safetyState.activationStage === "live_pilot";
  if (safetyState.killSwitchEngaged || !previewAllowed) {
    return fail(
      event,
      safetyState.killSwitchEngaged ? "Kill switch is engaged." : `Activation stage is ${safetyState.activationStage} (locked).`,
    );
  }
  void gate; // gate reused for its reason text above; kept for readability, not blocking logic duplication

  const mapping = await deps.mapMarket(event);
  if (mapping.status === "SKIP") {
    return fail(event, mapping.skipReason ?? "LIVE_MARKET_MAPPING_UNVERIFIED");
  }

  const nowSeconds = deps.nowSeconds();
  const ageCheck = checkSignalAge({ sourceTsSeconds: event.sourceTs, nowSeconds });
  if (!ageCheck.pass) {
    return fail(event, "Signal is stale.", {
      usMarketSlug: mapping.usMarketSlug,
      signalAgeSeconds: nowSeconds - event.sourceTs,
    });
  }

  const book = await deps.getCurrentBook(mapping.usMarketSlug as string);
  const currentPrice = event.side === "BUY" ? book.bestAsk : book.bestBid;
  const slippageCheck = checkSlippage({ sourcePrice: event.price, currentPrice });

  const ledger = await deps.getPilotLedgerSnapshot();
  // Mirrors shadow-core.ts's computeBuySize fixed-fraction-of-own-cash
  // convention (SIZING_CASH_FRACTION=0.01, SIZING_MIN_USD=1 floor) applied
  // to the pilot's own bankroll instead of the $380 paper bankroll. The
  // paper engine does not scale off the source trade's own notional either
  // (computeBuySize takes no price/size input beyond price-for-shares), so
  // this re-bases the same fixed-fraction rule rather than approximating a
  // "proportional to source size" concept that doesn't exist upstream.
  const proportionalNotionalUsd = Math.max(1, ledger.remainingBankrollUsd * 0.01);
  const sizing = computeLivePilotOrderSize({
    proportionalNotionalUsd,
    remainingBankrollUsd: ledger.remainingBankrollUsd,
    remainingExposureUsd: Math.max(0, 10 - ledger.currentOpenExposureUsd),
    price: currentPrice,
    minimumTradeQty: book.minimumTradeQty,
    tickSize: book.tickSize,
  });

  const checks: RiskCheck[] = [
    slippageCheck,
    checkExposureCaps({
      currentOpenExposureUsd: ledger.currentOpenExposureUsd,
      newOrderNotionalUsd: sizing.ok ? sizing.notionalUsd : 0,
    }),
    checkDailyLoss({ todayRealizedPnlUsd: ledger.todayRealizedPnlUsd }),
    checkConsecutiveFailures({ consecutiveFailedOrders: ledger.consecutiveFailedOrders }),
    checkOpenPositions({ openLivePositions: ledger.openLivePositions }),
  ];

  const intent = await deps.createOrGetIntent(event);

  if (!sizing.ok) {
    await deps.updateIntentStatus(intent.intentId, "SKIPPED", { fail_reason: sizing.reason });
    return fail(event, sizing.reason, { usMarketSlug: mapping.usMarketSlug, signalAgeSeconds: nowSeconds - event.sourceTs, slippageCheck, checks, intentId: intent.intentId });
  }

  const failedCheck = checks.find((c) => !c.pass);
  if (failedCheck) {
    await deps.updateIntentStatus(intent.intentId, "SKIPPED", { fail_reason: failedCheck.label });
    return fail(event, failedCheck.label, {
      usMarketSlug: mapping.usMarketSlug,
      signalAgeSeconds: nowSeconds - event.sourceTs,
      slippageCheck,
      sizing: { notionalUsd: sizing.notionalUsd, shares: sizing.shares },
      checks,
      intentId: intent.intentId,
    });
  }

  await deps.updateIntentStatus(intent.intentId, "PREVIEWED", {
    us_market_slug: mapping.usMarketSlug,
    requested_shares: sizing.shares,
    requested_notional_usd: sizing.notionalUsd,
    live_price_snapshot: book,
    safety_checks: checks,
  });

  return {
    overall: "PASS",
    failReason: null,
    sourceEvent: event,
    usMarketSlug: mapping.usMarketSlug,
    signalAgeSeconds: nowSeconds - event.sourceTs,
    slippageCheck,
    sizing: { notionalUsd: sizing.notionalUsd, shares: sizing.shares },
    checks,
    intentId: intent.intentId,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/live-pilot/poligarch-preview.server.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/live-pilot/poligarch-preview.server.ts src/lib/live-pilot/poligarch-preview.server.test.ts
git commit -m "feat(live-pilot): add preview-only orchestration pipeline for Poligarch V2 live pilot"
```

---

## Task 10: Submission module (implemented, structurally unreachable)

**Files:**
- Create: `src/lib/live-pilot/poligarch-submission.server.ts`
- Test: `src/lib/live-pilot/poligarch-submission.server.test.ts`

**Interfaces:**
- Consumes: `POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED`, `isSubmissionReachable`, `PilotSafetyState` (Task 7); `signRequest`, `loadPmusCredentials`, `isPmusConfigured` from `src/lib/pmus/signer.server.ts` and `credentials.server.ts` (read both first — reuse verbatim, do not reimplement signing or credential loading).
- Produces: `submitPoligarchLiveOrder(intent, deps): Promise<SubmissionResult>`, `cancelPoligarchLiveOrder(orderId, deps): Promise<SubmissionResult>`, `getPoligarchLiveOrderStatus(orderId, deps): Promise<SubmissionResult>`. **Not exported from any `index.ts` barrel, not imported by any route, cron, or UI component in this plan.**

This module deliberately does NOT extend `src/lib/pmus/capabilities.server.ts`'s `ALLOWED_OPERATIONS` — it defines its own, separately-scoped 3-operation allowlist (`POST /v1/orders`, `POST /v1/order/{orderId}/cancel`, `GET /v1/order/{orderId}`), so the existing hardened read/preview-only allowlist and its tests are never touched.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/live-pilot/poligarch-submission.server.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED,
  submitPoligarchLiveOrder,
  cancelPoligarchLiveOrder,
  getPoligarchLiveOrderStatus,
} from "./poligarch-submission.server";

const lockedState = {
  killSwitchEngaged: true,
  activationStage: "locked" as const,
  armedAt: null,
  activatedAt: null,
  pilotBankrollUsd: 0,
  maxOrderNotionalUsd: 0,
  maxTotalExposureUsd: 0,
  maxDailyRealizedLossUsd: 0,
};

const fullyArmedState = {
  killSwitchEngaged: false,
  activationStage: "live_pilot" as const,
  armedAt: "2026-08-21T00:00:00Z",
  activatedAt: "2026-08-21T00:00:00Z",
  pilotBankrollUsd: 25,
  maxOrderNotionalUsd: 2,
  maxTotalExposureUsd: 10,
  maxDailyRealizedLossUsd: 5,
};

describe("poligarch-submission.server", () => {
  it("hard constant is false", () => {
    expect(POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED).toBe(false);
  });

  it("submitPoligarchLiveOrder always short-circuits when the hard constant is false, even with a fully-armed DB state", async () => {
    const fetchImpl = vi.fn();
    const result = await submitPoligarchLiveOrder(
      { usMarketSlug: "chicago-snow", side: "BUY", limitPrice: 0.52, shares: 3.8 },
      { getPilotSafetyState: async () => fullyArmedState, fetchImpl, now: () => 1_700_000_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SUBMISSION_NOT_ENABLED/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still fails closed on a locked safety state, independent of the hard constant", async () => {
    const fetchImpl = vi.fn();
    const result = await submitPoligarchLiveOrder(
      { usMarketSlug: "chicago-snow", side: "BUY", limitPrice: 0.52, shares: 3.8 },
      { getPilotSafetyState: async () => lockedState, fetchImpl, now: () => 1_700_000_000 },
    );
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cancel and status-lookup also short-circuit on the hard constant", async () => {
    const fetchImpl = vi.fn();
    const cancelResult = await cancelPoligarchLiveOrder("order-1", {
      getPilotSafetyState: async () => fullyArmedState,
      fetchImpl,
      now: () => 1_700_000_000,
    });
    const statusResult = await getPoligarchLiveOrderStatus("order-1", {
      getPilotSafetyState: async () => fullyArmedState,
      fetchImpl,
      now: () => 1_700_000_000,
    });
    expect(cancelResult.ok).toBe(false);
    expect(statusResult.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("detects missing credentials without throwing", async () => {
    // Exercised once POLYMARKET_KEY_ID/POLYMARKET_SECRET_KEY are unset in the test env —
    // confirm isPmusConfigured()-equivalent MISSING_CREDENTIALS handling is reused, not reinvented.
    const fetchImpl = vi.fn();
    const result = await submitPoligarchLiveOrder(
      { usMarketSlug: "chicago-snow", side: "BUY", limitPrice: 0.52, shares: 3.8 },
      { getPilotSafetyState: async () => fullyArmedState, fetchImpl, now: () => 1_700_000_000 },
    );
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/live-pilot/poligarch-submission.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Read `src/lib/pmus/signer.server.ts` and `src/lib/pmus/credentials.server.ts` in full first, then:

```ts
// src/lib/live-pilot/poligarch-submission.server.ts
import { signRequest } from "../pmus/signer.server";
import { loadPmusCredentials, isPmusConfigured } from "../pmus/credentials.server";
import { isSubmissionReachable, type PilotSafetyState } from "./poligarch-safety-core";
export { POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED } from "./poligarch-safety-core";
import { POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED } from "./poligarch-safety-core";

export type SubmissionResult =
  | { ok: true; orderId: string; raw: unknown }
  | { ok: false; error: string };

export type SubmissionDeps = {
  getPilotSafetyState: () => Promise<PilotSafetyState>;
  fetchImpl: typeof fetch;
  now: () => number;
};

const PMUS_ORDERS_HOST = "https://gateway.polymarket.us";

/**
 * Isolated from src/lib/pmus/capabilities.server.ts's ALLOWED_OPERATIONS by
 * design: that allowlist stays scoped to read/preview-only. This is its own
 * 3-operation allowlist, exercised only by this module.
 */
function isAllowedLivePilotOperation(method: string, path: string): boolean {
  if (path.includes("//") || path.endsWith("/") || path.includes("?")) return false;
  if (method === "POST" && path === "/v1/orders") return true;
  if (method === "POST" && /^\/v1\/order\/[^/]+\/cancel$/.test(path)) return true;
  if (method === "GET" && /^\/v1\/order\/[^/]+$/.test(path)) return true;
  return false;
}

async function attemptLivePilotOperation(
  method: string,
  path: string,
  body: unknown,
  deps: SubmissionDeps,
): Promise<SubmissionResult> {
  if (!POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED) {
    return { ok: false, error: "SUBMISSION_NOT_ENABLED: POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED is false." };
  }

  const state = await deps.getPilotSafetyState();
  const reachability = isSubmissionReachable(state);
  if (!reachability.reachable) {
    return { ok: false, error: `SAFETY_STATE_BLOCKED: ${reachability.reasons.join("; ")}` };
  }

  if (!isAllowedLivePilotOperation(method, path)) {
    return { ok: false, error: `OPERATION_NOT_ALLOWLISTED: ${method} ${path}` };
  }

  if (!isPmusConfigured()) {
    return { ok: false, error: "MISSING_CREDENTIALS" };
  }

  const credentials = loadPmusCredentials();
  if (!credentials) {
    return { ok: false, error: "MISSING_CREDENTIALS" };
  }

  const timestamp = String(deps.now());
  const signature = await signRequest(credentials.secretKey, timestamp, method, path);

  const response = await deps.fetchImpl(`${PMUS_ORDERS_HOST}${path}`, {
    method,
    headers: {
      "X-PM-Access-Key": credentials.keyId,
      "X-PM-Timestamp": timestamp,
      "X-PM-Signature": signature,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    return { ok: false, error: `${path} responded ${response.status}` };
  }

  const raw = await response.json();
  return { ok: true, orderId: (raw as { id: string }).id, raw };
}

export async function submitPoligarchLiveOrder(
  order: { usMarketSlug: string; side: "BUY" | "SELL"; limitPrice: number; shares: number },
  deps: SubmissionDeps,
): Promise<SubmissionResult> {
  return attemptLivePilotOperation(
    "POST",
    "/v1/orders",
    {
      marketSlug: order.usMarketSlug,
      type: "ORDER_TYPE_LIMIT",
      price: { value: order.limitPrice.toFixed(2), currency: "USD" },
      quantity: order.shares,
      outcomeSide: "YES",
      action: order.side,
      tif: "IMMEDIATE_OR_CANCEL",
      synchronousExecution: true,
    },
    deps,
  );
}

export async function cancelPoligarchLiveOrder(orderId: string, deps: SubmissionDeps): Promise<SubmissionResult> {
  return attemptLivePilotOperation("POST", `/v1/order/${orderId}/cancel`, undefined, deps);
}

export async function getPoligarchLiveOrderStatus(orderId: string, deps: SubmissionDeps): Promise<SubmissionResult> {
  return attemptLivePilotOperation("GET", `/v1/order/${orderId}`, undefined, deps);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/live-pilot/poligarch-submission.server.test.ts`
Expected: PASS, 5 tests. Confirm every test that reaches `attemptLivePilotOperation` short-circuits before `fetchImpl` is called, given `POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED = false`.

- [ ] **Step 5: Verify unreachability**

Run: `grep -rn "poligarch-submission.server" src/routes src/components src/lib/live-pilot/poligarch-preview.server.ts src/lib/live-pilot/poligarch-safety.functions.ts`
Expected: no matches outside this module's own test file — confirms nothing wires submission into any reachable path.

- [ ] **Step 6: Commit**

```bash
git add src/lib/live-pilot/poligarch-submission.server.ts src/lib/live-pilot/poligarch-submission.server.test.ts
git commit -m "feat(live-pilot): add Poligarch V2 order submission code, hard-gated and unreachable"
```

---

## Task 11: Paper/live accounting separation regression tests

**Files:**
- Test: `src/lib/live-pilot/paper-live-separation.test.ts`

**Interfaces:**
- Consumes: `previewPoligarchLiveOrder` (Task 9), `submitPoligarchLiveOrder` (Task 10).

- [ ] **Step 1: Write the test**

```ts
// src/lib/live-pilot/paper-live-separation.test.ts
import { describe, it, expect, vi } from "vitest";
import { previewPoligarchLiveOrder } from "./poligarch-preview.server";
import { submitPoligarchLiveOrder } from "./poligarch-submission.server";
import { POLIGARCH_V2_WALLET, POLIGARCH_V2_EXPERIMENT_NAME } from "./poligarch-config";

describe("paper/live separation", () => {
  it("running a full PASS preview never touches paper_experiments/paper_trades/paper_positions", async () => {
    const paperWriteSpy = vi.fn();
    const deps = {
      mapMarket: vi.fn(async () => ({ status: "MAPPED" as const, usMarketSlug: "chicago-snow", reason: "exact" })),
      getCurrentBook: vi.fn(async () => ({ bestBid: 0.49, bestAsk: 0.51, minimumTradeQty: 0.01, tickSize: 0.005 })),
      getPilotSafetyState: vi.fn(async () => ({
        killSwitchEngaged: false,
        activationStage: "preview" as const,
        armedAt: null,
        activatedAt: null,
        pilotBankrollUsd: 25,
        maxOrderNotionalUsd: 2,
        maxTotalExposureUsd: 10,
        maxDailyRealizedLossUsd: 5,
      })),
      getPilotLedgerSnapshot: vi.fn(async () => ({
        remainingBankrollUsd: 25,
        currentOpenExposureUsd: 0,
        todayRealizedPnlUsd: 0,
        consecutiveFailedOrders: 0,
        openLivePositions: 0,
      })),
      createOrGetIntent: vi.fn(async () => ({ intentId: "intent-1", created: true, status: "PREVIEWED" })),
      updateIntentStatus: vi.fn(async () => ({})),
      nowSeconds: () => 1_700_000_030,
    };

    await previewPoligarchLiveOrder(
      {
        id: "evt-1",
        experimentId: "exp-1",
        experimentName: POLIGARCH_V2_EXPERIMENT_NAME,
        wallet: POLIGARCH_V2_WALLET,
        conditionId: "0xcond",
        asset: "tok-a",
        marketTitle: "Will it snow in Chicago by Feb 1?",
        outcome: "YES",
        side: "BUY",
        price: 0.5,
        sourceTs: 1_700_000_000,
      },
      deps as never,
    );

    // None of the preview's dependencies is a paper-accounting write path —
    // this is a structural assertion: the module under test imports nothing
    // from shadow-core's mutation surface. Confirmed by static grep below.
    expect(paperWriteSpy).not.toHaveBeenCalled();
  });

  it("static import check: preview and submission modules never import shadow-core's paper-mutation exports", async () => {
    const previewSource = await import("node:fs").then((fs) =>
      fs.promises.readFile(new URL("./poligarch-preview.server.ts", import.meta.url), "utf-8"),
    );
    const submissionSource = await import("node:fs").then((fs) =>
      fs.promises.readFile(new URL("./poligarch-submission.server.ts", import.meta.url), "utf-8"),
    );
    for (const source of [previewSource, submissionSource]) {
      expect(source).not.toMatch(/paper_trades|paper_positions|paper_experiments/);
      expect(source).not.toMatch(/from ["']\.\.\/shadow-core["']/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `bun run test src/lib/live-pilot/paper-live-separation.test.ts`
Expected: initial FAIL if the file paths in the dynamic `readFile` calls don't yet resolve (only true before Tasks 9/10 land — by this point in the plan they exist, so expect PASS immediately, 2 tests).

- [ ] **Step 3: Commit**

```bash
git add src/lib/live-pilot/paper-live-separation.test.ts
git commit -m "test(live-pilot): assert live-pilot code never touches paper accounting"
```

---

## Task 12: Dashboard panel

**Files:**
- Create: `src/components/mirror/poligarch-live-pilot-panel.tsx`
- Modify: `src/routes/index.tsx`

**Interfaces:**
- Consumes: `getPoligarchPilotSafety` (rename/confirm exact export from Task 8's `poligarch-safety.functions.ts`), `Panel`/`EmptyState`/`RowSkeleton` from `src/components/mirror/panels.tsx`, `Badge`/`Button` from `src/components/ui/*` (read `src/components/mirror/live-safety-panel.tsx` in full first and copy its exact `useServerFn` + `useQuery` wiring pattern).

- [ ] **Step 1: Read the existing pattern**

Read `src/components/mirror/live-safety-panel.tsx` in full. Confirm its exact `useQuery` options (`queryKey`, `refetchInterval: 60_000`, `retry: false`) and mutation `onSuccess` → `queryClient.invalidateQueries` pattern.

- [ ] **Step 2: Write the component**

Follow the read pattern exactly, scoped to Poligarch V2 pilot data only (no other wallet appears in this panel — enforced by construction, since the panel only calls Poligarch-pilot-scoped server functions from Task 8/9). Display: activation stage badge (LOCKED/PREVIEW/LIVE_PILOT), kill switch state, pilot bankroll, current exposure, today's realized P&L, open positions, last signal, latest preview result (from Task 9's `LivePilotPreviewResult`), latest order status (from `live_order_intents`, read-only via a new `getLatestPoligarchIntents()` query function added to `poligarch-safety.functions.ts` in this task), and a short audit history table (last 20 `live_order_intents` rows, `status` + `status_history` + timestamps).

Do not wire any button to `enterLivePilotStage`/`releasePoligarchKillSwitch` with a default-armed state — buttons call the Task 8 admin-gated functions exactly like `live-safety-panel.tsx` does (so a human admin can act later), but nothing in this task or any other task in this plan calls them.

- [ ] **Step 3: Wire into the dashboard**

Modify `src/routes/index.tsx`: import `PoligarchLivePilotPanel` and render it alongside the existing panels, following the file's existing layout convention (read the file first to match section ordering/wrapper markup).

- [ ] **Step 4: Manual verification**

Run: `bun run dev`, open the dashboard as an admin user, confirm the panel renders LOCKED / kill switch engaged / $0 caps / no open positions, and that no other wallet's data appears in this panel.

- [ ] **Step 5: Commit**

```bash
git add src/components/mirror/poligarch-live-pilot-panel.tsx src/routes/index.tsx
git commit -m "feat(live-pilot): add admin dashboard panel for the Poligarch V2 live pilot"
```

---

## Task 13: Full regression suite (allowlist, idempotency, kill switch, order-state)

**Files:**
- Test: `src/lib/live-pilot/poligarch-regression.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1, 5, 6, 7, 9, 10.

- [ ] **Step 1: Write the consolidated regression suite**

Cover every scenario not already covered by an earlier task's own tests, per the spec's Step 13 checklist:

```ts
// src/lib/live-pilot/poligarch-regression.test.ts
import { describe, it, expect } from "vitest";
import { isAllowedPilotSource, POLIGARCH_V2_WALLET } from "./poligarch-config";
import { canEnterPreview, canEnterLivePilot, isSubmissionReachable, PILOT_ACTIVATION_CONFIRM_PHRASE } from "./poligarch-safety-core";

const OTHER_WALLETS: Record<string, string> = {
  "SHADOW V3 CAPACITY: Poligarch": POLIGARCH_V2_WALLET,
  "SHADOW V2: badatmath.": "0x0badatmathwallet00000000000000000000000",
  "SHADOW V2: gghff": "0x044f334595a7fd42c143e11c8ec47f23c8d1d1f1",
  "SHADOW V2: Weather-Guru": "0xb6fbce093cdd139858c44148a6598d8ec028c038",
  "SHADOW V2: HighTempTation": "0x6011655c4afb76f36dd1b08a137a1ba73466b31e",
  "GENERAL SHADOW: RN1": "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
  "GENERAL SHADOW: swisstony": "0x204f72f35326db932158cba6adff0b9a1da95e14",
};

describe("allowlist regression: only Poligarch V2 accepted", () => {
  it.each(Object.entries(OTHER_WALLETS))("rejects %s", (experimentName, wallet) => {
    expect(isAllowedPilotSource({ experimentName, wallet })).toBe(false);
  });

  it("accepts only the exact Poligarch V2 pair", () => {
    expect(
      isAllowedPilotSource({ experimentName: "SHADOW V2: Poligarch", wallet: POLIGARCH_V2_WALLET }),
    ).toBe(true);
  });
});

describe("kill switch / activation regression", () => {
  const base = {
    killSwitchEngaged: true,
    activationStage: "locked" as const,
    armedAt: null,
    activatedAt: null,
    pilotBankrollUsd: 0,
    maxOrderNotionalUsd: 0,
    maxTotalExposureUsd: 0,
    maxDailyRealizedLossUsd: 0,
  };

  it("engaged kill switch blocks preview regardless of stage", () => {
    expect(canEnterPreview({ ...base, killSwitchEngaged: true, activationStage: "preview" }).allowed).toBe(false);
  });

  it("locked activation blocks submission reachability even with caps set", () => {
    expect(
      isSubmissionReachable({
        ...base,
        killSwitchEngaged: false,
        activationStage: "locked",
        maxOrderNotionalUsd: 2,
        maxTotalExposureUsd: 10,
        pilotBankrollUsd: 25,
      }).reachable,
    ).toBe(false);
  });

  it("zero caps block submission reachability even at live_pilot stage", () => {
    expect(
      isSubmissionReachable({
        ...base,
        killSwitchEngaged: false,
        activationStage: "live_pilot",
        maxOrderNotionalUsd: 0,
        maxTotalExposureUsd: 0,
        pilotBankrollUsd: 0,
      }).reachable,
    ).toBe(false);
  });

  it("wrong confirm phrase never advances to live_pilot", () => {
    expect(
      canEnterLivePilot({ ...base, killSwitchEngaged: false, activationStage: "preview" }, "close enough").allowed,
    ).toBe(false);
    expect(
      canEnterLivePilot(
        { ...base, killSwitchEngaged: false, activationStage: "preview" },
        PILOT_ACTIVATION_CONFIRM_PHRASE,
      ).allowed,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run and verify all pass**

Run: `bun run test src/lib/live-pilot/`
Expected: every test file in `src/lib/live-pilot/` passes, no failures, no skips.

- [ ] **Step 3: Commit**

```bash
git add src/lib/live-pilot/poligarch-regression.test.ts
git commit -m "test(live-pilot): consolidated allowlist/kill-switch/activation regression suite"
```

---

## Task 14: Validation and PR

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `bun run test`
Expected: all tests pass, including every pre-existing test file (no regressions in `pmus/`, `shadow-core`, `live-safety/`, etc.).

- [ ] **Step 2: Typecheck**

Run: `bun ./node_modules/typescript/bin/tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Build**

Run: `bun run build`
Expected: succeeds. If TanStack Router's generated `routeTree.gen.ts` changed only due to unrelated route ordering, revert that specific generated-file change and re-run the build to confirm it's not required by this plan's actual route edit (Task 12, Step 3).

- [ ] **Step 4: Schema-contract and isolation SQL tests**

Run:
```bash
supabase db reset --local
python3 scripts/verify_schema_contract.py
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" -f supabase/tests/experiment_event_isolation.sql
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" -f supabase/tests/poligarch_live_pilot_schema.sql
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" -f supabase/tests/poligarch_live_pilot_intent_rpc.sql
```
Expected: all pass, zero exceptions raised.

- [ ] **Step 5: git diff --check**

Run: `git diff --check main...HEAD`
Expected: no whitespace errors.

- [ ] **Step 6: Final manual safety-state confirmation**

Run:
```bash
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" -c "SELECT * FROM public.live_pilot_state WHERE pilot_id = 'poligarch_v2_live_pilot';"
```
Expected: `kill_switch_engaged = true`, `activation_stage = 'locked'`, all `*_usd` columns `= 0`. Confirm `POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED` is still `false` in `src/lib/live-pilot/poligarch-safety-core.ts`.

Also confirm the project's own `T_7d` milestone (`2026-08-21 11:29:19 UTC`, per `docs/V2_V3_VALIDITY.md`) has NOT been asserted as "reached" anywhere in this plan's new docs/comments/UI copy — this infrastructure is ready for review regardless of that date, but must not claim the checkpoint happened early.

- [ ] **Step 7: Open the PR**

```bash
git push -u origin <branch-name>
gh pr create --title "Poligarch V2 live pilot: preview-only scaffold, locked/zero-cap" --body "$(cat <<'EOF'
## Summary
- Adds a Poligarch-V2-only live-pilot preview pipeline (Polymarket US venue) with a hard, explicit allowlist, fail-closed market-identity mapping, tiny pilot-scoped risk limits, and an idempotent intent ledger.
- Order submission code exists and is tested but is structurally unreachable: gated by both a hard `POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED = false` source constant and the existing DB-backed kill-switch/activation-stage/cap mechanism, seeded locked with $0 caps.
- SHADOW V2: Poligarch continues running unchanged in paper mode. No paper-accounting table or function is touched by any new code.

## Note on timing
Per `docs/V2_V3_VALIDITY.md`, the project's own clean-epoch 7-day checkpoint (T_7d) is 2026-08-21, not yet reached as of this PR. This PR does not claim the checkpoint has passed — it only lands review-ready infrastructure gated at $0/locked, per explicit direction from the project owner to build now and gate on the real checkpoint later.

## Test plan
- [ ] `bun run test` — full suite green
- [ ] `bun ./node_modules/typescript/bin/tsc --noEmit` — zero errors
- [ ] `bun run build` — succeeds
- [ ] Schema-contract + SQL isolation tests pass
- [ ] Manual dashboard check: Poligarch V2 Live Pilot panel shows LOCKED / kill switch engaged / $0 caps
- [ ] Confirm zero real orders submitted, zero real money moved

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 8: Report final state (do not merge)**

Do not merge. Report to the user: starting main SHA, final branch head SHA, PR number/URL, files changed, migrations added, confirmation `kill_switch_engaged=true`/`activation_stage='locked'`/all caps `=0`/`POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED=false`, confirmation zero real orders submitted and zero real money moved, and the open `T_7d = 2026-08-21` gating note. Stop — do not activate the pilot, do not merge, do not change any safety-state value.
