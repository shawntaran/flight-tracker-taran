# Local Telegram assistant

A small Node.js worker that answers coordinators' questions in Telegram, such as "When is Dr Sharma arriving?", "Who is delayed?" or "Which arrivals could share a cab?". It reads the tracker's Google Sheet, read-only, and uses a language model you choose to word the answer.

**It is optional.** The Apps Script tracker keeps sending every automatic alert (delay, cancellation, diversion, airborne, landed, UNKNOWN, connection risk) whether this worker runs or not. If the worker is stopped, only the conversational replies are unavailable.

## What it does and doesn't do

- **Polls Telegram** with `getUpdates`. It never sets a webhook and exposes no public URL.
- **Reads the sheet** with OAuth scope `spreadsheets.readonly`: the Flights, Groups and Config tabs, by header name. It cannot write to the sheet, and the code contains no write call (a test checks this).
- **Answers only chats listed in `ALLOWED_CHAT_IDS`.** Anyone else who writes privately is told their own chat id, and nothing else, at most once a day. Unknown groups get no reply.
- **Sends the model only what the question needs.** That's a few fields per flight: name, flight, direction, airport, status, times in IST, ETA source and age, a live position only if fresh, terminal/gate, and the cab suggestion. Phone numbers, emails, Telegram ids, notes, errors, drivers, vehicles and coordinator lists are never included.
- **Checks the model's answer before sending it.** An answer that names a flight not in the data, or calls a cab booked, assigned, dispatched or confirmed, is replaced by a deterministic answer. Cab groupings are always presented as suggestions.
- **Keeps working without the model.** `/help`, `/flight EK568` (or a surname), `/delayed`, `/cabs` and `/status` are deterministic. If the model is down, slow or returns garbage, flight-number and "who is delayed" questions still get a deterministic answer; broader questions get "temporarily unavailable".
- **Stores no conversations.** The log records only "answered chat X via llm/fallback in N ms". The only files it writes are its Telegram offset and the Google token, in `local-assistant/.state/` (git-ignored).
- **Limits:** 6 questions per chat per minute, 500 characters per question, and a reply notes when a message is older than 30 minutes ("I was offline").

## Setup

Run all commands from the repository root. You need Node.js 18 or newer; there are no npm dependencies.

### 1. Config file

Copy the example and fill it in. The copy is git-ignored; never commit it.

```bash
cp local-assistant/.env.local-assistant.example local-assistant/.env.local-assistant
```

### 2. Telegram bot token and allowed chats

- `TG_BOT_TOKEN`: the bot's token from @BotFather. Paste it only into this file.
- `ALLOWED_CHAT_IDS`: the coordinators' numeric chat ids, comma-separated. A group id starts with `-`; everyone in an allowed group can ask questions.
  - **Don't know the ids yet?** Leave it empty and start the worker (step 5). It runs in *setup mode*: it answers nobody, and replies to anyone who messages the bot privately with their chat id. Collect the ids, add them here, and restart.

**Only one program may read a bot's messages.** While this worker runs, the sheet menu **Show Telegram chat ids** can't list new chats (it may show HTTP 409). Instead, have the coordinator message the bot: the worker replies with their chat id and logs it. Sending alerts is unaffected, because the tracker only sends. You can also give the assistant its own bot (a second BotFather token) to keep the two completely apart.

### 3. Spreadsheet id and read-only Google access (one time)

1. `GOOGLE_SPREADSHEET_ID` is the part of the sheet's URL between `/d/` and `/edit`.
2. In Google Cloud Console:
   - Create (or pick) a project and enable the **Google Sheets API**.
   - Under **APIs & Services → OAuth consent screen**, configure it as Internal on Workspace, or External in testing mode with your account as a test user.
   - Under **Credentials → Create credentials → OAuth client ID**, choose type **Desktop app**.
   - Put its id and secret into `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
3. Authorise once:
   ```bash
   npm run assistant:auth
   ```
   Open the printed link, sign in with an account that can **view** the tracker sheet, and allow "See all your Google Sheets spreadsheets" (read-only). The token is saved to `local-assistant/.state/google-token.json`. To revoke it later: myaccount.google.com → Security → Third-party access, then delete that file.

### 4. Language model

Any server with an OpenAI-compatible `POST /v1/chat/completions` works. Only `LLM_BASE_URL`, `LLM_MODEL` and, when needed, `LLM_API_KEY` change between setups.

**On this machine (Ollama):**

```bash
ollama pull llama3.1:8b
```

Then set `LLM_BASE_URL=http://127.0.0.1:11434/v1`, `LLM_MODEL=llama3.1:8b`, and leave `LLM_API_KEY` empty. Ollama starts its server automatically after install; otherwise run `ollama serve`. Any instruction-tuned model you have pulled works; larger models follow the rules better.

**On another LAN machine:** start the server bound to the LAN address (Ollama: `OLLAMA_HOST=0.0.0.0`), and set `LLM_BASE_URL=http://<that-ip>:11434/v1`. Allow only the worker machine through that machine's firewall.

**On a university NVIDIA DGX** (vLLM, NVIDIA NIM, TGI or Ollama in OpenAI-compatible mode):

```
LLM_BASE_URL=https://dgx.your-university.example/v1
LLM_MODEL=<the exact model name the server lists>
LLM_API_KEY=<a key issued for this worker>
```

- Keep the endpoint inside the university network or VPN. Never expose an unauthenticated inference server to the internet.
- If the endpoint is reachable from beyond a trusted network, require an API key (vLLM `--api-key`, or a reverse proxy) and use https.
- The DGX only ever receives the minimal, sanitised context for one question. Telegram and Google credentials stay on the worker machine; never copy them to the DGX.
- The worker warns at startup if a non-private endpoint has no API key, or if a key would travel over plain http.

`LLM_TIMEOUT_MS` (default 30000) bounds each answer; a slow model gives a deterministic fallback, not a hang.

### 5. Health check, then start

```bash
npm run assistant:health
```

This prints the configuration with secrets shown only as "set". It checks that Telegram accepts the token (`getMe`; no message is sent), reads the Flights tab once, and shows the model endpoint host, model name, and reachable or unreachable. It never prints a token or key.

```bash
npm run assistant
```

Stop it with Ctrl+C. Run it under a process manager (systemd, pm2, Task Scheduler) to keep it up. It never exits on errors: Telegram, Sheet and model failures are logged and retried with back-off.

On first start it skips any messages sent to the bot before it was ever started, so old questions aren't answered. After that, the saved offset means a restart never answers a message twice. A message that arrives while it is stopped is answered on restart if it is less than 30 minutes old; otherwise the sender is asked to repeat it.

## When the worker is offline

| Still works | Unavailable |
|---|---|
| Every automatic alert from the Apps Script tracker (Telegram and email) | Answers to coordinators' questions |
| Tracking, cab planning, the dashboard, the sheet menus | `/help`, `/flight`, `/delayed`, `/cabs`, `/status` in Telegram |

## Tests

```bash
npm run test:assistant
```

The suite is fully mocked; it contacts no Telegram, Google or model server. It also runs as part of `npm test` and `npm run doctor`.
