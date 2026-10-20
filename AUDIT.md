# AeroDataBox free-tier audit (2026-10-20)

Plan constraints treated as authoritative: 400 API units/month and 1,600 requests/month (both hard limits), Tier 1 = 1 unit, Tier 2 = 2, Tier 3 = 6, Free = 0, flight plan ×2, 7-day retention, attribution required, no commercial use.

## Verified against provider documentation

| Fact | Source | Status |
|---|---|---|
| `GET /flights/{searchBy}/{searchParam}/{dateLocal}` is **TIER 2** (2 units) | OpenAPI spec, `doc.aerodatabox.com/docs/openapi-rapidapi-v1.json`, endpoint summary "Flight Status (single day) / TIER 2" | Verified |
| Range history = TIER 3, FIDS = TIER 2, airline fleet = TIER 3, `/health/*` = FREE TIER | Same spec | Verified (none of these is used by the app) |
| `withFlightPlan` defaults to `false`. When `true` and a plan is found, "the request may be billed x 2" | Same spec, parameter description | Verified |
| Attribution is required on free/trial plans. It must be prominent, clearly identify AeroDataBox, and include a live link if feasible | aerodatabox.com/terms §5.4, aerodatabox.com/faq | Verified requirement; **no exact wording is published** |
| Retention: 7 consecutive calendar days; minimise volume/duration; no permanent copies | Terms §5.2(g), §5.5; FAQ | Verified |
| Units reset "at the end of each billing cycle" | FAQ | Verified. The cycle may not be the calendar month (see Risks) |
| Basic: 1 request/s, plus 1,000 requests/hour | aerodatabox.com/pricing | Verified (pricing page) |
| Whether 4xx/5xx/204/timeouts are billed | Not documented anywhere I could find | **Unverified**, so treated as billed |
| 1,600 requests/month cap | Not shown on the public pricing page; given in the task brief | Enforced as specified; confirm on the RapidAPI plan page |

## Call sites (before changes)

Only one function sent AeroDataBox requests: `adbFetch` in `src/Providers.js`.

| # | Caller | Endpoint / params | Trigger | Requests | Units (verified) | Accounted? |
|---|---|---|---|---|---|---|
| 1 | `runTick_` step 1 → `fetchFlightInfo` → `adbFetch` (`Tracker.js`, `Providers.js`) | `/flights/number/{flight}/{date}?dateLocalRole=Arrival\|Departure&withAircraftImage=false&withLocation=false` (Tier 2; `withFlightPlan` omitted, defaults to false) | 5-min trigger, menu "Run a check now", menu "Send cab plan". Per flight: T-6h, takeoff confirm, landing fallback, arr−24h enrich when Sched Dep is blank, failure retries every 15 min | Up to `MAX_ADB_CALLS_PER_FLIGHT` (4) per row; **one per row even when rows share a flight** | 2 | Partly: units only; 401/403/429/network errors not counted |
| 2 | `runTick_` → `checkFirstLeg_` → `adbFetch` (`Tracker.js`) | Same endpoint, first-leg flight, `dateLocalRole=Arrival` | After any successful check of a row with First Leg Flight | 1 per row | 2 | Counted after the fact, but **no budget check and outside the per-flight cap** |
| — | Import, menus, tests | No direct AeroDataBox calls (tests stub `fetchFlightInfo`) | — | 0 | — | — |
| — | FlightAware `faFetch` | Called from `fetchFlightInfo` whenever AeroDataBox fails | Same as #1 | 1 per failed ADB call | n/a | n/a |

## Violations and risks found

1. **No request limit.** Only units were tracked; the 1,600-request cap was not enforced at all.
2. **Wrong unit limit.** `ADB_MONTHLY_UNITS` defaulted to 600; the plan allows 400.
3. **Budget bypass with FlightAware.** `Tracker.js:194` skipped the budget check whenever `FA_KEY` was set, so AeroDataBox kept being called past the budget.
4. **First-leg check bypassed the budget and the per-flight cap** (`checkFirstLeg_`).
5. **Fails open on a corrupt counter.** `Number('garbage')` is `NaN`, `NaN + 2 > 600` is false, so requests were allowed. A deleted counter also silently reset to 0.
6. **Check-then-act, not reserve-then-send.** The budget was checked in the tracker and recorded after the response, with an unlocked read-modify-write on the counter.
7. **Undercounting.** 401/403/429 responses and network/timeout exceptions were treated as free, which the documentation does not support.
8. **Duplicate lookups.** Two faculty on the same flight caused two Tier-2 calls in the same tick.
9. **Wasteful retries.** A bad key (401/403) was retried per flight up to the cap; 429 had no global back-off.
10. **Redundant takeoff check.** The AeroDataBox takeoff call ran even when OpenSky had already seen the aircraft airborne, because the AeroDataBox step ran first.
11. **No 7-day retention.** AeroDataBox-derived times, terminal, gate, callsign and transponder id stayed in the Flights sheet indefinitely, and the Log sheet kept up to 3,000 rows of status text.
12. **No attribution** anywhere.
13. **No parameter validation** (±365-day date range, flight plan flag, endpoint whitelist).
14. **No 1 request/s spacing.**
15. **No UNKNOWN status** when a lookup couldn't be performed. Arrivals without Sched Dep were also never handed to OpenSky if AeroDataBox was unavailable.
16. **README overstated capacity** ("600 units", "100+ trips").

## Files that need changes

- `src/AdbClient.js` (new): the single gateway, covering endpoint registry, validation, reservation, usage store, cache and usage log.
- `src/Providers.js`: route through the gateway, remove the old counter, bound FlightAware calls.
- `src/Tracker.js`: OpenSky before AeroDataBox, UNKNOWN on blocked lookups, first leg through the gateway, retention purge.
- `src/Config.js`, `src/Sheet.js`, `src/Alerts.js`, `src/Menu.js`: limits, usage sheet, attribution, usage/sync/resume menu items.
- `README.md`, tests.

## Resolution (implemented)

| # | Fix |
|---|---|
| 1, 2 | Separate unit (400) and request (1,600) counters, clamped to the plan in `ADB_PLAN`, each checked before every request |
| 3, 4 | Every request goes through `adbRequest()`, the first-leg check included. FlightAware no longer bypasses anything; it counts towards the same per-flight cap |
| 5 | Usage store is validated (JSON, whole numbers, period, init marker). Any doubt means nothing is sent, plus an alert |
| 6 | Reserve-then-send under the document lock; reservations are finalised exactly once |
| 7 | All responses and timeouts stay charged; timeouts are logged as UNKNOWN and not retried for 30 min |
| 8 | Per-execution dedupe plus a 20-min CacheService reuse |
| 9 | 401/403 suspend lookups until manually resumed; 429 pauses for 1 h, or marks the period exhausted if the quota is used up |
| 10 | OpenSky runs first; the takeoff check is skipped when a live fix exists |
| 11 | Provider-derived fields are purged after 156 h (max 168); Log rows older than that are purged hourly |
| 12 | Attribution on every message and on the About sheet; wording flagged for confirmation |
| 13 | Endpoint registry with validation: ±365 days, `withFlightPlan` rejected, history ≤ 7 days, FIDS ≤ 12 h, fleet ≤ 10 |
| 14 | Requests spaced ≥ 1.1 s apart; hourly cap of 1,000 requests |
| 15 | UNKNOWN status when a lookup is blocked or fails twice; OpenSky window for arrivals without a departure time |
| 16 | README rewritten with verified costs and capacity |
| R1 | Billing cycle: usage stored per day. Default is a rolling 33-day window (any 31-day cycle plus one day of margin), safe for any reset day or timezone. `ADB_BILLING_CYCLE_DAY` 1–31 gives aligned cycles once confirmed. An invalid setting fails closed |
| D1 | Review: a blank "Sync usage" answer zeroed the counters. Input must now be digits |
| D2 | Review: Sync silently lowered a higher local count and dropped in-flight charges. Lowering now needs a second confirmation; in-flight reservations and the hourly counter are kept |
| D3 | Review: the first version's counter `ADB_UNITS_<YYYY-MM>` was ignored. It is now imported (this month and last) when no new-format store exists |
| D4 | Review: the 32-day rolling window had zero margin for request latency, clock skew or a DST hour at a provider reset. Widened to 33 days |
| D5 | Review: `days: []`, malformed pending entries and bad suspension values passed validation. They now fail closed |
| R2 | "Flight not found" (204, or a flight that doesn't touch the airport) is retried after 3 h, not every 15 min; coordinators are alerted at once |

## Hardening addendum (secrets, setup and configuration)

| # | Finding | Fix |
|---|---|---|
| S1 | `sendTelegram_` logged `'Telegram error: ' + e`. A UrlFetchApp network error normally includes the request URL, and the Telegram URL contains the bot token, so the token could reach the Log sheet and the execution log | Every log line, coordinator alert and rethrown tick error passes through `redactSecrets()`, which masks the configured secret values and anything shaped like a bot token |
| S2 | `listTelegramChats` called `UrlFetchApp.fetch` without `muteHttpExceptions`; a 401 threw "Request failed for https://api.telegram.org/bot<token>/…" into the error dialog | HTTP errors are muted and reported without the URL; network errors are redacted |
| S3 | Resume cleared a provider-reported quota suspension without warning | Needs an explicit second confirmation; the override is recorded on API Usage |
| C1 | The Config sheet was written only when empty, so existing sheets never received new settings; a non-numeric value silently became NaN | "Set up sheets" appends missing settings and refreshes notes without changing any value. A bad number falls back to the default and is reported. Obsolete, unknown and over-plan values are reported by Check setup |
| C2 | Secret names were plain strings at each call site | One registry (`SECRETS` in `src/Config.js`). `secret()` rejects unregistered names, and tests and `npm run doctor` check that every name read in code is registered and documented |

Quota behaviour (fixes 1–16, R1–R2, D1–D5) is unchanged by this addendum.
