# Faculty Flight Tracker

A Google Sheet with a bound Apps Script that:
- watches visiting faculty flights,
- alerts coordinators on Telegram and Gmail when a flight is delayed, cancelled, airborne or has landed,
- groups airport cabs, and re-plans them when flights change.

It runs on free tiers: AeroDataBox Basic, OpenSky, Telegram, Gmail and Apps Script.

- **This README:** getting it running and operating it.
- **[PROJECT_STATUS.md](PROJECT_STATUS.md):** architecture, design decisions, test coverage, known issues and open tasks.
- **[AUDIT.md](AUDIT.md):** the AeroDataBox free-tier audit.

> **Status:** the code is tested locally with all external services faked. It has **not yet been run in a real Apps Script project or against the live APIs**. The first live run is the verification step in the guide below (steps 12–15).

## Where things live

| What | Where | Who sets it |
|---|---|---|
| Secrets: Telegram token, RapidAPI key, optional OpenSky/FlightAware keys | Apps Script → **Project Settings → Script properties** | You, by hand (step 6) |
| Tunable settings: cab window, seats, alert thresholds, coordinator chat ids/emails, budget options | The **Config** sheet. A blank value means "use the default". Defaults are in `src/Config.js` | You, in the sheet |
| Plan hard limits: 400 units, 1,600 requests, 1,000 requests/hour | `ADB_PLAN` in `src/AdbClient.js`. Config values can only be lower | Code |
| Usage counters and suspension state | Script properties `ADB_USAGE_V1*` | The script. Don't edit them |
| Faculty flights, cab groups, logs | **Flights**, **Groups**, **Log** and **API Usage** sheets | You (Flights) and the script |
| Every Telegram message and its delivery state | **Telegram Deliveries** sheet, created on the first message | The script. Read it; don't edit it |
| When the tracker last ran, whether that run worked, and whether its trigger is installed | **Status** sheet (the heartbeat), created by **1. Set up sheets** | The script, on every run. Read it; don't edit it |

Secrets never go in code, in the sheet, in the manifest, or in git. `.env.example` only lists the secret names; Apps Script does not read `.env` files.

## Setup guide

Each step is marked 🖐 if you do it by hand, or ⚙️ if it's automated or a single command.

### Prepare your computer (only needed to run tests or deploy with clasp)

1. 🖐 **Install** [Node.js 18+](https://nodejs.org) and git. Install clasp too if you'll deploy from the command line:
   ```bash
   npm install -g @google/clasp
   ```
2. ⚙️ **Install dependencies:** there are none. The tests use only Node's built-in modules.
3. ⚙️ **Check the repository** and run all tests (offline, no API calls):
   ```bash
   npm run doctor
   ```
   It checks the files, manifest, secret names, `.env.example`, the `.gitignore` rules and that no credentials are in the repository, then runs every test suite. It never makes a network call.

### Create the spreadsheet and script

4. 🖐 **Create a Google Sheet,** then open **Extensions → Apps Script** from inside it. The script must be *bound* to the sheet: the usage counter relies on the sheet's document lock, and without it AeroDataBox lookups stay off.
5. **Load the code.** Choose one way:
   - 🖐 **By hand:**
     - In the Apps Script editor, go to Project Settings and tick **Show "appsscript.json" manifest file in editor**.
     - Replace the manifest's contents with `src/appsscript.json`.
     - Create one script file per `src/*.js` file, with the same name, and paste each file's contents in.
   - ⚙️ **With clasp:**
     1. Turn on the Apps Script API at https://script.google.com/home/usersettings.
     2. Copy the **Script ID** from Apps Script → Project Settings.
     3. Run these commands:
        ```bash
        cp .clasp.json.example .clasp.json
        ```
        Edit `.clasp.json` and paste the Script ID in place of the placeholder. Then:
        ```bash
        clasp login
        ```
        ```bash
        clasp push
        ```
     4. If clasp asks whether to overwrite the manifest, answer **yes**.

     Don't use `clasp create`: it makes a new project and can overwrite `src/appsscript.json`. `.clasp.json` is git-ignored on purpose, because it points at *your* project; each developer makes their own from the example.
6. 🖐 **Add the secrets.** In Apps Script, go to **Project Settings → Script properties → Add script property**, enter the exact name and paste the value, then **Save**. Paste values without spaces.

   | Property | Needed | How to get it |
   |---|---|---|
   | `TG_BOT_TOKEN` | **Required** | Step 7 |
   | `ADB_KEY` | **Required** | Step 8 |
   | `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` | Optional, set both or neither | opensky-network.org → Account → API client. Without them OpenSky is used anonymously, limited to 400 credits/day |
   | `FA_KEY` | Optional | flightaware.com/aeroapi → Personal plan. Used only as a backup when AeroDataBox fails or is out of budget |

7. 🖐 **Telegram bot.**
   1. In Telegram, open **@BotFather** (check for the blue verified tick), send `/newbot`, and choose a display name and a username ending in `bot`.
   2. BotFather replies with a token shaped like `digits:letters`. Copy it straight into the `TG_BOT_TOKEN` script property (step 6). Never paste it into the sheet, a chat, an email, the code or git.
   3. Optional: send `/setjoingroups` → **Disable** to BotFather after adding the bot to any coordinator group, so nobody else can add it to theirs.
   4. If the token ever leaks, send `/revoke` to BotFather, then replace the property value with the new token. Nothing else changes: chat ids stay the same.

   This bot only sends messages. It doesn't set a webhook and it doesn't poll. If you reuse a bot that another program already serves through a webhook, alerts still work, but **Show Telegram chat ids** can't read its messages (see Troubleshooting).
8. 🖐 **AeroDataBox key.**
   1. Open https://rapid.aerodatabox.com, sign in to RapidAPI, and subscribe to the **Basic (free)** plan.
   2. Copy the **X-RapidAPI-Key**, shown in the code snippets on any endpoint page. Put it into the `ADB_KEY` property.
   3. On your RapidAPI dashboard, note the day your quota resets; it's needed for `ADB_BILLING_CYCLE_DAY` later.

### Initialise and verify

9. ⚙️ **Set up the sheets.** Reload the spreadsheet, then choose **Flight Tracker → 1. Set up sheets**. Apps Script asks for permission the first time.

   This creates or updates the Flights, Config, Groups, Log, API Usage, Status and About sheets, and sets the timezone to Asia/Kolkata. On the Config sheet it adds any settings the sheet lacks and refreshes the notes, but **it never changes a value you set**.
10. 🖐 **Coordinators.**
    1. Each coordinator opens the bot in Telegram (search for its username) and sends `/start`. A bot can't message anyone who hasn't done this, and it can't look people up: they must write to it first. For a group chat, add the bot to the group and send `/start@YourBotName`.
    2. Within 24 hours (Telegram keeps these messages only that long), run **Show Telegram chat ids**. It lists each chat's id, type and name, and marks the ones that are already coordinators. Reading the list doesn't use up or change anything.
    3. Copy each coordinator's id into `COORD_TG_CHAT_IDS` on the Config sheet, separated by commas. Prefer **private** chats (positive ids).
       - A **group** id starts with `-`. Every member of that group receives faculty names, flights and cab plans, and Check setup warns about it.
       - `@usernames` and anything that isn't a number are refused, so a public channel can't be configured by accident.
    4. Put email addresses into `COORD_EMAILS`.

    **Who receives what.** Only the chat ids on the Config sheet receive coordinator alerts, so anyone who can edit the sheet controls the list: share edit access only with coordinators. Drivers get messages only if their private chat id is on the **Groups** sheet. Faculty get messages only if `NOTIFY_FACULTY` is on and their private chat id (or email) is on **Flights**. A group id in a driver or faculty cell is refused, and the person is emailed instead if they have an address. The script never adds a recipient by itself.
11. ⚙️ **Check the setup:** run **Flight Tracker → 2. Check setup (no API calls)**. It reports:
    - missing or odd-looking secrets (never their values),
    - Config problems,
    - missing coordinators,
    - sheet headers and timezone,
    - whether the document lock and Script Properties work,
    - trigger state, AeroDataBox usage, and recent Telegram delivery problems.

    It sends nothing to any external API. Fix every ❌ line before going on.

    Then run **Check Telegram bot (sends nothing)**. It tells apart a missing token, a rejected token and a network problem, says whether a webhook is set, and checks every coordinator chat id with Telegram (private chat, group or public) **without sending a message**.
12. ⚙️ **Send a test alert** with **Send test alert**. It shows what happened for each recipient: ✅ delivered, ⏳ will retry, or ❌ with the reason. Each coordinator should get it on Telegram and by email. Every Telegram attempt is recorded on the **Telegram Deliveries** sheet, with tokens masked.
13. ⚙️ **Test a flight lookup** with **Test a flight lookup (uses 2 AeroDataBox units)**.
    1. Enter a real flight and date, e.g. `EK568 2026-10-21`.
    2. It shows your current usage and asks before sending.
    3. The request goes through the same budgeted gateway as tracking, and appears on **API Usage**.

    This is the only setup step that uses quota.
14. 🖐 **Add flights.** Add a tab named `Import`, paste the travel-details spreadsheet into it with headers in row 1, and run **3. Import from "Import" tab**. Or type rows straight into **Flights** (see below).

    **Changes after the first import.** The tracker reads only the **Flights** tab. Editing the Import tab changes nothing until you run **3. Import from "Import" tab** again (or make the same edit on Flights directly). A re-import:
    - adds people and flights that are new;
    - lists every changed scheduled time or terminal on rows already in Flights, for example "Row F12 Dr X arrival: Sched Arr 2026-10-25 04:50 → 06:10", and asks before writing them. It writes only your green columns; the tracker then re-checks those rows. A blank or unreadable Import value never blanks a Flights cell;
    - lists a probable flight-number change ("Possible flight change: Dr Y arrival EK568 (row F7, active) vs EK566 in Import"). It adds the new flight but never deactivates the old one: untick **Active** on the old row yourself;
    - ends with a count of rows added, updated, unchanged and possible flight changes.
15. ⚙️ **Start tracking** with **4. Start tracking (every 5 min)**. **Stop tracking** removes the trigger.

    Run **Check setup** again: it should show one trigger. Then watch:
    - **Status:** `LAST_TICK_AT` should move every 5 minutes and `LAST_TICK_RESULT` read `ok`. The dashboard, the local preview and the Telegram assistant warn when it is more than 15 minutes old, failed, or the trigger is missing,
    - **Log:** every check and alert,
    - **API Usage:** every AeroDataBox request, with running totals,
    - **Show API usage:** the current window.

### Checking flights on demand

- **Run a check now** runs the tracker once, exactly like the 5-minute trigger: only rows that are *due* are looked up (for example at T-6 h). It then reports what it did: "Check finished at 14:05 IST: 2 provider lookups due, 2 requests made, 1 row updated, 1 alert sent." "0 due" is normal between checkpoints.
- **Force check a flight now (uses AeroDataBox units)** looks chosen rows up immediately, even if they are not due:
  1. Enter one or more row IDs from the Flights **ID** column, comma-separated (`F12, F15`).
  2. Confirm: the dialog shows the rows, the estimated AeroDataBox units (2 per lookup; 0 if a recent answer is cached) and each row's remaining per-flight calls (`MAX_ADB_CALLS_PER_FLIGHT`, default 4).
  3. A summary shows each row's result and its new status and time.

  Forced lookups use the same budget, cache and per-flight cap as tracking. A row at its cap, already finished (landed, departed, cancelled, diverted), inactive or with an unreadable flight number is refused without a request.
- If another check is running, both items say **"A check is already running; try again in a minute."** Nothing is queued or skipped silently.

### Dashboard (optional)

The Overview dashboard is a read-only web page that shows flights, cab groups, alerts, recent Log rows and AeroDataBox usage. It never calls a flight API, sends a message or changes the sheet.

1. 🖐 In Apps Script, choose **Deploy → New deployment**, pick type **Web app**, then:
   - **Execute as:** Me.
   - **Who has access:** Only myself (the default in `src/appsscript.json`).
   - Choose **Deploy** and approve.
2. ⚙️ In the sheet, **Flight Tracker → Open dashboard** shows the link.
   - After a code change, choose **Deploy → Manage deployments → Edit → New version**, or the link keeps serving the old code.
3. **Sharing:** the page runs as you, so anyone you give access to sees faculty names, flights and drivers. Widen access only on purpose, for example **Anyone within your domain** on Workspace.
4. **Theme:** light by default; the moon icon switches to dark, and the choice is remembered in that browser.
5. **Freshness:** under the title, "Tracker last ran HH:MM IST (N min ago)" comes from the **Status** sheet. A red banner appears when that is more than 15 minutes ago, the last run failed, or the trigger isn't installed.
6. **Force check:** each active flight has a **Force check** button. It shows the same confirmation as the menu item and uses the same lock and budget. This is the dashboard's only action that calls a provider, and only after you confirm.

The Flight Assistant panel isn't connected to any AI service yet, so it sends nothing anywhere.

### Flights sheet

Green columns are yours. Blue columns are written by the script. Hidden `m:` columns are its state, so don't insert or reorder columns.

- **Direction:** Arrival (into BLR) or Departure (out of BLR).
- **Flight:** any of `EK 568`, `ek-0568`, `UAE568` or `Emirates 568`. All become `EK568`.
- **Sched Arr (IST):** required for arrivals.
- **Sched Dep (IST):** required for departures, optional for arrivals. Filling it saves an AeroDataBox call. Always enter times in IST.
- **First Leg Flight:** optional, for connections. One check warns if the first leg lands less than 60 min before the onward flight.
- **Active:** untick to stop tracking a row. Editing a row's flight or times resets its tracking state.
- **Personal data:** keep it to name, phone, email/Telegram id and flight. No passport details.

**Cabs:** people on the same direction, airport and terminal share a cab when they're within `GROUP_WINDOW_MIN` (45 min) of the first person, up to `MAX_SEATS`. Arrival pickup is the last ETA + 40 min. Departure pickup is the earliest check-in − 90 min. A driver typed on **Groups** follows their group when it's re-planned.

## Asking questions in Telegram (optional local assistant)

[`local-assistant/`](local-assistant/README.md) is a separate Node.js worker. It answers coordinators' questions in Telegram ("Who is delayed?", "Where is EK568 right now?") from the sheet, read-only, using a language model you choose: local Ollama, a LAN machine, or a university DGX. It runs on a computer you control, not in Apps Script.

- If it stops, every automatic alert still goes out; only the question answering pauses.
- `/status` shows when the tracker last ran. If that is more than 15 minutes ago, failed, or there is no **Status** sheet, every answer ends with a note such as "Note: the tracker hasn't updated since 14:05 IST; times may be stale."
- Setup, the DGX notes and the health check are in [local-assistant/README.md](local-assistant/README.md).

## Local preview dashboard (optional)

`npm run preview` serves a richer copy of the dashboard on `http://localhost:3000`. It reads the tracker data from Supabase with the local assistant's anon key (`SUPABASE_URL`, `SUPABASE_ANON_KEY`), so set up `local-assistant/` first.

- **Same data as the Telegram assistant.** By default (`PREVIEW_SOURCE=flights` in `local-assistant/.env.local-assistant`) it reads the Supabase `flights` table (plus `groups`, `config` and `status` tables if they exist): live statuses, ETAs, cab groups and the heartbeat. The header shows the source: "Data: Supabase · flights table (tracked) · Tracker last ran …".
- **Import fallback.** If the `flights` table is empty or holds the Import tab's columns rather than the tracker's, the preview shows those schedules instead and says so in a banner: "flights table empty or without the tracker's columns: showing Import-column schedules only, no live status". `PREVIEW_SOURCE=import` always reads the Import columns (schedules only, every status SCHEDULED).
- **Refresh.** The page refreshes itself every 5 minutes from a 1-minute server cache. The refresh buttons read the sheet again at once (at most once every 5 seconds).
- **Read-only.** The preview can't force a check or change anything: its **Force check** button is disabled. Use the sheet menu or the deployed dashboard.
- `?mock=1` shows built-in sample data without touching the sheet.

## Telegram alerts: how delivery works

- **One message per tick.** All coordinator alerts from one 5-minute check are combined into one Telegram message per chat, plus one email. Drivers and faculty get their own messages.
- **Plain text.** Messages are sent without Markdown/HTML formatting, so names and symbols arrive exactly as typed. Each message ends with the AeroDataBox attribution line.
- **Long messages are split, never cut.** Anything over Telegram's 4,096-character limit is split at paragraph breaks into numbered parts, `(1/2)`, `(2/2)`, each with the attribution.
- **Repeats are suppressed.** A text identical to one in the same recipient's previous alert from the last 120 minutes isn't sent again. A persistent error therefore alerts about every 2 hours, not every 5 minutes. A real change back (plan A → B → A) is still sent. **Send current cab plan** and **Send test alert** always send.
- **Delivery record.** Each message × recipient is a row on **Telegram Deliveries**: queued time, delivery id, role, chat id, state, attempts, last attempt, delivered time, Telegram's message id, a token-free error, and the text. Rows older than `ADB_RETENTION_HOURS` (156 h) are deleted, like Log rows.

| State | Meaning | Retried? |
|---|---|---|
| `SENT` | Telegram confirmed delivery | — |
| `RETRY` | Temporary problem: rate limit (429), Telegram server error (5xx), or a network error | Yes, next ticks: after 5, then 10, then 20 min; 4 attempts in all |
| `FAILED` | Permanent for that chat (wrong id, bot blocked, never `/start`ed, rejected message), the token is missing or rejected, or 4 attempts failed | No |
| `UNCONFIRMED` | Telegram may have delivered it, but didn't confirm (two network errors, or an unreadable answer) | No, to avoid a duplicate |
| `EXPIRED` | Not delivered within 120 min; old flight news would mislead | No |

- **Rate limits.** The script sends at most about one message per second to the same chat. If Telegram answers 429 with `retry_after` of 3 s or less, it waits once and resends. A longer `retry_after` is respected by waiting for a later tick, never by holding up the 5-minute check. Telegram work is capped at about 20 s per run; anything left goes out next tick.
- **A bad token stops sending at once**, rather than failing once per chat. Fix `TG_BOT_TOKEN`, then use **Check Telegram bot**.
- **Possible duplicates.** If a request times out, Telegram may have delivered the message anyway. It's retried once, so a coordinator can occasionally see the same alert twice. After that it's marked `UNCONFIRMED` and not retried.
- **Email** has no delivery receipt and isn't retried. If Gmail refuses a message, that appears on **Log**. Email is the backup channel if Telegram is down.

## AeroDataBox free tier: what you need to know

- **Limits:** 400 API units and 1,600 requests per billing cycle, 1 request/second, and 1,000/hour. The only endpoint used, Flight Status, costs **2 units**. The script never sends a request that would exceed a limit.
- **Accounting window:**
  - **Default (blank `ADB_BILLING_CYCLE_DAY`):** a safe rolling 33-day window, correct whatever your reset day is. It allows about 365 units per 30 days.
  - **Set to the dashboard's reset day (1–31):** counting resets on that day instead, giving the full 400. A sheet from an earlier version may still say `1`; Check setup warns about that.
- **When the budget runs out:** OpenSky keeps tracking airborne flights, FlightAware is used if configured, and flights due a check show **UNKNOWN** with an alert. They are never shown as on time.
- **Capacity:** about 60–90 visits a month (one arrival plus one departure each) in rolling mode, or 65–100 with the reset day set. In the worst case, with failures and missing departure times, it's about 20.
- **Sync usage from RapidAPI dashboard:**
  - Whole numbers only; a blank answer changes nothing.
  - Lowering the local count asks for a second confirmation.
  - Requests still in flight are kept.
- **Resume AeroDataBox:** clears a bad-key or rate-limit stop. Clearing a stop that AeroDataBox itself reported ("quota used up") needs an extra confirmation, and the override is recorded on API Usage.
- **Terms:** non-commercial use only, attribution required (added to every message and the About sheet), and provider data deleted after 156 h (the limit is 7 days).
- **Still to confirm:** the attribution wording, whether a university's internal use counts as non-commercial, and whether error responses are billed. See [AUDIT.md](AUDIT.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| No **Flight Tracker** menu | Reload the sheet. The script must be opened from this sheet's Extensions menu (bound) |
| Banner "The tracker has not run for …" / Telegram note "the tracker hasn't updated since …" | The trigger stopped or keeps failing. Read `LAST_TICK_ERROR` on **Status** and the **Log**; run **Check setup**, then **4. Start tracking** if the trigger is missing. "No heartbeat" means **1. Set up sheets** and a first run haven't happened yet |
| Local preview says "showing Import-column schedules only" | The Supabase `flights` table is empty (row-level security with no SELECT policy for anon looks the same) or lacks the tracker's columns. Or check `PREVIEW_SOURCE` in `local-assistant/.env.local-assistant` |
| "Authorization required" | Run any menu item and approve. The scopes are in `src/appsscript.json` |
| Check setup: ❌ Document lock | The script is standalone, not bound. Recreate it from the sheet (step 4) |
| Check setup: ❌ `ADB_KEY` / `TG_BOT_TOKEN` | Add the property with the exact name (step 6). ⚠️ "spaces" or "does not look like" means re-paste the value |
| Telegram "TG_BOT_TOKEN rejected" (HTTP 401/404) | Token wrong or revoked. Paste the current token from @BotFather into `TG_BOT_TOKEN`, then run **Check Telegram bot** |
| Telegram "TG_BOT_TOKEN is not set" | Add the `TG_BOT_TOKEN` script property (step 6). Email alerts still go out meanwhile |
| Telegram "HTTP 403 … blocked the bot or never sent it /start" | That person must open the bot and send `/start` (or unblock it). For a group, re-add the bot |
| Telegram "HTTP 400 … wrong chat id" | Fix the id on Config / Groups / Flights using **Show Telegram chat ids**. **Check Telegram bot** tests every coordinator id without sending |
| Telegram "the group became a supergroup; its new chat id is …" | Replace the old id with the new one shown |
| Many `RETRY` / `EXPIRED` rows on Telegram Deliveries | Telegram was unreachable or rate-limited. They retry by themselves; email covered the alerts. Check the Log for the reason |
| `UNCONFIRMED` rows | A network error hid the outcome. Check with the recipient; the script won't resend, to avoid duplicates |
| "Telegram Deliveries sheet unavailable" (ERROR in Log) | The sheet is protected or was broken. Messages still go out once, but without retries. Remove the protection or delete the sheet (it's recreated) |
| "Show Telegram chat ids" says no messages | Ask people to send `/start` first. In groups, send `/start@YourBotName`. Telegram keeps these for 24 h only, so run it soon after |
| "Show Telegram chat ids": "Another program is reading this bot's messages" (HTTP 409), or an empty list while the local assistant runs | The [local assistant](local-assistant/README.md) or a webhook reads the bot's messages. Alerts still work. With the assistant, have the person message the bot: it replies with their chat id. Otherwise ask the webhook's owner, or use a separate bot. Don't delete someone else's webhook |
| The same alert arrived twice | A timeout hid a successful delivery and the one retry resent it (state `UNCONFIRMED` or `SENT` with 2 attempts). Expected, and rare |
| No emails | Check `COORD_EMAILS` and `EMAIL_ALERTS`. Consumer Gmail allows 100 emails a day |
| Flight shows **UNKNOWN**, "lookup not performed" | AeroDataBox is out of budget or suspended. Run **Show API usage** |
| Flight shows **UNKNOWN**, "IDENTITY MISMATCH" / "could not tell which flight is meant" | The provider lists this flight number at times that don't match the row (or twice, about equally close). Check the date and that Sched Arr/Dep is in **IST**, then correct the row. Nothing was guessed |
| "Connection not checked" | The first-leg check couldn't give a verdict (lookup failed twice, flight not found on either date, or the request cap was reached). Check the connection by hand |
| "AeroDataBox HTTP 401/403" | Key wrong or not subscribed. Fix `ADB_KEY`, then **Resume AeroDataBox** |
| "usage store unavailable" | Lookups stopped deliberately (fail closed). Use **Sync usage from RapidAPI dashboard** with the dashboard figures |
| "Flights sheet column N should be …" | A column was inserted or moved. Undo it; put notes in the Notes column |
| Times off by hours | Run **Set up sheets** (sets the timezone to Asia/Kolkata) and enter times in IST |
| `clasp push`: "User has not enabled the Apps Script API" | Turn it on at https://script.google.com/home/usersettings |

## Development

```bash
npm test
```

```bash
npm run doctor
```

- **`npm test`** runs every suite under `test/`, plus the local assistant's (`local-assistant/test/`). Every external service is faked.
- **`npm run doctor`** adds the repository checks.
- **Isolation:** every external service is faked, and the application code runs in a sandbox with no access to environment variables, so a key on your machine can never trigger a real request.
- **Structure and where to start:** see [PROJECT_STATUS.md](PROJECT_STATUS.md).
