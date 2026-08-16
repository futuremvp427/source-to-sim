# Current V2/V3 observation status

Last reviewed: 2026-08-16.

## Authoritative current status

**A NEW T_clean has been established: T_clean = 2026-08-16 12:09:43.355885 UTC.**

This is a distinct, newly-established epoch boundary, evidenced directly from production on 2026-08-16 — it is **not** a resurrection of the earlier `T_clean = 2026-08-14 11:29:19.638 UTC` value. That earlier value remains explicitly withdrawn and historical; see "History" below. Do not conflate the two.

Derived milestones (PostgreSQL-computed, not host-clock-derived):
- **T_7d** = 2026-08-23 12:09:43.355885 UTC
- **T_14d** = 2026-08-30 12:09:43.355885 UTC

## Evidence for this establishment

Read-only production audit performed 2026-08-16 (~13:17 UTC). All 10 V2/V3 cohort experiments were checked directly against live production data:

- The full cohort's last recorded failure of any kind was an isolated, non-cascading, self-resolved `ingest cycle exceeded 40000ms deadline` timeout affecting only `SHADOW V2: Poligarch` and `SHADOW V3 CAPACITY: Poligarch` at 2026-08-16 12:04:47.381845 UTC — not a 429, and not repeated. Both experiments completed a clean cycle by 12:09:43.355885 UTC, confirmed via `pipeline_audit` rows.
- Zero poll failures of any kind (429, timeout, statement-timeout, abandoned-cycle, `CatchupProgressionError`) have been recorded for any of the 10 cohort experiments since 12:04:47.381845 UTC.
- All 10 cohort experiments currently show `poll_failures = 0`, `last_error = null`, and a fresh heartbeat.
- `source_events` → `experiment_event_state` anti-join = **zero** missing rows for all 10 experiments as of the boundary (verified against non-trivial totals ranging 1,483–32,932 events per experiment, all fully consumed) — including `SHADOW V2: Poligarch` specifically (32,932/32,932 consumed).
- V2/V3 sibling checkpoints remain exactly aligned per wallet (`badatmath.`, `gghff`, `HighTempTation`, `Poligarch`, `Weather-Guru` each show identical `last_source_ts` between their V2 and V3 CAPACITY rows).
- An earlier, larger 429 storm affecting the full cohort occurred 2026-08-16 03:12–03:52 UTC (repeated `data-api.polymarket.com/trades responded 429` failures across all 10 experiments); the zero-row anti-join as of the new boundary proves this storm was fully recovered from with no permanently missing source-event coverage.
- This satisfies the same two-criterion standard used to establish the (now-withdrawn) earlier T_clean: (A) full-cohort successful-cycle completion after the boundary, and (B) a sustained, verified stable window following it — here, continuously clean since 12:09:43.355885 UTC.

T_clean is set to 2026-08-16 12:09:43.355885 UTC specifically because that is the earliest point supported by this evidence: the moment the last two (of 10) cohort experiments proved recovery from the last known failure, with nothing having failed for any experiment since.

## History (preserved, not current operational guidance)

The earlier `T_clean = 2026-08-14 11:29:19.638 UTC` value was explicitly withdrawn on 2026-08-14 after fresh production evidence showed recurring `canceling statement due to statement timeout` failures across multiple V2/V3 experiments. It was never re-established under that name — the 2026-08-14 root causes (deep-offset `copyability_observations` reads, `persistEvents` requests never being cancelled on deadline) were separately fixed, and a further 429 storm occurred as recently as 2026-08-16 03:12–03:52 UTC, well after that 2026-08-14 value's own window. The repository's detailed audit trail remains in `docs/V2_V3_VALIDITY.md`; any historical block in that document that records the old T_clean value or its derived milestones is retained only for audit continuity and must not be presented as current operational guidance. **The new T_clean above is a separate, later-established value — it does not retroactively validate or resurrect the 2026-08-14 value or any window measured against it.**

## Latest verified behavior

The pending-event scan optimization (ordered `source_events` scan with an experiment-scoped correlated consumption probe, `CROSS JOIN LATERAL` + `NOT EXISTS`) is confirmed live in production (verified directly against the deployed function definition). The durable host-level rate-limit cooldown (`http_rate_limits` / `record_http_rate_limit`) is confirmed operating in production, with its earliest observed write at 2026-08-16 10:32:09 UTC. A follow-up privilege-hardening migration for that same function (adding a `service_role`-only runtime guard) has been merged to the repository but is **not yet deployed** to production as of this review — production's live function definition still matches the original, pre-hardening version. This is a separate, security-relevant deployment gap and does not affect the T_clean determination above.

## Reporting rule

- Label V2/V3 results measured against the new T_clean (2026-08-16 12:09:43.355885 UTC) as the current controlled observation epoch.
- Do not resurrect the withdrawn 2026-08-14 T_clean timestamp or its derived milestones as if they were still active.
- Preserve the pre-fix, withdrawn-epoch, and 2026-08-16 03:12–03:52 UTC storm history for forensic continuity.
- Given the new T_clean was established only recently, expect most or all of the 10 cohort experiments to classify as **INSUFFICIENT NEW DATA** for some time — this is expected and correct, not a defect in the establishment above.

This document changes reporting only. It does not change sizing, BUY/SELL accounting, settlement, leases/fencing, bankrolls, source-event identity, or live-order safety.
