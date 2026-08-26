# Weather Translation Historical Evidence

## Purpose and safety boundary

This document records the first historical settlement-source replay for the research-only international-to-US weather translation gate.

It does **not** authorize live trading, authenticated previews, or production `EXACT_MATCH` classification. The branch remains research-only and `LIVE_EXECUTION_IMPLEMENTED=false` remains unchanged.

Polymarket US states that its weather contracts settle from the official National Weather Service Daily Climate Report (CLI). For the three audited corridors, the listed stations are:

- Los Angeles: KLAX / CLILAX
- San Francisco: KSFO / CLISFO
- Miami: KMIA / CLIMIA

Source: https://docs.polymarket.us/faqs/weather-faqs

The international weather markets sampled below state Wunderground daily station data as their resolution source. Therefore, matching airport, calendar date, and temperature bucket is necessary for translation research but is not proof of economic settlement equivalence.

## Historical replay result

The replay contains 9 independent target-linked station/date observations. Eight agree with the corresponding NWS CLI daily maximum. One does not.

| Date | Station | International bucket | International result | NWS CLI max | US-style result | Agreement |
|---|---|---:|---|---:|---|---|
| 2026-04-29 | KLAX | 52-53 F | NO | 70 F | NO | yes |
| 2026-06-05 | KLAX | 58-59 F | NO | 70 F | NO | yes |
| 2026-07-09 | KLAX | 74-75 F | YES | 74 F | YES | yes |
| 2026-08-20 | KLAX | 78-79 F | NO | 77 F | NO | yes |
| 2026-07-03 | KSFO | 68-69 F | **YES** | **70 F** | **NO** | **NO - divergence** |
| 2026-08-20 | KSFO | 64-65 F | NO | 69 F | NO | yes |
| 2026-06-05 | KMIA | <=73 F | NO | 85 F | NO | yes |
| 2026-06-20 | KMIA | 78-79 F | NO | 93 F | NO | yes |
| 2026-07-10 | KMIA | 92-93 F | YES | 93 F | YES | yes |

Observed agreement is 8/9 = 88.9%. This is a small, search-selected sample and must not be treated as an estimate of the long-run divergence rate.

### Decisive counterexample

The KSFO observation on 2026-07-03 is enough to falsify strict settlement equivalence:

- International San Francisco 68-69 F resolved **YES**.
- NWS CLISFO reports a daily maximum of **70 F**.
- A US contract using the same 68-69 F bucket and NWS CLI settlement source would therefore resolve **NO**.

Because one audited same-airport, same-date, same-bucket case resolves differently, this translation cannot be treated as economically exact.

## Consequence for the matcher

Historical settlement-source equivalence status: **DIVERGENCE_OBSERVED**.

Required behavior:

- `TRANSLATION_CANDIDATE` remains research/paper evidence only.
- `exactMatchEligible` remains permanently `false` for this historical evaluator.
- The existing authenticated-preview `EXACT_MATCH` gate must not be bypassed.
- The current historical sample must not promote the translation into paper-copy activation as though the two venues were the same contract.
- More historical research may quantify how often the data sources diverge, but additional agreement cannot erase the observed fact that settlement can differ.

## Target-trader replay sensitivity

Historical PM-US bid/ask snapshots at the target wallet's international fill timestamps were not recovered in this pass. Therefore an executable US counterfactual P/L cannot be calculated honestly.

For transparency, the following is only a **same-source-entry-price BUY-and-hold sensitivity** using six observed target BUY examples. It assumes the same price would have been available on the US venue, which is not established.

| Source observation | Shares | Source entry | US-style resolution | Same-price hypothetical P/L |
|---|---:|---:|---|---:|
| KLAX 2026-04-29, 52-53 F | 1,020.05 | 0.1c | NO | -$1.02005 |
| KLAX 2026-06-05, 58-59 F | 2,926.09 | 0.1c | NO | -$2.92609 |
| KLAX 2026-08-20, 78-79 F | 105.5 | 22.8c | NO | -$24.05400 |
| KSFO 2026-08-20, 64-65 F | 322.8 | 10.5c | NO | -$33.89400 |
| KMIA 2026-06-05, <=73 F | 1,500.87 | 0.1c | NO | -$1.50087 |
| KMIA 2026-06-20, 78-79 F | 5,866.25 | 0.2c | NO | -$11.73250 |
| **Partial sample total** |  |  |  | **-$75.12751** |

This number is **not strategy P/L**. The sample is partial and non-random, excludes SELL rows whose cost basis is unavailable, ignores later exits/hedges, and does not use contemporaneous US quotes. It must not be used to claim that the translated strategy is profitable or unprofitable.

## Evidence links

Official Polymarket US settlement rules and stations:

- https://docs.polymarket.us/faqs/weather-faqs

Target weather trader profile:

- https://polymarket.com/profile/0x8fbd7cf5f806f563080864694415829f7229a959

International market examples used in the replay:

- https://explorer.struct.to/markets/highest-temperature-in-los-angeles-on-april-29-2026-52-53f
- https://explorer.struct.to/markets/highest-temperature-in-los-angeles-on-june-5-2026-58-59f
- https://explorer.struct.to/markets/highest-temperature-in-los-angeles-on-july-9-2026-74-75f
- https://polymarket.com/event/highest-temperature-in-los-angeles-on-august-20-2026?marketSlug=highest-temperature-in-los-angeles-on-august-20-2026-78-79f&outcomeIndex=1
- https://explorer.struct.to/markets/highest-temperature-in-san-francisco-on-july-3-2026-68-69f
- https://explorer.struct.to/markets/highest-temperature-in-miami-on-june-5-2026-73forbelow
- https://explorer.struct.to/markets/highest-temperature-in-miami-on-june-20-2026-78-79f
- https://explorer.struct.to/markets/highest-temperature-in-miami-on-july-10-2026-92-93f

Representative NWS CLI evidence for the decisive San Francisco counterexample:

- https://forecast.weather.gov/product.php?format=CI&glossary=1&issuedby=SFO&product=CLI&site=MTR&version=29

## Final research verdict

**SETTLEMENT EQUIVALENCE FAILED: DIVERGENCE OBSERVED.**

Same-airport/date/bucket translation is useful for research discovery, but it is not safe evidence for `EXACT_MATCH`. Historical executable US P/L remains unverified until contemporaneous US quote data can be recovered or prospectively collected.
