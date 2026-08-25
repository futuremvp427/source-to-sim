#!/usr/bin/env bash
set -euo pipefail

# CANARY-1: real-Postgres concurrency proof for atomic Sports Shadow epoch
# resolution. The runner opens independent psql sessions concurrently so the
# database RPC must serialize the rollover itself.

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-54322}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

PSQL=(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -X -v ON_ERROR_STOP=1)

psql_scalar() {
  "${PSQL[@]}" -qAt -c "$1"
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local message="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "ASSERTION FAILED: $message; expected [$expected], got [$actual]" >&2
    exit 1
  fi
}

original_current_id="$(
  psql_scalar "SELECT COALESCE((SELECT id::text FROM public.sports_shadow_experiment_epochs WHERE is_current AND config_hash NOT LIKE 'canary-epoch-concurrency-%' LIMIT 1), '')"
)"

cleanup() {
  set +e
  if [[ -n "$original_current_id" ]]; then
    "${PSQL[@]}" -q -v original_current_id="$original_current_id" <<'SQL' >/dev/null
UPDATE public.sports_shadow_experiment_epochs
SET is_current = false
WHERE is_current AND config_hash LIKE 'canary-epoch-concurrency-%';

UPDATE public.sports_shadow_experiment_epochs
SET is_current = true
WHERE id = :'original_current_id'::uuid;

DELETE FROM public.sports_shadow_experiment_epochs
WHERE config_hash LIKE 'canary-epoch-concurrency-%';

DELETE FROM public.sports_shadow_source_fills
WHERE event_key = 'canary-null-epoch-fill';
SQL
  else
    "${PSQL[@]}" -q <<'SQL' >/dev/null
UPDATE public.sports_shadow_experiment_epochs
SET is_current = false
WHERE is_current AND config_hash LIKE 'canary-epoch-concurrency-%';

DELETE FROM public.sports_shadow_experiment_epochs
WHERE config_hash LIKE 'canary-epoch-concurrency-%';

DELETE FROM public.sports_shadow_source_fills
WHERE event_key = 'canary-null-epoch-fill';
SQL
  fi
}
trap cleanup EXIT
cleanup

"${PSQL[@]}" -q <<'SQL'
DO $$
DECLARE
  v_oid oid;
BEGIN
  v_oid := 'public.ensure_sports_shadow_current_epoch(timestamp with time zone, text[], text, text, text, text, text, text, text, text, text, text)'::regprocedure;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must have EXECUTE on ensure_sports_shadow_current_epoch';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on ensure_sports_shadow_current_epoch';
  END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not have EXECUTE on ensure_sports_shadow_current_epoch';
  END IF;
END;
$$;
SQL

call_epoch_once() {
  local go_live_at="$1"
  local wallet="$2"
  local git_sha="$3"
  local config_hash="$4"
  local classifier_version="$5"
  local episode_version="$6"
  local resolver_version="$7"
  local router_version="$8"
  local pmus_fee_model_version="$9"
  local kalshi_fee_model_version="${10}"
  local execution_simulator_version="${11}"
  local settlement_version="${12}"

  "${PSQL[@]}" -qAt \
    -v go_live_at="$go_live_at" \
    -v wallet="$wallet" \
    -v git_sha="$git_sha" \
    -v config_hash="$config_hash" \
    -v classifier_version="$classifier_version" \
    -v episode_version="$episode_version" \
    -v resolver_version="$resolver_version" \
    -v router_version="$router_version" \
    -v pmus_fee_model_version="$pmus_fee_model_version" \
    -v kalshi_fee_model_version="$kalshi_fee_model_version" \
    -v execution_simulator_version="$execution_simulator_version" \
    -v settlement_version="$settlement_version" <<'SQL'
SELECT (public.ensure_sports_shadow_current_epoch(
  :'go_live_at'::timestamptz,
  ARRAY[:'wallet']::text[],
  :'git_sha',
  :'config_hash',
  :'classifier_version',
  :'episode_version',
  :'resolver_version',
  :'router_version',
  :'pmus_fee_model_version',
  :'kalshi_fee_model_version',
  :'execution_simulator_version',
  :'settlement_version'
)).id::text;
SQL
}

call_epoch_concurrently() {
  local label="$1"
  local calls="$2"
  shift 2
  local tmpdir
  local failures=0
  local pids=()
  local ids=()
  local first_id

  tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/sports-shadow-epoch-${label}.XXXXXX")"
  for ((i = 1; i <= calls; i += 1)); do
    call_epoch_once "$@" >"$tmpdir/$i.out" 2>"$tmpdir/$i.err" &
    pids+=("$!")
  done

  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then
      failures=1
    fi
  done
  if [[ "$failures" -ne 0 ]]; then
    cat "$tmpdir"/*.err >&2
    rm -rf "$tmpdir"
    exit 1
  fi

  while IFS= read -r id; do
    [[ -n "$id" ]] && ids+=("$id")
  done < <(cat "$tmpdir"/*.out)

  if [[ "${#ids[@]}" -ne "$calls" ]]; then
    echo "ASSERTION FAILED: $label expected $calls epoch ids, got ${#ids[@]}" >&2
    rm -rf "$tmpdir"
    exit 1
  fi

  first_id="${ids[0]}"
  if [[ -z "$first_id" ]]; then
    echo "ASSERTION FAILED: $label returned an empty epoch id" >&2
    rm -rf "$tmpdir"
    exit 1
  fi

  for id in "${ids[@]}"; do
    if [[ "$id" != "$first_id" ]]; then
      echo "ASSERTION FAILED: $label returned divergent epoch ids: ${ids[*]}" >&2
      rm -rf "$tmpdir"
      exit 1
    fi
  done

  rm -rf "$tmpdir"
  printf '%s\n' "$first_id"
}

wallet="0x1111111111111111111111111111111111111111"

# Same identity: 10 concurrent callers converge on one current epoch and one id.
id_a="$(
  call_epoch_concurrently same-a 10 \
    '2026-08-25T00:00:00Z' "$wallet" \
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    'canary-epoch-concurrency-a' \
    'classifier-a' 'episode-a' 'resolver-a' 'router-a' \
    'pmus-fee-a' 'kalshi-fee-a' 'sim-a' 'settlement-a'
)"
assert_eq "$(psql_scalar "SELECT count(*) FROM public.sports_shadow_experiment_epochs WHERE is_current")" "1" "same identity must leave exactly one current epoch"
assert_eq "$(psql_scalar "SELECT config_hash FROM public.sports_shadow_experiment_epochs WHERE is_current")" "canary-epoch-concurrency-a" "same identity must create current A"

# New identity B over current A: concurrent callers create exactly one B current.
id_b="$(
  call_epoch_concurrently new-b 10 \
    '2026-08-25T00:00:00Z' "$wallet" \
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
    'canary-epoch-concurrency-b' \
    'classifier-a' 'episode-a' 'resolver-a' 'router-a' \
    'pmus-fee-a' 'kalshi-fee-a' 'sim-a' 'settlement-a'
)"
assert_eq "$(psql_scalar "SELECT count(*) FROM public.sports_shadow_experiment_epochs WHERE is_current")" "1" "new identity must leave exactly one current epoch"
assert_eq "$(psql_scalar "SELECT config_hash FROM public.sports_shadow_experiment_epochs WHERE is_current")" "canary-epoch-concurrency-b" "new identity must create current B"

# Subsequent same B call: no extra B row is created.
b_count_before="$(psql_scalar "SELECT count(*) FROM public.sports_shadow_experiment_epochs WHERE config_hash = 'canary-epoch-concurrency-b'")"
id_b_again="$(
  call_epoch_concurrently same-b 10 \
    '2026-08-25T00:00:00Z' "$wallet" \
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
    'canary-epoch-concurrency-b' \
    'classifier-a' 'episode-a' 'resolver-a' 'router-a' \
    'pmus-fee-a' 'kalshi-fee-a' 'sim-a' 'settlement-a'
)"
assert_eq "$id_b_again" "$id_b" "subsequent same-B calls must return the existing B epoch"
assert_eq "$(psql_scalar "SELECT count(*) FROM public.sports_shadow_experiment_epochs WHERE config_hash = 'canary-epoch-concurrency-b'")" "$b_count_before" "subsequent same-B calls must not create another B row"

# Different deployment SHA: creates one new current epoch.
id_c="$(
  call_epoch_concurrently new-sha 10 \
    '2026-08-25T00:00:00Z' "$wallet" \
    'cccccccccccccccccccccccccccccccccccccccc' \
    'canary-epoch-concurrency-b' \
    'classifier-a' 'episode-a' 'resolver-a' 'router-a' \
    'pmus-fee-a' 'kalshi-fee-a' 'sim-a' 'settlement-a'
)"
if [[ "$id_c" == "$id_b" ]]; then
  echo "ASSERTION FAILED: different deployment SHA returned previous B epoch $id_b" >&2
  exit 1
fi
assert_eq "$(psql_scalar "SELECT git_sha FROM public.sports_shadow_experiment_epochs WHERE is_current")" "cccccccccccccccccccccccccccccccccccccccc" "different deployment SHA must become current once"
assert_eq "$(psql_scalar "SELECT count(*) FROM public.sports_shadow_experiment_epochs WHERE is_current")" "1" "different deployment SHA must leave exactly one current epoch"

# Different go-live boundary: creates one new current epoch.
id_d="$(
  call_epoch_concurrently new-go-live 10 \
    '2026-08-26T00:00:00Z' "$wallet" \
    'cccccccccccccccccccccccccccccccccccccccc' \
    'canary-epoch-concurrency-b' \
    'classifier-a' 'episode-a' 'resolver-a' 'router-a' \
    'pmus-fee-a' 'kalshi-fee-a' 'sim-a' 'settlement-a'
)"
if [[ "$id_d" == "$id_c" ]]; then
  echo "ASSERTION FAILED: different go-live boundary returned previous epoch $id_c" >&2
  exit 1
fi
assert_eq "$(psql_scalar "SELECT (SELECT go_live_at FROM public.sports_shadow_experiment_epochs WHERE is_current) = '2026-08-26T00:00:00Z'::timestamptz")" "t" "different go-live boundary must become current once"
assert_eq "$(psql_scalar "SELECT count(*) FROM public.sports_shadow_experiment_epochs WHERE is_current")" "1" "different go-live boundary must leave exactly one current epoch"

# DB guardrails must reject future NULL epoch-bearing research rows while
# allowing existing failed-canary evidence to remain unvalidated.
"${PSQL[@]}" -q <<'SQL'
DO $$
DECLARE
  v_fill_id uuid;
BEGIN
  BEGIN
    INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis)
    VALUES ('canary-null-epoch-fill', '0x1111111111111111111111111111111111111111', 'asset', 'BUY', 1, 'source_id')
    RETURNING id INTO v_fill_id;

    INSERT INTO public.sports_shadow_signals (
      episode_key, source_wallet, source_asset, first_fill_id, source_first_fill_at, source_last_fill_at,
      bet_type, selected_side, experiment_epoch_id
    ) VALUES (
      'canary-null-epoch-signal', '0x1111111111111111111111111111111111111111', 'asset',
      v_fill_id, now(), now(), 'MONEYLINE', 'TEAM', NULL
    );
    RAISE EXCEPTION 'expected future sports_shadow_signals NULL experiment_epoch_id insert to fail';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;
SQL

echo "sports_shadow_epoch_concurrency.sh: all assertions passed"
