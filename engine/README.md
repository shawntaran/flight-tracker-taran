# Tracking engine (Node.js + Supabase, on Vercel, run by GitHub Actions)

The 5-minute tracker without Google: it reads the `Flights` table in Supabase, checks flights with OpenSky, AeroDataBox and (optionally) FlightAware, writes the results back to `Flights`, re-plans the cab groups, sends Telegram alerts and updates the heartbeat in the `status` table.

## How it is built

- **Same decisions as the Apps Script tracker.** `engine/core.js` loads the decision code from `src/` unchanged (`Tracker.js`, `Providers.js`, `AdbClient.js`, `Grouping.js`, `Alerts.js`, `Config.js`, `Util.js`, and the column schema from `Sheet.js`). It's the same code the existing tests cover, so the two versions can't drift while both exist.
- **No Google services.** The code runs in an isolated sandbox where `SpreadsheetApp`, `ScriptApp`, `MailApp` and the rest don't exist: touching one throws (a test checks this). The five utility calls the decision code makes have Node implementations:
  - `UrlFetchApp.fetch`: Node `fetch` in a worker thread (`engine/sync-fetch.js`)
  - `PropertiesService` and `CacheService`: the `tracker_state` table
  - `LockService`: a lease lock in `tracker_state`
  - `Utilities.sleep`: a blocking Node sleep
- **Supabase I/O happens only before and after the decision code** (`engine/supabase-store.js`). The run loads everything, decides, then saves. Saving writes, in this order:
  - AeroDataBox usage accounting first
  - only the changed engine columns of each `Flights` row (`UPDATE … WHERE "ID" = …`; coordinator columns such as Name, Phone or Flight are never written)
  - the cab plan in `groups`, when it changed
  - the heartbeat rows in `status`

## Setup

1. **Create the state table.** In the Supabase SQL editor, run [`schema.sql`](schema.sql) once. It creates `tracker_state` with row-level security on and no policies, so only the service-role key can use it.
2. **Get the service-role key.** In Supabase, open Project Settings → API. The engine needs it to write. It stays server side: in Vercel env vars or a local `.env.engine`, never in the browser, the preview, or `local-assistant/.env.local-assistant`.
3. **Run locally first.** Copy `.env.engine.example` to `.env.engine` and fill it in. Then:
   ```bash
   npm run tracker:dry-run
   ```
   A dry run reads Supabase and calls the flight APIs, but writes nothing back. A real run is `npm run tracker:run`.

## Moving off Apps Script (do these in order)

1. **Stop the Apps Script trigger** (sheet menu "Stop tracking"). If both run, every flight is looked up twice (AeroDataBox budget) and every alert is sent twice.
2. **Copy the AeroDataBox usage in.** The engine's counter starts at zero, while this month's usage so far is in Apps Script's Script Properties. Take the figures from the RapidAPI dashboard and run:
   ```bash
   node engine/run.js --set-usage <units> <requests>
   ```
   Then `npm run tracker:usage` shows what the engine counts.
3. **Copy the latest data over.** The Apps Script tracker kept writing to the sheet after your Supabase import. Re-import the Flights tab if it has changed since.
4. **Deploy to Vercel** (below).

## Vercel

- `vercel.json` sets the `/api/cron` function to run for up to 60 s and to ship `src/` and `engine/` with it. It has no cron schedule: Vercel's Hobby plan allows only daily crons.
- Environment variables (Project Settings → Environment Variables):
  - required: `CRON_SECRET` (any long random string), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADB_KEY`, `TG_BOT_TOKEN`
  - optional: `FA_KEY`, `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`

  Every call must send `Authorization: Bearer <CRON_SECRET>`; any other caller gets HTTP 401.

## Schedule (GitHub Actions)

[`.github/workflows/tracker-cron.yml`](../.github/workflows/tracker-cron.yml) POSTs to `/api/cron` every 5 minutes.

1. In the workflow, replace `YOUR_VERCEL_DOMAIN` with the live domain (for example `flight-tracker.vercel.app`).
2. In the GitHub repository, go to Settings → Secrets and variables → Actions → New repository secret. Add `CRON_SECRET` with the same value as in Vercel.
3. Commit and push to the default branch: GitHub only runs schedules from there. The Actions tab has a **Run workflow** button for a manual run.

What to expect from GitHub's scheduler:
- Under load, runs can start several minutes late, and occasionally one is skipped.
- On a public repository, GitHub pauses schedules after 60 days without a commit, and you re-enable them in the Actions tab.
- Each run takes one short job (about 10 s of a free-tier runner).

The heartbeat in `status` shows whether runs are arriving.
- Nothing from the repository is served publicly. The static output is the one-line `public/index.html`.

## Not carried over (yet)

- **Email alerts:** there's no mail service in Node. Coordinator alerts go by Telegram only, and each skipped email is logged.
- **The Log and API Usage tabs:** those lines go to the platform log (Vercel → Logs) instead.
- **The Airlines tab:** only the built-in airline list is used to read flight numbers.
- **Sheet menu actions** (Force check, Send cab plan, Resume AeroDataBox) aren't wired to the engine. `--set-usage` covers the usage sync.
