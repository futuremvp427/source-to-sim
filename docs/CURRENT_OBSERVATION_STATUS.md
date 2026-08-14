# Current V2/V3 observation status

Last reviewed: 2026-08-14.

## Authoritative current status

**T_clean is not established.** Do not present any V2/V3 observation window as a controlled comparison yet, and do not use the previously published 7-day or 14-day milestone dates as active milestones.

The earlier `T_clean = 2026-08-14 11:29:19.638 UTC` value was explicitly withdrawn after fresh production evidence showed recurring `canceling statement due to statement timeout` failures across multiple V2/V3 experiments. The repository's detailed audit trail remains in `docs/V2_V3_VALIDITY.md`; any later historical block in that document that records the old T_clean value or its derived milestones is retained only for audit continuity and is not current operational guidance.

## Latest verified behavior

The pending-event scan was optimized on 2026-08-14 to use an ordered `source_events` scan with an experiment-scoped correlated consumption probe. Production measurements documented in `docs/V2_V3_VALIDITY.md` show that lookup improved substantially, but a subsequent observation window still recorded `paper_processing` durations of about 8.2–13.7 seconds against an 8-second database statement timeout. That means the pending-event lookup is no longer the demonstrated bottleneck, but the broader paper-processing stage is not yet stable enough to establish a clean epoch.

## Reporting rule

Until a new clean epoch is explicitly established from production evidence:

- label V2/V3 results as post-fix observation data, not a validated controlled A/B comparison;
- do not resurrect the withdrawn T_clean timestamp or its derived 7-day/14-day milestones;
- preserve the pre-fix and withdrawn-epoch history for forensic continuity;
- require a sustained production-stable window across the full 10-experiment cohort before publishing a new T_clean.

This document changes reporting only. It does not change sizing, BUY/SELL accounting, settlement, leases/fencing, bankrolls, source-event identity, or live-order safety.
