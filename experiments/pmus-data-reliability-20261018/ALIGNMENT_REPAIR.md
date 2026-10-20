# Timestamp-aligned market data diagnostics — October 20, 2026

This change affects only the isolated data reliability repair. It does not change any frozen wallet study, historical fill, trading rule, freshness threshold, mark coverage denominator, or settlement.

## Observed cause

Run 39423892882 attempt 2, preflight job 118634831395 authenticated successfully and captured 800 full executable book messages. The original comparison sampled the most recent stream book against a cached REST response. Eleven usable pairs failed on venue timestamp skew; one matched. Six additional pairs failed the existing HTTP cache freshness limit.

Artifact `pmus-data-preflight-39423892882-2` is 1,140,668 bytes, SHA-256 `8b6fedef6d11f4c4c94247ab3e84a5bf4adc832e5646f70c56fdec38f8dc1cea`. Its 844-row stream journal verifies to hash `d2169738a5ffa64be4384cfc0161b95f729700f891bd566893c3ab6159144246`.

Offline replay against already-received stream history finds four same-venue-timestamp AND identical normalized book comparisons for each of the three markets. All six stale-HTTP pairs remain rejected. This is an offline diagnosis, not a completed live reliability gate.

## Repair

Keep at most 1,024 book samples per market and 120 seconds of receipt history in the current connection session. Compare valid REST data only against a valid book already received by the comparison time, requiring the identical venue timestamp and normalized full book. Preserve the referenced stream evidence. Reject conflicting same-timestamp history, disconnected/stale streams, late-arriving evidence and stale HTTP responses. Clear history on reconnect. Never value current holdings from a historical match: latest fresh snapshots remain separate from timestamp comparison evidence.

Save-path smoke checks use a namespace incorporating both workflow run and attempt. Retries preserve prior evidence instead of repeating the same checkpoint bootstrap. Actual full-day collection retains its fixed workflow identity and cannot silently restart.

## Validation

112 tests pass, including delayed REST/history alignment without replacing the latest snapshot, rejection of future receipts, stale HTTP, disconnects and conflicting history, and distinct retry namespaces. The captured journal replay yields 12 matched pairs and six rejected stale pairs. The updated live preflight must still pass before the 24-hour data-only check can begin. No claim of profitability or completed reliability is made.

Evidence: https://github.com/futuremvp427/source-to-sim/actions/runs/39423892882/attempts/2
