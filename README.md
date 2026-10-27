# Faculty Flight Tracker (ITW 2026)

Tracks the flights of visiting faculty arriving at and leaving Bengaluru (BLR), and:

- alerts coordinators on Telegram when a flight is delayed, cancelled, diverted, airborne or has landed;
- shows every flight on a password-protected dashboard, with a live map of aircraft positions;
- suggests shared airport cabs, and re-plans them when flights change;
- answers coordinators' questions in Telegram ("Who is delayed?", "When does Dr Sharma land?").

It runs on free tiers: Supabase, one always-free Google Cloud VM, AeroDataBox Basic, adsb.lol and Telegram. The language model is your choice: OpenRouter, Gemini, or a server of your own.

| Document | What's in it |
|---|---|
| **This README** | How the system fits together, day-to-day operation, updating, troubleshooting |
| [deploy/README.md](deploy/README.md) | Setting up the Google Cloud VM from scratch |
| [engine/README.md](engine/README.md) | The tracking engine: Supabase tables, local runs, moving off Apps Script |
| [local-assistant/README.md](local-assistant/README.md) | The Telegram bot: allowed chats, Supabase read access, model servers |
| [docs/apps-script.md](docs/apps-script.md) | The original Google Sheets / Apps Script version |
| [PROJECT_STATUS.md](PROJECT_STATUS.md) | Architecture, design decisions, test coverage, known issues |
| [AUDIT.md](AUDIT.md) | The AeroDataBox free-tier audit |

## How it runs

```
                        ┌──────────────── Google Cloud VM (e2-micro) ────────────────┐
  AeroDataBox ─┐        │  cron, every 5 min:  node engine/run.js --scheduled          │
  adsb.lol ────┼──────► │  pm2:                dashboard  (tools/preview-server.js)    │ ──► Telegram alerts
  OpenSky ─────┘        │                      telegram-bot (local-assistant/)         │
                        │  Caddy:              HTTPS + password → dashboard            │ ◄── coordinators' browsers
                        └──────────────┬──────────────────────────────────────────────┘
                                       │ reads / writes
                                       ▼
                       Supabase: Flights · groups · config · status · tracker_state
```

| Part | What it does | Code |
|---|---|---|
| **Tracker** | Every 5 minutes: checks flights, writes statuses and ETAs to Supabase, re-plans cabs, sends alerts | `engine/` running the decision code in `src/` |
| **Dashboard** | The web page coordinators use: flights, map, cabs, API usage; add, edit and remove guests | `tools/preview-server.js`, `tools/preview-app.html` |
| **Telegram bot** | Answers coordinators' questions, read-only | `local-assistant/` |
| **Supabase** | All data. `Flights` holds one row per guest per direction (arrival, departure) | tables listed below |

The tracker, the dashboard and the bot are independent. If the bot or the language model is down, alerts and the dashboard keep working. If the dashboard is down, the tracker still runs. Only the tracker sends alerts.

### Where things live

| What | Where |
|---|---|
| Guests and their flights | Supabase `Flights`. Coordinator columns (name, flight, times, terminal) are yours; the tracker writes only its own columns (status, ETA, `m:` state) |
| Cab plan, settings, heartbeat | Supabase `groups`, `config` (blank or missing value = the default in `src/Config.js`), `status` |
| Tracker state: AeroDataBox usage, request log, live positions, run lock | Supabase `tracker_state` (service-role key only; created by [`engine/schema.sql`](engine/schema.sql)) |
| Tracker secrets: `SUPABASE_SERVICE_ROLE_KEY`, `ADB_KEY`, `TG_BOT_TOKEN`; optional `FA_KEY` (FlightAware backup), `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` | `.env.engine` on the VM ([template](.env.engine.example)) |
| Bot and model settings: `TG_BOT_TOKEN`, `ALLOWED_CHAT_IDS`, Supabase anon key, `LLM_*` / `GEMINI_*` | `local-assistant/.env.local-assistant` on the VM ([template](local-assistant/.env.local-assistant.example)) |
| Dashboard password | `/etc/caddy/Caddyfile` on the VM (user `coordinator`) |

The two env files are git-ignored and never leave the VM and your laptop. The `.example` templates are committed blank, and a pre-commit hook refuses a template with a key in it.

## What the tracker does every 5 minutes

1. **Live positions, free.** For every guest who is in the air or due to be, it asks **adsb.lol** for the aircraft: once by transponder id and once by callsign, which also finds the flight after a last-minute aircraft swap. If adsb.lol fails it tries **OpenSky**. OpenSky refuses connections from Google Cloud, so from the VM it's only a backup that rarely works.
   - A fresh position gives a live ETA: "live (ADS-B, 180 km out)".
   - Seen on the ground within 15 km of BLR: **LANDED**.
   - adsb.lol depends on volunteers' receivers. India's coast and Bangalore are covered well; the Arabian Sea and the Bay of Bengal hardly at all, so a long-haul flight usually appears in its last 1–2 hours.
2. **Scheduled status checks.** **AeroDataBox** is asked at set points (6 h before departure, at departure, after the ETA if the landing wasn't seen), within the monthly budget and a cap of 4 lookups per flight. FlightAware is the backup if `FA_KEY` is set.
3. **Guests on the same flight share it.** Their rows share the aircraft id and callsign; when one is landed, all are.
4. **Lost flights are closed.** A flight with no update 6 hours after it was due (`ASSUME_LANDED_AFTER_H`) is marked LANDED or DEPARTED with the ETA source "assumed … not confirmed". The dashboard tags it **! NOT CONFIRMED** and coordinators get an ℹ️ message asking them to check.
5. **Alerts.** A status change, or an ETA that moves 15 minutes or more, goes to the coordinators on Telegram. The landing message names the cab.
6. **Cabs.** Guests on the same direction and terminal within 45 minutes of each other share a cab, up to `MAX_SEATS` (default 4). Arrival pickup is the ETA + 40 min. Suggestions only: nothing is booked.
7. **Saving.** AeroDataBox usage first, then the changed flight rows, cab groups, heartbeat, and the positions last (so the dashboard never shows a new position next to an old status).

Dry run, same thing without writing (it still calls the flight APIs):
```bash
npm run tracker:dry-run
```

## The dashboard

`https://<your-vm-ip-with-dashes>.sslip.io`, user `coordinator`. It refreshes every 5 minutes, and at once when you come back to the tab.

| Page | What's there |
|---|---|
| **Overview** | Counts, next arrival, operations attention, **Tick Engine Activity** (what the tracker did and sent), guest list |
| **Flights** | One card per guest, grouped by section (inbound, departures, completed) and then by date. Filters: arrivals, departures, airborne, delayed, landed, cancelled, unknown. A filter shows the leg that matches, so a guest whose arrival landed still appears under **Landed**. The **map** shows each aircraft adsb.lol can see, with a dashed line to BLR |
| **Cab Suggestions** | The suggested cabs, with dates, and **Picked up** marks |
| **Notifications** | Not filled from Supabase yet (empty on the live dashboard); the Overview's Tick Engine Activity has the same messages |
| **API Usage** | AeroDataBox budget, live positions (adsb.lol), Telegram delivery, every recent request |
| **Settings** | The current settings (read-only; change them in the Supabase `config` table) |

**Actions:**
- **Add guest** (header): one flight per entry: name, flight number, direction, date and scheduled time in IST.
- **Edit** and **Remove** on each card.
- **Run Tracker Now** (sidebar): one run straight away instead of waiting for cron.
- **Flight Assistant**: questions about the flights, answered by the language model, or from the tracker data when the model is unavailable.
- **Smart Cab Plan**: the model suggests cabs. If it fails, you get the rule-based plan.

**Force check** (look one flight up now) is disabled in this dashboard; **Run Tracker Now** covers most needs.

Run it on your laptop against the real data:
```bash
npm run preview
```
It needs `local-assistant/.env.local-assistant`, plus `.env.engine` for the editing actions. Open `http://localhost:3000`; add `?mock=1` for sample data.

## Telegram

**Alerts** come from the tracker, to the chat ids in `COORD_TG_CHAT_IDS` (Supabase `config`). Each run's alerts go out as one message per chat. A temporary Telegram failure is retried on later runs (after 5, 10 and 20 minutes); a message not delivered within 2 hours is dropped as out of date. The same text to the same chat within 2 hours is sent only once, so a lasting problem alerts every 2 hours, not every 5 minutes.

**The bot** answers chats in `ALLOWED_CHAT_IDS` (in `local-assistant/.env.local-assistant`). Anyone else who writes privately is told their own chat id, which is how you find coordinators' ids.

| Command | Answer |
|---|---|
| `/flight EK568` (or a surname) | That flight's status, ETA and cab |
| `/delayed` | Every delayed flight |
| `/cabs` | The cab suggestions |
| `/status` | When the tracker last ran |
| `/help` | The list above |
| Any other question | Answered by the language model, from the tracker data only |

The commands work without the language model. If the model is down, flight and "who is delayed" questions are still answered from the data, and other questions get "temporarily unavailable".

## Language model

The bot, the dashboard's Flight Assistant and the Smart Cab Plan all use the model set in `local-assistant/.env.local-assistant`. Change it, then `pm2 restart all` and `npm run assistant:health`.

**OpenRouter** (many models, several free):
```
LLM_PROVIDER=
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=google/gemma-4-31b-it:free,nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-26b-a4b-it:free
LLM_API_KEY=<your OpenRouter key>
```
- **List several models,** comma-separated: the first is asked, and OpenRouter tries the next when one is rate-limited or down.
- **Use the model id** from the model's page (`google/gemma-4-31b-it:free`), not its URL. Pick general "instruct" models that support structured output (JSON); not embedding, coding-agent or speech models.
- **Privacy settings decide which free models work.** At openrouter.ai/settings/privacy, Zero Data Retention or a blocked "free endpoints that train on request data" makes free models answer **HTTP 404 "Provider returned error"** (the Eligibility Preview lists them as unavailable). Allowing training means the provider may keep what the bot sends: guest names, flights and times. If that's not acceptable, keep the restrictions and use a cheap paid model that supports Zero Data Retention.
- **Free limits:** HTTP 429 means rate-limited. An account without credit gets only a small daily allowance of free requests; $10 of credit raises it a lot.

**Gemini:** `LLM_PROVIDER=gemini`, `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-3.5-flash-lite`). The larger flash models are often "busy" (HTTP 503) on the free tier.

**Your own server** (Ollama, vLLM, a university DGX): `LLM_PROVIDER=` blank, and set `LLM_BASE_URL`, `LLM_MODEL` and, if needed, `LLM_API_KEY`. See [local-assistant/README.md](local-assistant/README.md).

Only one provider is active at a time. In `.env.local-assistant` the **last** line for a setting wins, so a block appended at the end overrides the lines above it.

## Day to day

**Adding guests:**
- One at a time: **Add guest** on the dashboard.
- The whole list, from the Google Forms "Form Responses" export (.xlsx). On your laptop, with `.env.engine`:
  ```bash
  npm run import:guests -- "C:\path\to\responses.xlsx"
  ```
  That's a dry run: it lists every guest it would add or change, and every cell it couldn't read, and writes nothing. Check it, then write it:
  ```bash
  npm run import:guests -- "C:\path\to\responses.xlsx" --apply
  ```
  It matches people by name, never deletes, and never blanks a value with an empty cell. Guests in Supabase but missing from the file keep being tracked; the report lists them.

**Checking that everything runs** (on the VM):

| Command | Shows |
|---|---|
| `pm2 status` | The dashboard and the bot are `online` |
| `journalctl -t flight-tracker -n 50` | The last tracker runs |
| `npm run assistant:health` | Telegram, Supabase and the language model, without sending anything |
| `pm2 logs --nostream --lines 50` | The dashboard's and the bot's recent output |
| `npm run tracker:usage` | AeroDataBox usage in the current window |

The dashboard header says "Tracker last ran HH:MM IST (N min ago)". A red banner means more than 15 minutes, or the last run failed.

## Updating the VM

Push from your laptop (`P:\Flight Tracker`):
```bash
git push origin main
```
Then on the VM:
```bash
cd ~/flight-tracker && git pull && pm2 restart all
```
- The tracker needs no restart: cron starts a fresh run every 5 minutes.
- After `git pull`, `git log --oneline -1` shows the commit the VM is running.
- If `package.json` changed, run `npm ci --omit=dev` before the restart.
- Edit a settings file on the VM with `nano`, for example `nano ~/flight-tracker/local-assistant/.env.local-assistant` (save `Ctrl+O`, `Enter`; exit `Ctrl+X`; paste with right-click). Then `pm2 restart all`.

## Free tiers and their limits

| Service | Limit | When it runs out |
|---|---|---|
| **AeroDataBox** Basic | 400 units and 1,600 requests per billing cycle; 2 units per lookup; 1 request/s | Live positions keep working; flights due a check show **UNKNOWN** with an alert, never "on time" |
| **adsb.lol** | Free, no key. Requires a User-Agent with contact details (the tracker sends one); data under the ODbL licence, credited on the map | — |
| **OpenSky** | Blocks Google Cloud addresses | Backup only |
| **OpenRouter** free models | Per-minute and per-day request limits | The bot and dashboard answer from the tracker data |
| **Gemini** free tier | Per-minute limits; flash models often busy | Same |
| **Google Cloud** e2-micro | Always free in us-central1, us-west1, us-east1; the public IP may cost a little | — |

AeroDataBox terms: non-commercial use, attribution on every alert (added automatically), and provider data deleted after 156 hours. See [AUDIT.md](AUDIT.md).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Red banner "The tracker has not run for …" | First click the refresh button (a tab left in the background showed old data before this was fixed). If it stays: `journalctl -t flight-tracker -n 50` on the VM, and `crontab -l` to check the cron line |
| A flight has no position, map empty | adsb.lol can't see the aircraft yet (over the sea, or not departed). It appears near the coast. API Usage → Live positions shows whether the calls themselves work |
| Activity shows `adsb.lol: HTTP 403` | The VM runs code older than the User-Agent fix: update the VM |
| `OpenSky: UND_ERR_CONNECT_TIMEOUT` | Expected from Google Cloud; only shown when adsb.lol also failed |
| Bot replies "language model is temporarily unavailable" | `pm2 logs --nostream --lines 50 \| grep "via fallback"` shows the model's error. **429**: rate-limited. **404 "Provider returned error"**: OpenRouter privacy settings (above). **401**: wrong `LLM_API_KEY`. **503**: Gemini busy |
| Health check: model "a,b,c" not in the server's model list | The VM runs code older than model lists: update the VM |
| A flight stuck "airborne" long after its ETA | Six hours after the ETA it's closed as "! NOT CONFIRMED". Or **Edit** it on the dashboard |
| Two guests on one flight show different statuses | The next run aligns them (rows on the same flight share their landing) |
| A landed guest is missing under **Landed** | Their card shows the next leg; the Landed filter finds them since the "leg that matches" change. Update the VM |
| `cd: … .env.local-assistant: Not a directory` or `Permission denied` | It's a file: open it with `nano <path>` |
| `npm error Missing script` | Two commands pasted onto one line; run them separately |
| Telegram 409 "another program is reading this bot's messages" | Only one copy of the bot may run: stop the one on your laptop |
| Dashboard asks for a password and refuses it | The password is the one hashed into `/etc/caddy/Caddyfile`; make a new hash with `caddy hash-password` and `sudo systemctl reload caddy` |

## Development

```bash
npm test
```
```bash
npm run doctor
```
- `npm test` runs every test suite. Every external service (Supabase, AeroDataBox, adsb.lol, OpenSky, Telegram, the language models) is faked: no test makes a network call or needs a key.
- `npm run doctor` also checks the repository: files, the env templates, `.gitignore`, and that no credentials are committed.
- **Shared decision code:** the tracker logic in `src/` is the Apps Script code, run unchanged by the Node engine in a sandbox (`engine/core.js`). Changing a rule there changes both versions.
- **Branches:** work on a branch, fast-forward `main`, and push to GitHub yourself; the VM pulls from `main`.
- Structure and where to start: [PROJECT_STATUS.md](PROJECT_STATUS.md).
