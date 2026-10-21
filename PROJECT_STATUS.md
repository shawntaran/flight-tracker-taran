# PROJECT_STATUS: Faculty Flight Tracker

*Handoff document for people and AI agents. Last updated: 2026-10-21 (status refresh: git state, assistant test count, repo map; §8, §11, §14): hardening pass, then the Flight Tracking, UI Design and Telegram Bot Setup workstreams (§14).*

**Treat this as a map, not as proof.** Check the code before relying on any claim here, and update this file when you finish a task.

---

## 1. Project overview

**What it does.** It tracks the flights of visiting international faculty arriving at and departing from Bengaluru (BLR), and:
- alerts coordinators (optionally faculty and drivers) when a flight is delayed, cancelled, diverted, airborne or has landed;
- groups people into shared airport cabs and re-plans the groups when flights change.

It was requested via Siva sir. The source data is the "ITW Faculty Travel Details.xlsx" spreadsheet.

**Users:**
- **Coordinators** maintain the sheet and receive alerts.
- **Drivers** receive "landed" and "plan changed" messages, if their Telegram chat id is entered on the Groups sheet.
- **Faculty** receive alerts only if `NOTIFY_FACULTY` is on.

**Main workflows:**
1. Import the travel spreadsheet into the **Flights** sheet.
2. A trigger runs `tick()` every 5 minutes. Each tick: OpenSky live positions, then scheduled AeroDataBox checks, then status/ETA change alerts, then cab re-planning, then notifications.
3. Coordinators operate it from the **Flight Tracker** menu: setup, Check setup, test alert, test lookup, usage, sync, resume.

**Deployment target:** a Google Sheet with a **bound** Apps Script project (V8 runtime, timezone Asia/Kolkata) on a consumer or Workspace Google account.

**Hard constraint:** free tools only. AeroDataBox Basic is non-commercial, with attribution required.

## 2. Current architecture

All files in `src/` share one global scope, as Apps Script requires. Every top-level statement only uses definitions from its own file, so the order files load in doesn't matter. `npm run doctor` checks this by loading each file alone in an empty sandbox.

```
 time trigger (5 min)            spreadsheet menu (Menu.js, Diagnostics.js)
        │                                 │
        ▼                                 ▼
 Tracker.tick() ── LockService script lock ──► Tracker.runTick_()
        │
        ├─ Sheet.readFlights() → Tracker.prepareRow()      (normalise inputs, reset state on edits)
        ├─ Tracker.purgeExpiredProviderData(), Sheet.purgeOldLogs_()   (7-day retention)
        ├─ 1. OpenSky  Providers.openskyStates() → findState() → liveEta() → Tracker.applyLive()
        ├─ 2. Checks   Providers.fetchFlightInfo()
        │                 ├─ AdbClient.adbRequest()   ◄── the ONLY code that sends AeroDataBox requests
        │                 │     validate → dedupe → cache → reserve (document lock) → fetch → finalise → log
        │                 └─ Providers.faFetch()       FlightAware backup, once per flight/date per run
        │              Tracker.applyInfo(), nextCheckTime(), checkFirstLeg_() (also via adbRequest)
        ├─ 3. Grouping.planGroups() → carryDrivers() → applyGroups() → Sheet.writeGroupsSheet()
        ├─ 4. Tracker.detectChange() / UNKNOWN / no-landing-confirmation alerts
        ├─ Sheet.writeFlights()
        └─ Alerts.Outbox.flush() → repeat filter → Gmail (MailApp) + Alerts.tgDeliver_()
                tgDeliver_: "Telegram Deliveries" sheet (QUEUED → SENT / RETRY / FAILED / UNCONFIRMED / EXPIRED),
                            due retries first, then new messages; attribution on every part
```

**Flight lifecycle** (`Tracker.js`, `nextCheckTime`).

*Arrivals:*
1. Learn the departure time at arrival − 24 h, only if Sched Dep is blank.
2. Status check at T-6 h.
3. Takeoff confirmation at departure + 10 min. It's skipped if OpenSky already has a live fix.
4. Landing fallback at ETA + 30 min, only if OpenSky never saw the landing.

*Departures:* one check at T-6 h.

*Caps and failures:*
- At most `MAX_ADB_CALLS_PER_FLIGHT` (4) provider calls per row.
- A blocked lookup, or two failures in a row, sets status **UNKNOWN** and alerts.
- "Flight not found" is retried after 3 h.
- An unknown outcome (timeout) is retried after 30 min.

*Statuses:* SCHEDULED, DELAYED, DEPARTED, LANDED, CANCELLED, DIVERTED, UNKNOWN.

**AeroDataBox** (`AdbClient.js` and `Providers.parseAdbLegs`): see §7.

**OpenSky** (`Providers.js`):
- One `/states/all` call per tick, made only when an arrival should be airborne. It's filtered by icao24 when every tracked flight has one.
- OAuth2 client credentials if both OpenSky properties are set, anonymous otherwise.
- Own ETA = distance ÷ ground speed + an approach allowance.
- On the ground within 15 km of the airport = landed.

**FlightAware** (`Providers.faFetch`): AeroAPI `/flights/{ident}`. It's used only when AeroDataBox fails or is blocked and `FA_KEY` is set. It counts towards the per-flight cap and is memoised per run.

**Telegram and email** (`Alerts.js`; details and the full interface in §14 "Telegram Bot Setup"):
- An `Outbox` collects one tick's messages. Coordinator messages are joined into one Telegram message per chat, plus one email. Direct messages go to drivers and faculty, by Telegram if they have a private chat id, else by email.
- **Repeat filter:** a text identical to one in the recipient's previous alert from the last 120 min is dropped (CacheService, best effort). This stops a persistent tick error alerting every 5 min.
- **Delivery:** `tgDeliver_` writes each Telegram message × recipient to the **Telegram Deliveries** sheet before sending, then records the outcome. Transient failures (429, 5xx, network) are retried in later ticks: 4 attempts, backoff 5/10/20 min, expiry after 120 min. Permanent ones (400, 403) aren't retried. A 401 stops all sending for the run. A network error is retried once at most, because the message may have arrived.
- **Formatting:** plain text (no `parse_mode`). Long texts are split at paragraph breaks into numbered parts, and the attribution goes on every part.
- **Recipients:** only numeric chat ids are used; `@usernames` are refused. Group ids are allowed for coordinators only. Every log line, stored text and error passes through `redactSecrets`.

**Cab planning** (`Grouping.js`):
- Greedy grouping per (direction, airport, terminal), within a 45-min window from the first person, up to the seat cap.
- Notifications go out only when a group's members change or its pickup moves by 15 min or more.

## 3. Repository map

```
.
├── README.md              Setup guide and operating notes (start here to deploy)
├── PROJECT_STATUS.md      This handoff document
├── AUDIT.md               AeroDataBox free-tier audit, review findings D1–D5, hardening addendum S1–S3/C1–C2
├── package.json           npm scripts: test, doctor, push (no dependencies)
├── .gitignore             Secrets, clasp binding, real-data exports, logs, OS files
├── .env.example           Names of the 5 secrets, documentation only (nothing reads it)
├── .clasp.json.example    Template for your own .clasp.json (scriptId + rootDir "src")
├── src/                   Apps Script source (clasp rootDir); each .js file becomes a .gs file
│   ├── appsscript.json    Manifest: V8, Asia/Kolkata, 5 OAuth scopes, web app owner-only (§14)
│   ├── Dashboard.js       Overview dashboard web app: doGet, openDashboard menu link, read-only getDashboardData
│   ├── DashboardPage.html The dashboard page (Stitch design, light default, dark toggle, assistant shell)
│   ├── AdbClient.js       AeroDataBox gateway: plan limits, endpoint registry/validation, usage store,
│   │                      reservations, rolling/cycle accounting window, cache, sync/resume
│   ├── Providers.js       AeroDataBox response parsing, FlightAware backup, OpenSky client and ETA maths
│   ├── Tracker.js         tick()/runTick_(): state machine, change detection, UNKNOWN handling, retention purge
│   ├── Grouping.js        Cab grouping (pure), driver carry-over, group messages
│   ├── Alerts.js          Outbox, repeat filter, Gmail, Telegram delivery (classify, retry, split, Deliveries
│   │                      sheet store), chat-id validation, chat-id listing, "Check Telegram bot", test alert
│   ├── Config.js          DEFAULTS (Config sheet), SECRETS registry, secret(), secret status, redaction,
│   │                      config merge/validation, Config-sheet migration planner
│   ├── Sheet.js           Sheet schema (COLS), setupSheets, read/write Flights and Groups, Log, API Usage, About
│   ├── Diagnostics.js     Check setup (no API calls) and Test a flight lookup (one budgeted request)
│   ├── Menu.js            onOpen menu, triggers, cab-plan send, usage/sync/resume dialogs, Excel import
│   └── Util.js            IST/UTC helpers, flight-number normalisation, airline table, haversine
├── local-assistant/       Optional Telegram assistant worker (Node 18+, no dependencies; §14)
├── test/                  Node tests; real src in a vm sandbox, all external services faked
│   ├── run-tests.js       Core: normalisation, time, parsing, ETA, grouping, lifecycle, one runTick_ test
│   ├── adb-tests.js       AeroDataBox budget: limits, tiers, failures, dedupe, window, migration, D1–D5
│   ├── setup-tests.js     Secrets, redaction, config merge/migration, setup report, resume guard, hygiene
│   ├── dashboard-tests.js Dashboard data contract, read-only guarantee, personal-data minimisation, page layout
│   └── telegram-tests.js  Telegram delivery: success, token/chat errors, 429/5xx/timeout, retries, expiry, repeats,
│                          splitting, redaction, crash safety, Deliveries sheet store, diagnostics, email regressions
└── tools/
    └── doctor.js          `npm run doctor`: offline checks (files, manifest, file load order, secret names,
                           .gitignore, secrets scan) plus all test suites
```

Not in the repository, deliberately: `.clasp.json` (yours), `.env` (optional, personal), and the travel-details `.xlsx`, which contains personal data.

## 4. Current implementation status

**Implemented and tested** (locally, with fakes):
- Flight-number normalisation (IATA, ICAO, airline name) and IST/UTC handling.
- AeroDataBox and FlightAware response parsing, OpenSky ETA and landed detection.
- The full state machine, including UNKNOWN, retries and "not found" handling.
- The AeroDataBox gateway:
  - both limits and the hourly cap,
  - reservations and conservative accounting,
  - dedupe and cache,
  - rolling (33-day) and cycle windows,
  - fail-closed store validation and legacy migration,
  - sync and resume guards.
- Retention purge of provider data, and attribution on all messages.
- Cab grouping, change suppression and driver carry-over.
- Secret registry, secret status, redaction (including the two Telegram leak paths) and config merge/validation.
- The Config-sheet migration planner, the setup report logic and the lookup summary.
- `.gitignore` rules (checked with git by `npm run doctor`).
- The Overview dashboard's data contract (`buildDashboardData_`), its read-only behaviour and its page layout (§14). The page was also checked in a local browser preview with a stand-in for `google.script.run`.
- Telegram delivery (§14 "Telegram Bot Setup"), with every Telegram answer faked:
  - classification of 200/400/401/403/404/429/5xx/network/unreadable answers,
  - bounded retries, `retry_after`, expiry, the per-run time budget, stop-on-bad-token,
  - the repeat filter, splitting, redaction and chat-id validation,
  - the Deliveries sheet store (against a fake sheet), recovery after a run stopped mid-send,
  - "Check Telegram bot", "Show Telegram chat ids", "Send test alert" and the Check setup lines.

**Implemented, not verified in a real environment:**
- The dashboard web app: `doGet`, `getDashboardData` reading the bound sheet from a web-app request, `openDashboard`, and the page inside Apps Script's HtmlService frame.
- Everything that touches Google services: `setupSheets`, `readFlights`/`writeFlights`, `appendUsageRow_`, `purgeOldLogs_`, menus and dialogs, triggers, `collectSetupFacts_`, `runSetupCheck`, `testFlightLookup`, `importTravelDetails`, `importOpenFlightsAirlines`.
- The real `LockService.getDocumentLock()` in a time-driven trigger, and PropertiesService consistency between executions.
- Real AeroDataBox, OpenSky, FlightAware, Telegram and Gmail traffic. The response shapes come from the providers' documentation.
- The **Telegram Deliveries** sheet in a real spreadsheet: creation, the `@` text format keeping `-100…` ids exact, `insertRowsAfter`, and the purge.
- The clasp deployment path; clasp isn't installed in the build environment.

**Partially implemented:**
- **Departure rows** get only the T-6 h check. Later delays aren't followed.
- **First-leg connection check:** right-leg selection, bounded retries, overnight previous-date lookup and a visible "not checked" outcome are now implemented and tested with fakes (§14). It has not been verified against real multi-leg provider responses.
- **Seat capacity** is one size for every cab (`MAX_SEATS`).

**Not implemented:**
- The optional Gemini/Groq chat layer (spec: "optional"; messages use fixed templates). The dashboard has the assistant panel, but it answers nothing until a backend exists (hook in §14).
- Live ETAs for airports outside `AIRPORTS` (BLR, MAA, BOM, DEL, HYD, COK).
- WhatsApp, which is out of scope because it isn't free.
- CI. The repository has one commit (`2d88446`) and `origin` set to `github.com/shawntaran/flight-tracker-taran`. Its workflow is not written yet (task T8). At the 2026-10-21 refresh, 15 tracked files were modified and `local-assistant/README.md` was untracked; none of this is committed.

**Blocked by an external decision or dependency** (the five questions for Siva sir; the answers map to Config keys):
1. Who gets alerts, and on which channel?
2. Airports: BLR T1/T2 only?
3. Vehicles and seat counts?
4. Maximum wait in a shared cab?
5. Who maintains the sheet?

Also blocked on the provider: the attribution wording, whether this use counts as non-commercial, whether errors are billed, the 1,600-request cap, and your quota reset day.

## 5. Configuration and secrets

**Secrets** live in Apps Script → Project Settings → Script properties. They are read only through `secret()` (`src/Config.js`), which trims whitespace and refuses unregistered names. Values are never logged or shown; the setup check reports only status.

| Property | Required | Purpose | Used in |
|---|---|---|---|
| `ADB_KEY` | yes | RapidAPI key for AeroDataBox | `AdbClient.adbRequest` (via `env.secret`) |
| `TG_BOT_TOKEN` | yes | Telegram bot token (BotFather) | `Alerts.tgDeliver_`, `listTelegramChats`, `tgBotFacts_` (all via `tgEnv_().secret`) |
| `OPENSKY_CLIENT_ID` | optional (pair) | OpenSky OAuth2 client | `Providers.openskyToken_` |
| `OPENSKY_CLIENT_SECRET` | optional (pair) | OpenSky OAuth2 secret | `Providers.openskyToken_` |
| `FA_KEY` | optional | FlightAware AeroAPI backup | `Providers.faFetch`, `fetchFlightInfo` |

**Script state.** Also in Script Properties, but managed only by code:
- `ADB_USAGE_V1` and `ADB_USAGE_V1_INIT`: usage store and init marker.
- `OPENSKY_FAILS`.
- `ADB_UNITS_<YYYY-MM>`: the first version's counter, read once for migration.

**Script cache** (CacheService; best effort, may be evicted): `LOG_PURGED`; and for Telegram, `ALERT_REPEAT_V1` (the repeat filter: hashes only, never message text), `TG_PENDING` (`'0'` lets an empty flush skip reading the Deliveries sheet) and `TG_PURGED` (hourly purge gate).

**Tunable settings** live on the Config sheet, with defaults and notes in `DEFAULTS` (`src/Config.js`):
- Blank means use the default.
- An unreadable number keeps the default and is reported.
- Obsolete (`ADB_UNITS_PER_CALL`), unknown and over-plan values are reported by Check setup.
- "Set up sheets" adds missing keys and never changes existing values.

Groups of settings:
- **Cabs:** `GROUP_WINDOW_MIN`, `MAX_SEATS`, `ARRIVAL_BUFFER_MIN`, `CHECKIN_BEFORE_DEP_MIN`, `TRAVEL_TO_AIRPORT_MIN`.
- **Alerts:** `ETA_ALERT_THRESHOLD_MIN`, `NO_CONFIRM_AFTER_MIN`, `NOTIFY_FACULTY`, `COORD_TG_CHAT_IDS`, `COORD_EMAILS`, `EMAIL_ALERTS`.
- **Tracking:** `T_MINUS_CHECK_H`, `FIRST_CHECK_BEFORE_ARR_H`, `MIN_CONNECTION_MIN`, `MAX_ADB_CALLS_PER_FLIGHT`, `LIVE_WINDOW_NO_DEP_H`, `OPENSKY_STALE_MIN`, `LANDED_RADIUS_KM`, `APPROACH_MIN`, `HOME_AIRPORT`.
- **Budget:** `ADB_MONTHLY_UNITS` (400), `ADB_MONTHLY_REQUESTS` (1600), `ADB_MAX_REQUESTS_PER_HOUR` (1000), `ADB_WARN_PCT` (70,85,95), `ADB_BILLING_CYCLE_DAY` (blank = rolling), `ADB_MIN_INTERVAL_MS` (1100), `ADB_CACHE_MIN` (20), `ADB_RETENTION_HOURS` (156).

**Hard limits** live in code: `ADB_PLAN` in `src/AdbClient.js` (400 units, 1,600 requests, 1,000/hour). Config values above these are clamped.

**Manifest** (`src/appsscript.json`): the scopes are `spreadsheets.currentonly`, `script.external_request`, `script.scriptapp`, `script.send_mail` and `script.container.ui`. A `webapp` section (`executeAs: USER_DEPLOYING`, `access: MYSELF`) sets the dashboard's default deployment to owner-only. There are no secrets in it.

## 6. Setup and deployment

The full guide is in [README.md](README.md#setup-guide). In short:

```bash
npm run doctor
```

```bash
npm test
```

1. Create a Sheet, then Extensions → Apps Script (it must be bound).
2. Load `src/`. Either paste the files by hand, or:
   - copy `.clasp.json.example` to `.clasp.json` and paste the Script ID,
   - run `clasp login`,
   - run `clasp push`.
3. Add `TG_BOT_TOKEN` and `ADB_KEY` in Script properties.
4. In the sheet, run **1. Set up sheets**.
5. Fill `COORD_TG_CHAT_IDS` (from **Show Telegram chat ids**) and `COORD_EMAILS`.
6. Run **2. Check setup (no API calls)**.
7. Run **Send test alert**.
8. Run **Test a flight lookup** (2 units).
9. Import the flights, then **4. Start tracking**.

**Not verified:**
- clasp commands (written for the clasp 2.x CLI; clasp isn't installed here).
- Every in-sheet step above; they're untested against real Google services.
- With a webhook set on the bot, "Show Telegram chat ids" now explains Telegram's HTTP 409 instead of failing blankly (tested with a fake 409). The real 409 wording is unverified.

## 7. API contracts and limits

**Confirmed from provider documentation** (2026-10-20; sources in AUDIT.md):
- **Endpoint and cost:** the only AeroDataBox endpoint used is Flight Status (single day), `GET /flights/number/{flight}/{date}?withAircraftImage=false&withLocation=false&withFlightPlan=false&dateLocalRole=Arrival|Departure|Both`. It is **Tier 2 = 2 units**.
- **Other tiers:** range history = Tier 3, FIDS = Tier 2, fleet = Tier 3, `/health/*` = free. These are registered for validation only and are disabled.
- **Flight plans:** "may be billed x 2" when `withFlightPlan=true` and a plan is found. The app never sets it, and charges extra if a plan appears anyway.
- **Basic plan:** 400 units/month, 1 request/s plus 1,000/hour. Attribution required on free plans. Data retention 7 days, no permanent copies. No commercial use and no B2B sublicensing.
- **Reset timing:** unused units reset "at the end of each billing cycle".

**Taken from the task brief, not on the public pricing page:** the 1,600 requests/month cap.

**Assumptions needing confirmation:**
- Whether errors, 204 responses and timeouts are billed. The app assumes they are.
- That a billing cycle is at most 31 days.
- That a quota-exhausted 429 body contains "month" or "quota". If it doesn't, it's treated as a rate limit: a 1 h pause, then another try.
- The attribution wording.
- Whether university-internal use counts as non-commercial.

**How a request flows** (`adbRequest`):
1. **Validate:** endpoint registry, normalised flight number, date within ±365 days, `withFlightPlan` rejected.
2. **Dedupe:** per-run memo.
3. **Cache:** CacheService for `ADB_CACHE_MIN` (20 min, never above 6 h or retention).
4. **Reserve:** inside the **document lock**. Check units, requests and the hourly cap against the current window, charge the full cost, and add a pending entry.
5. **Send:** spaced at least 1.1 s from the previous request.
6. **Finalise once:** under the lock.
7. **Log:** a row on **API Usage**.

**How outcomes are accounted:**
- Every response and every timeout stays charged.
- A refund happens only for a request that certainly wasn't sent; no production path uses it.
- 401/403 suspend lookups until **Resume**.
- A 429 rate limit pauses lookups for 1 h.
- A 429 quota-exhausted response suspends lookups: until the next reset in cycle mode, or until a confirmed **Resume** in rolling mode.

**Accounting window** (`adbWindow_`). Usage is stored per IST day.
- **Blank `ADB_BILLING_CYCLE_DAY`:** rolling, today plus 32 previous days. This keeps every possible cycle of 31 days or less within the limit, even with up to 24 h of latency, skew or DST. The tradeoff is about 365 usable units per 30 days.
- **1–31:** a cycle starting at IST midnight on that day.

**Fails closed when:**
- the store can't be read, isn't valid JSON, or has the wrong shape;
- the store is missing after initialisation;
- a day is dated in the future;
- the cycle-day setting is invalid;
- the lock is busy for more than 10 s;
- the document lock is null.

**Sync and resume:** digits only, lowering needs confirmation, in-flight reservations are kept. Clearing a quota stop needs confirmation and is logged.

**Retention:** provider-derived row fields are purged after 156 h (capped at 168), and Log rows are purged on the same schedule. The API Usage sheet holds metadata only.

**Fallback behaviour:**
- **FlightAware:** once per flight/date per run, counted in the per-flight cap.
- **OpenSky:** keeps tracking when AeroDataBox is blocked.

**Capacity:**
- **Typical visit:** 4–6 units, about 60–90 visits a month in rolling mode, or 65–100 in cycle mode.
- **Worst case:** about 20 visits a month.
- **Request limit:** never binding with Tier-2 calls only (at most 200 requests).

**Other providers:**
- **OpenSky:** 4 credits per call; 4,000 credits/day with an account, 400 anonymously.
- **Telegram Bot API:** `sendMessage` (alerts); `getUpdates` (menu, no offset, so nothing is consumed); `getMe`, `getWebhookInfo`, `getChat` (menu "Check Telegram bot", read-only). Limits respected: about 1 message/s per chat, `retry_after` on 429, 4,096 characters per message. Updates are kept by Telegram for 24 h.
- **Gmail (MailApp):** 100 emails a day on consumer accounts.

## 8. Tests and verification

**Commands:**
```bash
npm test
```

```bash
npm run doctor
```

**Latest run** (2026-10-21, Node v25.8.1, Windows; `npm test` exit 0, `npm run doctor` no errors, no warnings):

| Suite | Result |
|---|---|
| `test/run-tests.js` | 57 passed, 0 failed (Flight Tracking: 9 first-leg tests, then 25 provider-hardening tests) |
| `local-assistant/test/assistant-tests.js` | 24 passed, 0 failed (in `npm test` and the doctor) |
| `test/adb-tests.js` | 49 passed, 0 failed |
| `test/setup-tests.js` | 20 passed, 0 failed (1 doctor-isolation test added by Flight Tracking) |
| `test/dashboard-tests.js` | 15 passed, 0 failed (new, UI Design) |
| `test/telegram-tests.js` | 34 passed, 0 failed (new, Telegram Bot Setup) |
| `test/flight-sort-tests.js` | 18 passed, 0 failed (in `npm test`; not run by the doctor) |
| `test/flight-position-tests.js` | 8 passed, 0 failed (in `npm test`; not run by the doctor) |
| `test/cab-suggestions-tests.js` | 7 passed, 0 failed (in `npm test`; not run by the doctor) |
| `npm run doctor` | 0 errors, 0 warnings (clasp 3.4.1 installed, `.clasp.json` present). 25 expected files, 5 suites. Latest run: 2026-10-20, after the Flight Tracking provider hardening |

**What the tests do establish:**
- The logic of every pure function listed in §4.
- The gateway's bookkeeping under sequential interleavings, a fake lock and fake properties.
- That failure paths fail closed.
- That no secret value appears in logs, alerts, errors or the setup report.
- That the app code can't read `process.env`.

**What is mocked, not tested against real services:**
- LockService (a boolean in one thread), PropertiesService, CacheService, UrlFetchApp, SpreadsheetApp, MailApp and ScriptApp.
- Every provider response; the bodies were written from the documentation.
- Real concurrency between executions.
- The real `adbEnv_()` wiring.
- Sheet.js and Menu.js functions, which are mostly stubbed.

## 9. Known bugs and technical debt

| Sev | Item | Consequence |
|---|---|---|
| High: verify live | `LockService.getDocumentLock()` in a time-driven trigger is unverified | If it returns null, every AeroDataBox lookup stays off (safe, but nothing works). Check setup reports it |
| High: verify live | PropertiesService read-after-write between executions is assumed | Concurrent executions could double-spend if writes aren't visible. Mitigated: ticks also hold the script lock |
| High: verify live | Real AeroDataBox response fields and 429 wording are unverified | Wrong parsing gives wrong statuses. A missed quota 429 means hourly re-tries |
| Medium | Sheet.js and Menu.js are mostly untested (setup, read/write, import, purge) | Bugs surface only on deployment. See task T3 |
| High: verify live | The dashboard web app reads the sheet with `SpreadsheetApp.getActive()` under the `spreadsheets.currentonly` scope. For a bound script that's expected to work (community sources), but it's unverified | If it returns null, the page loads and shows "Flights: …" errors instead of data. Fix: deploy once and open it |
| Medium | Dashboard runs as the deploying user. Widening `access` beyond `MYSELF` shows faculty names, flights and driver names to everyone allowed | Personal-data exposure. Keep `MYSELF`, or use `DOMAIN` on Workspace only after deciding who may see it |
| Low | The dashboard loads Tailwind from its CDN (pinned 3.4.16), which logs a "not for production" warning and needs internet access | Cosmetic warning. If the CDN is unreachable the page is unstyled; data is unaffected |
| Low | The flight table scrolls sideways inside its card below about 1,840 px window width (8 columns, as in the Stitch design; measured 1,024 px of content in a 760 px card at 1440 px) | The Cab and Action columns need a scroll on laptop screens |
| Medium | Usage restarts at 0 if both usage properties are deleted or the project is copied | Up to a full budget could be overspent. Sync from the dashboard after any such event |
| Medium | Rolling-mode safety assumes provider cycles of 31 days or less | A longer provider cycle would break the guarantee |
| Medium | Departure rows get only one check (T-6 h) | Later departure delays aren't announced |
| Medium: verify live | Identity matching relies on scheduled times in real AeroDataBox/FlightAware responses (tolerance 4 h, runner-up at least 1 h further) | A row whose Sched Arr/Dep is more than 4 h off the provider schedule (typo, airline retime, origin-local time entered) shows UNKNOWN with an "identity mismatch" message until corrected |
| Low | First-leg checks are limited to 2 requests and may not use a row's last call | A first leg that fails twice, or a row near its cap, gets "Connection not checked" instead of a verdict |
| Low | The hourly cap counts the IST clock hour; the provider may use a rolling hour | Unreachable at this volume |
| Low | The callsign guess (IATA→ICAO prefix) is used when AeroDataBox gives no icao24 or callsign | OpenSky may not find the aircraft; falls back to the airline ETA |
| Low | "Not found" and "2 failures" can send two alerts for the same flight, 3 h apart | Minor noise |
| Low | OpenSky `/states/all` without an icao24 filter downloads the whole world | Counts against the 90 min/day trigger runtime on consumer accounts |
| High: verify live | Real Telegram answers (error descriptions, 429 `retry_after`, 409 with a webhook) and the Deliveries sheet in a real spreadsheet are unverified | Misclassified errors could retry a permanent failure (bounded: 4 attempts, 120 min) or give up on a transient one. Email still goes out |
| Medium | Alert detection state is written (`writeFlights`) before `flush` sends. If the execution dies between them, that tick's alerts are lost; if `writeFlights` skips ("sheet changed during run"), the next tick re-detects and the repeat filter drops the duplicate | Rare lost alert. Ordering belongs to Tracker.js (Flight Tracking) |
| Medium | A network timeout can hide a delivered message; the one retry then duplicates it | At most one duplicate per message, documented in README. Then `UNCONFIRMED` |
| Medium | The repeat filter lives in CacheService | If evicted, one repeat can get through (e.g. a persistent error alerting again within 2 h) |
| Medium | Faculty with `NOTIFY_FACULTY` on, and drivers, receive "Cab plan changed" with every member's name and phone number (`Grouping.describeGroup`) | Faculty see each other's phone numbers. Template belongs to the cab-grouping owner; Telegram routing is unchanged |
| Low | Anyone with edit access to the sheet can add a Telegram recipient (Config, Groups, Flights) | That is the trust model: share edit access only with coordinators. Check setup and "Check Telegram bot" show every configured chat and flag groups and public chats |
| Low | A wrong coordinator chat id fails again for each new alert (one request each), until fixed | Visible as FAILED rows, in Log and in Check setup; no retry storm |
| Low | Telegram sending runs inside the tick's script lock (up to about 20 s, plus at most one 3 s wait) | Another menu action may wait. Moving sends outside the lock needs a Tracker.js change |
| Medium: known gap | Smart Cab Plan overrides live only in the preview browser's memory (`CabSuggestions.applyOverride`). `tick()`, the Groups tab, driver notifications and Telegram `/cabs` never see them, and a page reload drops them | A coordinator can see an AI-adjusted cab on the preview while drivers and the bot work from the rule-based plan. Design note in §14 "Override gap"; nothing implemented |

## 10. Decisions and rationale

Don't change these casually:
1. **A single AeroDataBox gateway** (`adbRequest`). Every limit, accounting rule, retention rule and log line is enforced in one place. Adding a direct `UrlFetchApp` call to AeroDataBox anywhere else defeats the budget.
2. **Charge first, refund only when certain.** The provider doesn't document billing for errors. Rejected alternative: count only successful responses, which undercounts.
3. **The rolling 33-day window is the default.** The reset day is unknown, and calendar-month resets were a silent assumption. Rejected alternatives: a calendar month (unsafe) and 32 days (zero margin; review finding D4).
4. **Fail closed** on any doubt about the usage store, config or lock. Rejected alternative: resetting to zero.
5. **Tier costs come from the provider's OpenAPI spec**, not from config (`ADB_UNITS_PER_CALL` was removed).
6. **OpenSky runs before AeroDataBox,** so a live fix can skip the takeoff check and save units.
7. **Secrets only in Script Properties,** read through the `SECRETS` registry. No `.env` loading, because Apps Script can't read it and tests must never see real keys.
8. **Setup never overwrites Config values.** It only appends missing keys and refreshes notes, so user settings survive upgrades.
9. **`.clasp.json` is git-ignored and `clasp create` is avoided.** The binding is per developer; `clasp create` can overwrite the manifest and makes a new project.
10. **Times are stored in UTC and shown in IST** (India has no DST). Cab grouping isn't split by date, so a 23:50 and a 00:10 arrival can share a cab.
11. **Attribution goes on every outgoing message,** because messages can carry provider-derived data.
12. **The status word is kept after the retention purge,** so a finished flight isn't polled again.
13. **Telegram delivery state lives on a "Telegram Deliveries" sheet** (owner decision, 2026-10-20), following the API Usage pattern: visible, auditable, and purged on the Log schedule. Rejected alternatives: a Script Properties queue (invisible, and message text with names in properties) and no persistence (alerts lost on a Telegram outage).
14. **A Telegram message is SENT only when Telegram answers `ok: true`.** An unknown outcome is retried once at most, then `UNCONFIRMED`. A duplicate is preferred over a lost alert, but only once.
15. **Plain-text Telegram messages** (no `parse_mode`), so names and provider text never need escaping and can't break the message.
16. **Only numeric chat ids; groups for coordinators only.** An `@username` addresses a public chat, and a personal message must not land in a group.

## 11. Work completed in this session

This conversation built the project, then audited and hardened it in passes.
- **Initial build:** `src/`, the core tests and the README.
- **Free-tier audit:** `AUDIT.md`, the gateway and `test/adb-tests.js`.
- **Billing-cycle window and hourly cap.**
- **Independent review:** fixes D1–D5.
- **This hardening pass.**
- **Later, Flight Tracking workstream:** first-leg leg selection. Files: `src/Tracker.js`, `src/Providers.js`, `test/run-tests.js`; details in §14.
- **Later, Flight Tracking workstream:** provider hardening: attempt accounting, flight identity, first-leg retries, terminal/gate freshness, parser resilience and the doctor `.gitignore` checker. Files: `src/Providers.js`, `src/Tracker.js`, `tools/doctor.js`, `test/run-tests.js`, `test/setup-tests.js`, `README.md` (2 troubleshooting rows); details in §14.
- **Later, Telegram Bot Setup workstream: local Telegram assistant** (`local-assistant/`). A separate Node.js worker answers coordinators' questions from the sheet, read-only, through any OpenAI-compatible model endpoint. Details in §14 "Local Telegram assistant".
- **Later, Telegram Bot Setup workstream:** delivery tracking, retries, the repeat filter, splitting, chat-id validation and Telegram diagnostics. Files: `src/Alerts.js`, small edits to `src/Diagnostics.js` and `src/Menu.js`, new `test/telegram-tests.js`, test-harness stubs in `test/run-tests.js`, `test/adb-tests.js` and `test/setup-tests.js`, one-line edits to `package.json` and `tools/doctor.js`, the README Telegram sections and this file. Details in §14.
- **Later, UI Design workstream:** Overview dashboard web app. New files: `src/Dashboard.js`, `src/DashboardPage.html`, `test/dashboard-tests.js`. One-line edits: `src/Menu.js`, `package.json`, `tools/doctor.js`. Also `src/appsscript.json` (`webapp` section), a README section and this file. Details in §14.

Files changed **in this hardening pass**:

| File | Change |
|---|---|
| `src/Config.js` | Configuration homes documented. `SECRETS` registry; `secret()` rejects unknown names and trims. `secretStatus_` (no values). `redactSecrets` / `redactionValues_`. `mergeConfig_` (validation, obsolete/unknown/over-plan reporting) and `planConfigSheet_` |
| `src/Alerts.js` | Telegram and email errors redacted. `listTelegramChats` uses `muteHttpExceptions` and token-free errors. Coordinator text redacted |
| `src/Sheet.js` | `logEvent` redacts. `setupSheets` migrates the Config sheet (adds missing keys, refreshes notes, never changes values) |
| `src/Tracker.js` | `tick()` error path redacts the log, the alert and the rethrown error |
| `src/AdbClient.js` | `adbResume(confirmQuota)`: a provider-reported quota stop needs confirmation; the override is logged on API Usage |
| `src/Menu.js` | New items "2. Check setup (no API calls)" and "Test a flight lookup"; renumbered. Resume dialog with quota confirmation |
| `src/Diagnostics.js` (new) | `collectSetupFacts_`, `setupReport_`, `renderSetupReport_`, `runSetupCheck`, `describeLookup_`, `testFlightLookup` |
| `tools/doctor.js` (new) | Offline repository checks (including the file load-order check, formerly task T9) plus all tests, with secret variables stripped from the environment |
| `test/setup-tests.js` (new) | 19 tests: secrets, redaction (Telegram leak paths, tick errors), config merge/migration, setup report, resume guard, hygiene, sandbox isolation |
| `package.json` | `test` runs 3 suites; `doctor` script; `engines` set to Node 18 or newer |
| `.gitignore` | Full rules: env files except the example, clasp files, credential files, real-data exports, logs, OS files |
| `.env.example`, `.clasp.json.example` (new) | Placeholders only |
| `README.md` | Rewritten as a step-by-step setup and operating guide, with a troubleshooting table |
| `AUDIT.md` | Hardening addendum S1–S3, C1–C2 |
| `PROJECT_STATUS.md` (new) | This file |

**2026-10-21 status refresh** (no code changes): re-ran `npm test` and `npm run doctor` and corrected the figures above. Corrected two statements: the repository has a remote and one commit (not "no commits or remote"), and the assistant suite has 24 tests (not 23). Added `local-assistant/` to the repository map. Nothing has been committed.

## 12. Remaining work and suggested task allocation

**Shared files that cause merge conflicts:** `src/Config.js` (DEFAULTS/SECRETS), `src/AdbClient.js`, `src/Tracker.js`, `README.md`, `PROJECT_STATUS.md`, `AUDIT.md` and `package.json`. Only one agent at a time should edit each of these. Every agent appends its own entry to §11 and updates §4 and §9; do that last, after rebasing on the latest version.

**Suggested order:**
- T1 and T2 first, in parallel. T1 needs a person with a Google account.
- T3 and T8 can run at any time, in parallel. (T9, the file load-order check, was done in this pass.)
- T5 after T1. T4 after Siva sir's answers. T6 last.

| ID | Title | Objective | Files | Depends on | Acceptance criteria | Tests | Risks | Must not change | Independent? |
|---|---|---|---|---|---|---|---|---|---|
| T1 | Live deployment verification | Deploy to a **test** spreadsheet and verify the §9 "verify live" items | none (report in PROJECT_STATUS §4/§9); fixes only if something fails | a person with a Google account and the two keys | Check setup is all ✅. Test alert received. One test lookup logged on API Usage with the right totals. The trigger runs and writes Log rows. A deliberate Telegram failure shows no token in Log | `npm test` stays green | Uses 2+ real AeroDataBox units; use a test sheet, not production | Gateway accounting rules | Needs a person. Coordinate with T2 on the 429 wording |
| T2 | Confirm provider facts | Settle the five "still to confirm" items (attribution, non-commercial, error billing, 1,600 cap, 429 body text) | `AUDIT.md`, README "still to confirm", `AdbClient.js` 429 regex only if needed | provider replies or docs | Each item marked confirmed (with source) or still open | Add a 429-body test if the regex changes | Don't weaken conservative accounting without written provider confirmation | Charge-first policy, 33-day default | Yes; only the 429 regex edit touches shared code |
| T3 | Sheet and Menu tests | Cover `setupSheets`, `readFlights`/`writeFlights`, `purgeOldLogs_`, `appendUsageRow_`, `importTravelDetails`, `combineDateTime_` with a fake SpreadsheetApp | new `test/sheet-tests.js`, `package.json` test script | none | New suite green. Any bug found is reported, or fixed with its own test | the new suite | A fake SpreadsheetApp can hide real API differences | src behaviour, unless fixing a proven bug | Yes (`package.json` is a one-line edit) |
| T4 | Per-vehicle seat sizes | Replace the single `MAX_SEATS` with a vehicle list once vehicles are known | `src/Grouping.js`, `src/Config.js` (DEFAULTS), README | Siva sir's answer on vehicles | Groups respect each vehicle's capacity; the existing grouping tests still pass | new grouping tests in `test/run-tests.js` | Notification churn when groups change | `applyGroups` change-suppression rules | Coordinate on `Config.js` |
| T5 | OpenSky and ETA field check | Compare `liveEta` with real flights; extend `AIRPORTS` if needed; filter by bounding box to cut runtime | `src/Providers.js`, `src/Config.js` (AIRPORTS) | T1 | ETA error recorded on 3+ real flights; runtime per tick measured | `run-tests.js` ETA tests updated | OpenSky credit use | AeroDataBox gateway | After T1; coordinate on `Config.js` |
| T6 | Optional chat layer | Gemini/Groq free-tier rewording of alerts, with templates as fallback | new `src/Chat.js`, `Alerts.js` hook, SECRETS entry | decision to do it; check the LLM provider's terms on data | Off by default; templates unchanged when off; no flight data sent without approval | new tests | Personal data sent to a third party | Existing templates | Coordinate on `Alerts.js` and `Config.js` |
| T7 | Departure follow-up checks | Optional second departure check (e.g. dep − 2 h) within budget | `src/Tracker.js` (`nextCheckTime`), README capacity figures | budget decision | Capacity figures recomputed; tests updated | `run-tests.js` lifecycle tests | Doubles departure cost | Arrival lifecycle | Coordinate on `Tracker.js` |
| T8 | CI | Run `npm run doctor` on each push | new `.github/workflows/ci.yml` | the owner settling which repository is canonical (§14) | CI green on main | — | The secret scan must keep printing hidden values only | doctor's no-network rule | Yes |

## 13. Instructions for the next agent

1. Read this file, then the README sections and the `AUDIT.md` rows that relate to your task.
2. Inspect the current working tree before editing. Other agents may have changed shared files (§12).
3. Verify claims in the code. This document can be stale.
4. Don't redo completed work (§4, §11). Don't weaken the gateway rules (§10) or the existing tests.
5. Run `npm test` before and after your change. Run `npm run doctor` before handing off. Never make real API calls from tests.
6. Never put secret values in code, docs, tests or the Config sheet. Build fake tokens from parts so the doctor's scan stays clean.
7. Update §4, §8 (with real results), §9 and §11 of this file when you finish.

## 14. Workstreams, ownership and shared interfaces

Three Claude Code sessions share this working folder. They are not in separate git worktrees, so one session's edits land directly on another's files. Before editing, look at the file's current state, not your memory of it.

| Workstream (session) | Owns (edits freely) | Must coordinate before editing |
|---|---|---|
| **Flight Tracking** | `src/Tracker.js`, `src/Providers.js`, `src/Util.js`; flight lifecycle and ETA tests in `test/run-tests.js`; tasks T5, T7 and the first-leg bug | `src/AdbClient.js`, `src/Sheet.js` (schema), `src/Config.js` |
| **Telegram Bot Setup** | `src/Alerts.js`, `test/telegram-tests.js`, the **Telegram Deliveries** sheet; Telegram parts of the README | `src/Config.js` (`SECRETS`), message wording produced in `Tracker.describeChange` and `Grouping.describeGroup` |
| **UI Design** | `src/Dashboard.js`, `src/DashboardPage.html`, `test/dashboard-tests.js`; the Overview dashboard, its theme, layout and the assistant panel (UI only) | everything listed under shared files below, plus `src/appsscript.json` and `tools/doctor.js` |

**Shared files** (one editor at a time; announce edits to the other sessions):
- `src/Config.js` (DEFAULTS, SECRETS)
- `src/Sheet.js` (COLS schema)
- `src/AdbClient.js` (quota gateway)
- `src/Menu.js`
- `package.json`
- `README.md`, `AUDIT.md`, `PROJECT_STATUS.md`
- `test/adb-tests.js`, `test/setup-tests.js`

**Interface contracts other workstreams rely on.** Changing any of these is an architectural decision: record it here and tell the other sessions.
1. **Flights sheet schema:** `COLS` in `src/Sheet.js`. Input, output and machine (`m:`) columns are positional, and `checkHeaders_` rejects reordering. A new column may only be a machine column appended at the end; `setupSheets` adds its header. Anything reading the sheet should go by header names.
2. **Statuses:** `SCHEDULED`, `DELAYED`, `DEPARTED`, `LANDED`, `CANCELLED`, `DIVERTED`, `UNKNOWN` (`Tracker.js`). UNKNOWN means "could not verify". Never show it as on time.
3. **Times:** machine columns store UTC ISO strings. Display columns (`ETA / Dep (IST)`, `Pickup (IST)`) are formatted by `fmtIST`. Coordinators enter times in IST.
4. **Outbox:** `out.coord(text)`, `out.direct(tgChatId, text, email[, role])`, `out.person(row, text)`, then `out.flush(C)` once per tick. Tracking decides *what* to say, in plain text; Alerts decides *how it's delivered*. The tracker never sees Telegram payloads.
   - Attribution is added by Alerts to every outgoing email and every Telegram part, so callers don't add it.
   - `direct()` defaults the role to `driver`; `person()` uses `faculty`. A personal chat id must be a positive number: a group id is refused and the person is emailed instead.
   - `notifyCoordinators_(text or [texts], C)` is the direct entry point for alerts outside a tick (`tick()`'s error path, the test alert). It applies the same repeat filter and delivery.
5. **Secrets:** read only through `secret(name)`. A new secret (for example a Telegram webhook secret) must be added to `SECRETS`, `.env.example` and the README in the same change, or the tests and doctor fail.
6. **AeroDataBox:** only through `adbRequest(spec)` (`AdbClient.js`). No other code may call AeroDataBox.
7. **Platform:** Google Apps Script plus Sheets. **Decided 2026-10-20 (owner, UI Design):** the dashboard is an HtmlService **web app in the same bound project** (`doGet`). It has no separate host, auth system or data store. Access is controlled by the web-app deployment (default owner-only, see §9).
8. **Dashboard data (`getDashboardData()` → JSON):**
   - **Read-only:** it reads through `readFlights()` + `prepareRow()` (on a copy), `readGroupsSheet()`, `adbUsageSummary()`, the last 8 Log rows and the `tick` trigger count. It writes nothing, sends nothing and spends no AeroDataBox units (tested).
   - **Contract:** `{generatedAt, homeAirport, maxSeats, attribution, flights[], groups[], log[], tickTriggers, usage|null, usageError, errors[], assistant:{enabled}}`. Times are ms numbers.
   - **Personal data:** flights carry names only; phone, email and Telegram ids are never sent to the browser.
   - **For other workstreams:** if you rename a status, a `COLS` key or a Groups column, update `buildDashboardData_` and its tests.
9. **Assistant hook (for T6):** the page calls a server function `askAssistant(question) → {text}` only when one exists (`assistant.enabled` is `typeof askAssistant === 'function'`). Until then it sends nothing anywhere.

**Local Telegram assistant** (2026-10-20, Telegram Bot Setup; verified locally with every external service faked):
- **What:** `local-assistant/`, a dependency-free Node.js 18+ worker run by the owner on their own machine (`npm run assistant`). It answers questions from `ALLOWED_CHAT_IDS` only. Automatic alerts stay in Apps Script and don't depend on it. Setup guide: [local-assistant/README.md](local-assistant/README.md).
- **Architecture:**
  - Telegram long-polling (`getUpdates` only; no webhook). The offset is saved *before* each update is handled, in `local-assistant/.state/telegram-offset.json`. First start skips the backlog.
  - Google Sheets is read with OAuth scope `spreadsheets.readonly`: GET `values/'Flights'|'Groups'|'Config'`, cached 60 s, reading columns **by header name**.
  - Sanitised snapshot → minimal per-question context → OpenAI-compatible `POST {LLM_BASE_URL}/chat/completions` (no tools) → output guard → plain-text reply.
  - The model is configured only by `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY`: local Ollama by default, or a LAN machine, a DGX, or a hosted server.
- **Safety:**
  - Allowlisted fields only: no phone, email, Telegram id, notes, Last Error, driver or vehicle.
  - The output guard rejects a flight not in the context, and a cab called booked/assigned/dispatched/confirmed.
  - Deterministic `/help`, `/flight`, `/delayed`, `/cabs` and `/status`, plus fallbacks when the model fails.
  - Rate limit 6/min per chat, 500-character questions, redaction of the bot token, model key, OAuth secret and Google tokens.
  - No conversation storage, and never exits on runtime errors.
  - Source-level test: no write call exists (no webhook methods, no Sheets write endpoints, no write scope).
- **Shared-file edits:**
  - `package.json`: scripts `assistant`, `assistant:auth`, `assistant:health`, `test:assistant`; the suite added to `test`.
  - `tools/doctor.js`: expected files, the suite, ignore checks for `.env.local-assistant` and `.state/`, `.state` skipped by the secrets scan, `*.example` files allowed as tracked.
  - `test/setup-tests.js`: the doctor's ignore counts are now 13/11.
  - `.gitignore`: `!.env.local-assistant.example`, `local-assistant/.state/`.
  - `src/Alerts.js`: the 409 text of "Show Telegram chat ids" now mentions the assistant.
  - README pointer and troubleshooting row.
- **Cross-workstream impact:** only one program may read a bot's updates. While the worker runs, "Show Telegram chat ids" sees nothing new and may get HTTP 409; the worker tells unknown private chats their own chat id instead. A separate bot token for the assistant avoids this entirely. The worker reads only the documented header names (`COLS` headers, Groups' first 7 headers, Config keys `HOME_AIRPORT` and `OPENSKY_STALE_MIN`): **renaming any of them breaks it**, so update `local-assistant/src/snapshot.js` with any rename.
- **Results:** 24 tests in `local-assistant/test/assistant-tests.js`. Mutation checks on a scratch copy confirmed the tests fail when the allowlist, offset saving, duplicate skipping, stale-position rule, cab guard, invented-flight guard, field allowlist or malformed-output check is broken.
- **Needs real verification:** Telegram long-polling and replies with a real bot; the OAuth consent flow and Sheets reads with real credentials (`FORMATTED_STRING` dates, the "Unable to parse range" wording for a missing tab); answer quality and rule-following of the chosen model; DGX reachability, TLS and API-key auth; behaviour when the worker and "Show Telegram chat ids" overlap.

**Telegram Bot Setup** (2026-10-20, verified locally with faked Telegram answers):
- **Defects found in the audit** (code as it was before this workstream):
  - T-1: no retry or delivery state. Detection baselines were saved before sending, so one failed send lost the alert.
  - T-2: every failure was the same `false`: no 429 `retry_after`, and a bad token was tried once per chat.
  - T-3: `text.slice(0, 4000)` cut long messages, including the required attribution.
  - T-4: `tick()`'s error alert had no dedupe: Telegram + email every 5 min, which exhausts Gmail's 100/day.
  - T-5: chat ids weren't validated (`@channel`, typos, group ids in personal cells).
  - T-6: "Send test alert" always said "sent".
  - T-7: "Show Telegram chat ids" didn't explain the 409 (webhook) and didn't show chat types.
  - T-8: no way to check the token without sending a message.
  - All fixed. Two need other owners: T-9 (phone numbers in cab messages to faculty, `Grouping.describeGroup`) and T-10 (templates can't say origin or delay versus schedule: no origin field; `Tracker.describeChange`).
- **Schema (new sheet, no other change):** **Telegram Deliveries**, created on first use by `tgSheetStore_()` (not by `setupSheets`). One row per Telegram message × recipient, in queue order. The column order is fixed by `TG_HEADERS` (`src/Alerts.js`):
  `Queued (IST)` | `Delivery ID` | `Role` | `Chat ID` | `State` | `Attempts` | `Last attempt (IST)` | `Delivered (IST)` | `Next attempt (IST)` | `Telegram message id` | `Error` | `Message`
  - Delivery ID: `T<yyyymmdd>-<hhmm>-<text hash>`, plus `.n` for split parts. The same text at the same time shares one id across recipients.
  - Role: `coordinator`, `driver`, `faculty` or `test`. States: `QUEUED`, `SENT`, `RETRY`, `FAILED`, `UNCONFIRMED`, `EXPIRED`.
  - Error is a token-free summary. Message is the redacted text as sent. Dates are Date cells; IDs are text (`@`).
  - Rows older than `ADB_RETENTION_HOURS` (max 168) are purged hourly. The token is never stored.
  - No Flights/COLS, Config or Script Properties change. No new secret or setting.
- **Files changed:**
  - `src/Alerts.js` (rewritten, same Outbox interface).
  - `src/Diagnostics.js`: chat-id validation, group warning and delivery summary in Check setup.
  - `src/Menu.js`: menu item "Check Telegram bot (sends nothing)"; `sendCabPlan` bypasses the repeat filter.
  - `test/telegram-tests.js` (new, 34 tests).
  - Test-harness stubs moved to the new delivery function, assertions unchanged: `test/run-tests.js` (`sendTelegram_` → `tgDeliver_`), `test/adb-tests.js` (captures real outgoing Telegram texts via `TG_ENV`), `test/setup-tests.js` (network-error test goes through `tgDeliver_`).
  - `package.json` and `tools/doctor.js` (suite added), `README.md` (Telegram steps 7, 10–12, "Telegram alerts: how delivery works", troubleshooting), this file.
- **Not touched:** `AdbClient.js`, `Tracker.js`, `Grouping.js`, `Sheet.js`, `Config.js`, `Providers.js`, `appsscript.json`, the dashboard files.
- **Mock-verified only.** Each claim has a test, and mutation checks on a scratch copy confirmed the tests fail when the retry cap, repeat filter, 401 handling, emoji-safe split, token redaction or group-id rule is broken.
- **Manual checks for T1** (deployed, on a test sheet):
  1. **Check Telegram bot** shows ✅ for the bot and each coordinator chat.
  2. **Send test alert** shows ✅ per chat, and the Deliveries sheet has `SENT` rows with message ids.
  3. Put a bad id (e.g. `1`) in `COORD_TG_CHAT_IDS`: the test alert shows ❌ "wrong chat id", there's one FAILED row, and the token appears nowhere in Log.
  4. Temporarily set a wrong `TG_BOT_TOKEN`: "TG_BOT_TOKEN rejected", only one request, and email still arrives.
  5. **Show Telegram chat ids** after a `/start`.
  6. A `-100…` group id stays exact in the Chat ID column.
- **For other workstreams:**
  - **UI Design:** the dashboard's "Telegram Dispatch" row says delivery errors are on the Log sheet. They are now also, in full, on **Telegram Deliveries**. `tgDeliverySummary_(rows, nowMs)` and `tgSheetStore_().read()` give the counts if the dashboard should show them (read-only).
  - **Flight Tracking:** wording in `describeChange` is free to change; delivery doesn't parse it. To dedupe by event rather than by identical text, pass an event key (an Outbox change; ask first). `runTick_` calls `writeFlights` before `flush`, so an execution that dies between the two loses that tick's alerts (§9). Swapping the order would risk a duplicate instead. That's Tracking's call.
  - **Grouping owner:** see T-9 above.

**UI Design: Overview dashboard** (2026-10-20, verified locally):
- **What:** the Stitch "Overview" design as `src/DashboardPage.html`, served by `doGet` (`src/Dashboard.js`). The new menu item **Open dashboard** shows the deployed URL, or how to deploy.
- **Stitch spacing bug fixed:** the export's `body pt-4` plus `top-4` on the fixed sidebar and header left a 16px band at the top that content scrolled through, and pushed the sidebar footer 16px below the viewport. Its `pt-16` also overrode the gap under the header. Now the sidebar and header sit at `top-0` and `main` uses `mt-16` + `py-space-md`.
  - Measured in a local preview at 1440×900: header 0–64 px, sidebar 0–900 px, first card at 76 px, header covering the top edge after scrolling.
  - At 375 px wide: no horizontal page scroll, sidebar hidden.
- **Theme:** light by default; dark via the header toggle, remembered per browser in `localStorage` (guarded).
  - Colours are the Stitch tokens as CSS variables with a dark set. The export's own toggle had no dark styles.
- **Kept but disabled:** design elements without data or a function stay visible and greyed out, with a "not available yet" tooltip:
  - the nav pages other than Overview, the date picker, the profile, "Filter Status", "All flights",
  - the row actions and Review/Force Check buttons,
  - the curbside map, "Avg wait", and the OpenSky and Telegram health rows,
  - route origin, aircraft and institute, shown as "—".
  - Showing origin/aircraft/institute would need new Flights columns: a schema decision for Flight Tracking.
- **Working:** the metric cards, flight table (search, direction tabs), attention list, Log activity, AeroDataBox budget bar, refresh button, a 5-minute auto-refresh and the AeroDataBox attribution.
- **Results:** `npm test` passed 32 (run-tests), 49 (adb), 19 (setup) and 15 (dashboard), with 0 failed. `npm run doctor`: 0 errors, 2 warnings (clasp, `.clasp.json`).
- **Not verified:** a real Apps Script deployment (see §9). That check belongs to T1: deploy, open the URL, and confirm the data matches the sheet.

**UI Design: Flights page, local preview only** (2026-10-20, verified in the preview browser):
- **What:** the Stitch "Flights" design in `tools/preview-app.html` (`#flights`): compact journey cards (route arc with aircraft, status, sched/est, cab line) that expand inline into the full infographic, telemetry, events (Log entries for that flight) and cab panel. Table view kept as the alternative view. Right-hand operations column: curbside staging per terminal, upcoming inbounds (next 4 h), Log activity. It sits below the cards under 1280 px.
- **Sorting/filtering:** `tools/flight-sort.js` (pure, no DOM). Arrivals are ordered by valid ETA, else schedule, else last. Departures and completed/cancelled/inactive rows are separate sections. Invalid times (0, NaN, display strings, ETAs over 36 h from schedule) are unknown, never "now". Filters: All, Arrivals, Departures, Airborne, Delayed, Landed, Cancelled (incl. diverted), Unknown. Search: flight (spaces ignored), name, origin, destination. Sort: soonest, latest, flight number. The sidebar uses the same functions.
- **Mock data:** `tools/mock-bridge.js` now has 14 synthetic flights (midnight crossing, invalid ETA, missing times, cancelled, inactive) and preview-only fields (`origin`, `destination`, `aircraft`, `depSchedAt`, `telemetry`, group `status`, `pickupAt`). The production contract has none of these, and the page hides what is missing. `data.preview` labels everything as mock. `__FT_PREVIEW__.setEta/shiftEta/resetEta` plus the "Simulate ETA change" button exercise reordering.
- **Also changed:** `tools/preview-server.js` (serves `/flight-sort.js`), Overview/Cab Groups in the preview use the same time rules, new `test/flight-sort-tests.js` (18 tests, in `npm test`, not yet in `tools/doctor.js`), `.claude/launch.json` (preview server).
- **Not done:** porting this page to `src/DashboardPage.html`. That needs the origin/destination/aircraft/departure-time fields from Flight Tracking (schema decision) and no telemetry or cab-status fields exist in production yet.

**UI Design: aircraft map, local preview prototype** (2026-10-20, verified in the preview browser; production not changed):
- **Finding:** production does not deliver coordinates. `openskyStates()` gets full state vectors once per tick (arrivals only, server side), but `liveEta()` reduces them to `{etaMs, distKm, fixMs}` and `applyLive()` stores only `etaAt`, `lastFixAt`, `status` and a text `etaSource`. No lat/lon, altitude, speed, heading or on-ground flag is kept. Origin airports are not stored, and `AIRPORTS` lists 6 Indian airports.
- **Proposed integration (needs Flight Tracking + Sheet owners' review before any `src/` change):**
  1. `liveEta`/`applyLive` keep `lat, lon, altFt, gsKts, headingDeg, onGround, fixAt` from the vector the tick already fetched (also for stale and on-ground-elsewhere fixes). Store them in machine columns appended at the end of `COLS`. No extra OpenSky calls.
  2. Persist the origin IATA (`depAirport` from `parseAdbLegs`/`parseFaFlights`), plus airport coordinates from AeroDataBox `airport.location` or a larger `AIRPORTS` table.
  3. `buildDashboardData_` adds `flights[].telemetry {lat, lon, altFt, gsKts, headingDeg, onGround, fixAt}`, `flights[].origin` and a top-level `airports` map, read-only, with tests. The browser only reads sheet data (no keys, no provider calls).
  4. Decision: map tiles are fetched by the coordinator's browser from tile.openstreetmap.org. That's keyless; light use is within the OSM tile policy with attribution. CARTO basemaps now return "API key required". Heavy use would need another provider.
- **Prototype:** `tools/flight-position.js` (pure rules: fresh ≤ 20 min = `OPENSKY_STALE_MIN`, stale up to 6 h, on ground, unavailable; never plots undated, future, out-of-range, (0,0), cancelled or schedule-only flights), `test/flight-position-tests.js` (8 tests, in `npm test`). In `tools/preview-app.html` (refactored the same day into **one shared map**): a single Leaflet 1.9.4 (cdnjs) map above the flight grid, created once and kept, whose layers are redrawn from the current filter/search on each render. There are no per-card maps and no separate map view. Marker colour = status (on time, delayed/cancelled, outbound, landed, unverified); ring = freshness (solid fresh, dashed/faded stale, square on ground). It fits on first show, on filter/search changes and via "Fit"; refreshes keep the coordinator's view. Clicking a marker selects the matching card or table row; the popup has "Show card" and "Expand card". Expanded cards have "Show on map". The map has an empty state, a "Not on the map" list and can be hidden (remembered per browser). Time-based journey progress is now labelled "est. from times" when there is no fresh position. Mock coordinates are labelled. `tools/mock-bridge.js` adds `airports` and fresh, stale and on-ground positions.

**UI Design: Cab Suggestions, local preview** (2026-10-20, verified in the preview browser; `src/` not changed):
- **Model:** the Cab Groups page is now **Cab Suggestions** (coordinator-only). It answers one question: which arriving people could reasonably share a cab? Suggestions come from the real `planGroups()`, read-only via the preview server's `/grouping-bundle.js` (`src/Util.js` + `Config.js` + `Grouping.js` wrapped in one function scope). They're adapted by `tools/cab-suggestions.js` (arrivals only; valid ETA, else schedule). They are computed in memory per refresh and never stored.
- **Page:** a "Suggestion only — arrange transport manually" note; a compact transport-changes list (cancelled, diverted, delayed, unverified, landed in the last 3 h) linking to the flight card; "Suggested Cab N" cards (pickup, terminal, passenger count, names, flights, status, ETA, reason); "Individual pickup suggested" cards with why; a "Not suggested" list (cancelled, diverted, inactive, no flight number, no time). No drivers, vehicles, assignment, claim or dispatch anywhere in the preview. The Flights card line, expanded cab panel, sidebar ("Pickup Suggestions"), Overview column and metric, and Settings use the same model. `#cab-groups` redirects.
- **Mock data:** fake vehicles, registrations and driver names removed; flights carry no `groupId`; two synthetic arrivals added so several suggestions appear. Driver wording removed from the log, notifications and assistant text.
- **Tests:** `test/cab-suggestions-tests.js` (7, in `npm test`) runs the real `planGroups` in a vm context.
- **Backend still assigns and notifies (for the Flight Tracking / Telegram owners to simplify separately; not changed here):** `carryDrivers()` and the Groups sheet vehicle/driver/driverTg columns; driver Telegram messages in `runTick_` (`src/Tracker.js`, `out.direct(...driverTg...)` for landed and "Cab plan changed"); `groupId`/`groupSig`/`notifiedPickupAt` persisted per row as if assigned; "New cab groups"/"Cab plan changed" coordinator messages and the `sendCabPlan` menu item word groups as plans; `describeGroup()` adds driver, vehicle and faculty phone numbers (T-9); departures are grouped too; `groupKeyTime()` uses `etaAt` without validity checks; `src/DashboardPage.html` still shows "Cab Groups" and "Driver …", and `buildDashboardData_` sends `vehicle`/`driver` (asserted in `test/dashboard-tests.js`). Status alerts (delayed, cancelled, diverted, airborne, landed, UNKNOWN) don't depend on any of this.

**Repository state** (verified 2026-10-20 12:30):
- `P:\Flight Tracker` is a git repository on branch `master` with **no commits and no remote**. Every project file is untracked.
- Inside it, `flight-tracker-taran/` is a **separate, empty clone** of `github.com/shawntaran/flight-tracker-taran`: branch `main`, no commits, no project files.
- Running `git add .` in the outer folder would stage that clone as an embedded repository (a gitlink), not as files.
- **Decision pending (owner):** which repository is canonical. Either point the outer repo's `origin` at the GitHub repo and delete the empty clone, or move the project files into the clone. Agents must not run `git add`, `commit` or `push`; the owner stages and commits by hand.

**Flight Tracking: provider hardening** (2026-10-20, verified locally with fakes; no live calls):
- **Attempt accounting.** `fetchFlightInfo(r, maxAttempts)` returns `attempts`, the number of external requests actually sent (AeroDataBox + FlightAware); it replaces the old `attempted` boolean.
  - Cache hits, in-execution dedupes, rejected and blocked requests count 0.
  - FlightAware is skipped when AeroDataBox used the row's last allowed attempt.
  - `runTick_` adds `attempts` to `adbCalls`, so a row stops exactly at `MAX_ADB_CALLS_PER_FLIGHT`.
  - The AeroDataBox quota gateway is unchanged.
- **Fallback context.** A FlightAware success is applied, but the row is marked degraded:
  - Last Error reads "AeroDataBox failed (<kind>); used FlightAware backup: …".
  - The `FALLBACK` flag is set, and ETA Source gets "[backup]".
  - Coordinators get one note, except for budget, suspension or rate-limit causes, which already have global alerts.
  - All of this clears when AeroDataBox succeeds again.
- **Flight identity.** `pickAdbLeg_` and `pickFaFlight_` (via `pickInstance_`) choose the instance whose scheduled time is closest to the row's Sched Arr (or Sched Dep). It must be within 4 h, and the runner-up must be at least 1 h further away. Otherwise the result is an identity mismatch:
  - status UNKNOWN,
  - Last Error "IDENTITY MISMATCH: …",
  - one "❓ … could not tell which flight is meant … Correct the date or Sched Arr/Dep" coordinator message,
  - nothing applied, and no paid FlightAware guess,
  - a re-check in 3 h.
- **First-leg policy.** At most 2 requests per row: the first try, then either one retry 30 min later for a transient failure (HTTP error, timeout, 429) or one previous-local-date lookup for overnight layovers (only when the connection airport is known).
  - Both count toward the row's cap, may not use its last call, and go through the gateway.
  - Terminal failures, exhausted requests, the cap, or the onward departure being under 60 min away all produce "⚠️ Connection not checked …".
  - A cancelled or diverted main flight finishes silently.
  - Progress is kept in the machine `flags` text as `FL<n>@<epochMin>@<conn>@<D|P>`.
  - `checkFirstLeg_(r, C, out, info, nowMs)` now runs for every row after the main checks.
- **Freshness.** A successful response without terminal or gate clears the provider values (Terminal (live), Gate). The coordinator's Terminal column is separate and untouched, and grouping falls back to it.
- **Resilience:**
  - FlightAware malformed or partial JSON, a non-list `flights`, null entries and invalid timestamps become a counted provider failure (`kind: 'parse'`) or null times, never a tick abort.
  - AeroDataBox null legs are skipped, and status spellings are normalised ("Cancelled", "En Route", "canceled uncertain").
  - OpenSky non-array state vectors are dropped; string or missing coordinates, timestamps or `on_ground` read as stale.
  - A cancellation never overrides an OpenSky airborne fix less than 30 min old.
- **Doctor `.gitignore` checker (real defect).** git exit 128 was read as "not ignored", and the throwaway repository inherited `GIT_DIR`/`GIT_WORK_TREE` and the global `core.excludesFile`.
  - Reproduced both ways: every rule reported missing, or "wrongly ignores package.json".
  - Now isolated (empty global config, no system config, repository-location variables stripped).
  - A git error reports "could not check", never false missing rules.
  - `DOCTOR_SKIP_TESTS=1` lets a test run the doctor without recursion.
- **Interfaces other workstreams should know:**
  - `fetchFlightInfo` returns `attempts`, not `attempted`.
  - The new coordinator messages are "could not tell which flight is meant" and "status taken from the FlightAware backup". The "Connection not checked" wording now ends "Check the connection manually, or fix the First Leg Flight column."
  - The `flags` column has new tokens `IDENTITY`, `FALLBACK` and `FL…`.
  - The status enum is unchanged (identity uses UNKNOWN).
- **Tests and results:**
  - 25 new tests in `test/run-tests.js`, plus 1 in `test/setup-tests.js`.
  - Each original defect was reintroduced in a scratch copy and caught by these tests (7 of 7 for the provider defects, plus the doctor checker).
  - `npm test`: 57, 49, 20, 15, 34, 18 and 8 passed, 0 failed (201 total).
  - `npm run doctor`: 0 errors, 0 warnings.
- **Needs real provider responses:**
  - how AeroDataBox and AeroAPI list same-number multi-instance and multi-leg flights,
  - whether terminal or gate are omitted or set to null when unknown,
  - real 5xx, timeout and 204 behaviour for first-leg lookups,
  - AeroAPI error-body shapes.

**Flight Tracking: first-leg fix** (2026-10-20, verified):
- **What changed:** `checkFirstLeg_` no longer takes `legs[0]`. The new pure function `selectFirstLeg_(legs, connAirport, onwardMs)` (`src/Tracker.js`) picks the leg arriving at the connection airport, i.e. the onward flight's departure airport.
  - Several legs arrive there: the latest arrival not after the onward departure; if every one arrives after it, the earliest.
  - Connection airport unknown: the same time rule over all legs.
  - It never falls back to an unrelated leg.
  - `CanceledUncertain` now counts as cancelled.
- **No schema change:** the connection airport comes from a new in-memory field, `depAirport`, on the provider `info` object (`parseAdbLegs`, `parseFaFlights` in `src/Providers.js`). `applyInfo` doesn't store it, so there are no new columns or properties.
- **New coordinator message**, sent when no leg matches: "⚠️ Connection not checked for <name>: first leg <flight> — <reason>. Check the First Leg Flight column." It goes through the Outbox as before. **Telegram workstream:** this is new wording; delivery is unchanged.
- **Interface:** `checkFirstLeg_(r, C, out, info)` takes the main flight's `info` as a fourth argument. Its only caller is `runTick_`.
- **Tests:** 9 new tests in `test/run-tests.js`. 3 of them fail when run against the old `legs[0]` logic (checked on a temporary copy of the tests, since deleted).
- **Results:** `npm test` passed 32, 49 and 19, with 0 failed. `npm run doctor`: 0 errors, 2 warnings (clasp, `.clasp.json`).

**Flight Tracking baseline** (this session, 2026-10-20, read-only, before the fix):
- No source changes.
- `npm test`: 23, 49 and 19 passed, 0 failed.
- `npm run doctor`: 0 errors.
- Candidate tasks (first-leg selection, first-leg failure notes and the overnight lookup are now done; see above):
  - T7 (departure follow-up check, needs a budget decision),
  - make the doctor run every suite listed in `npm test` (it skips `flight-sort-tests.js` and `flight-position-tests.js`); coordinate with UI Design,
  - T5 (OpenSky ETA check, needs a live deployment),
  - duplicate NOTFOUND/FAIL2 alerts.

**Override gap: Smart Cab Plan overrides are not persisted** (design note only, 2026-10-22; nothing implemented):
- **Today:** an override applied on the preview's Cab Suggestions page lives in that browser tab's memory (`CabSuggestions.applyOverride`). The tracker (`runTick_` → `planGroups`), the Groups tab, driver and faculty notifications, and the Telegram assistant's `/cabs` all use the rule-based plan only.
- **If overrides must reach drivers or the bot,** they need a persisted store that the tracker applies, for example an **Overrides** tab:
  - one row per override: group or member IDs, the pickup time, an expiry, and who applied it and when,
  - `runTick_` applies the unexpired rows after `planGroups()` and before `applyGroups()`, so the existing change-suppression and notification rules cover them,
  - a row whose flights no longer fit (the same check as `applyOverride`) is skipped and reported, never forced.
- **Writes go through Apps Script only** (a menu item or the owner-only web app). The local assistant and the local preview stay read-only (`spreadsheets.readonly`, GET only); they can show overrides but must never write them.
- This is a schema and architecture decision for the owner. The Smart Cab Plan code (`tools/smart-dispatch.js`, `CabSuggestions.applyOverride`, its UI and tests) is the owner's and was not changed.
