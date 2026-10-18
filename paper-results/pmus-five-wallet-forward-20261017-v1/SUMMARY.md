# Five-wallet US sports paper test

Study: `pmus-five-wallet-forward-20261017-v1`
Measured through: **2026-10-18T06:04:20.933592+00:00**

Collection ends: 2026-10-19T20:03:43.250398+00:00; settlement hard stop: 2026-10-21T20:03:43.250398+00:00

Each account starts with $1,000 fictional capital. Source account profits are not follower profits. No live orders.

| Wallet | Status | Completed distinct markets | Net after modeled fees | Stress net | Open markets | Contracts bought | Elapsed source coverage |
|---|---|---:|---:|---:|---:|---:|---:|
| omnibus-076daa | SCREEN_PENDING | 13 | $9.45 | $8.12 | 1 | 150.03 | 99.9% |
| mooseborzoii | SCREEN_PENDING | 19 | $-31.28 | $-35.45 | 2 | 349.58 | 99.9% |
| HomeRunHazard | SCREEN_PENDING | 17 | $23.85 | $20.90 | 5 | 270.17 | 99.9% |
| gmpm2 | SCREEN_PENDING | 3 | $-5.59 | $-6.09 | 0 | 40.00 | 99.9% |
| ethanaz | SCREEN_PENDING | 6 | $-0.21 | $-0.81 | 1 | 70.09 | 99.9% |

`summary.json` contains cash, marks, mark coverage, observed drawdown, fees, timing, quantities and skip reasons.
A successful source poll is not proof of a new fill. See each wallet's latest returned source-trade timestamp separately.
Open positions remain open until a modeled exit or verified US settlement; unavailable marks are not zero profit.
Same-event/team associations follow the US contract's rules and are never labeled EXACT.
Even a promising result is a short screen. Event-cluster resampling does not remove cross-game, day or wallet-selection dependence.
