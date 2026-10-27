# Running the platform on Google Cloud (one small VM)

One always-free Compute Engine VM runs everything:

| What | How it runs on the VM |
|---|---|
| Dashboard (`tools/preview-server.js`) | pm2 keeps it running on `localhost:3000`; Caddy serves it over HTTPS with a password |
| Telegram bot (`local-assistant/`) | pm2 keeps it running |
| Tracker (`engine/run.js`) | cron, every 5 minutes |
| Data | Supabase (unchanged) |
| Language model | Hosted: OpenRouter or Gemini, set in `local-assistant/.env.local-assistant` (see the main [README](../README.md#language-model)) |

This replaces Vercel and cron-job.org. Commands marked **(laptop)** run in PowerShell on your PC; **(VM)** run in the VM's SSH window.

## 1. Create the VM

Google Cloud Console → **Compute Engine → VM instances → Create instance**:

- **Region:** `us-central1`, `us-west1` or `us-east1`. Only these get the always-free e2-micro.
- **Machine type:** `e2-micro`.
- **Boot disk:** Debian 12, **Standard persistent disk**, 30 GB.
- **Firewall:** tick **Allow HTTP traffic** and **Allow HTTPS traffic**.
- Create it, then note its **External IP** (e.g. `34.123.45.67`).

Make the IP permanent: **VPC network → IP addresses**, find it, **Reserve** (promote to static). Otherwise it can change after a restart.

Cost: the e2-micro and its disk are in the free tier. Google may charge a few dollars a month for the public IPv4 address; check **Billing** after the first days.

## 2. Install Node.js, pm2 and Caddy (VM)

Click **SSH** next to the VM in the console, then:

```bash
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
sudo npm install -g pm2
```

The swap file is there because the e2-micro has only 1 GB of memory.

## 3. Get the code onto the VM

Either:
- **From GitHub**, after you have pushed `main`. On the VM: `git clone https://github.com/shawntaran/flight-tracker-taran.git ~/flight-tracker` (a private repository needs a GitHub token or deploy key).
- **Or copy it from the laptop** without pushing. **(laptop)** Install the Google Cloud CLI, then from `P:\Flight Tracker`:
  ```powershell
  gcloud compute scp --recurse --zone YOUR_ZONE engine api src tools local-assistant deploy public package.json package-lock.json YOUR_VM_NAME:~/flight-tracker/
  ```

Then **(VM)**:
```bash
cd ~/flight-tracker && npm ci --omit=dev
```

## 4. Copy the two settings files (laptop)

They hold your keys, so they never go through git:

```powershell
gcloud compute scp --zone YOUR_ZONE "P:\Flight Tracker\.env.engine" YOUR_VM_NAME:~/flight-tracker/.env.engine
gcloud compute scp --zone YOUR_ZONE "P:\Flight Tracker\local-assistant\.env.local-assistant" YOUR_VM_NAME:~/flight-tracker/local-assistant/.env.local-assistant
```

Then **(VM)**: `chmod 600 ~/flight-tracker/.env.engine ~/flight-tracker/local-assistant/.env.local-assistant`

## 5. Start the dashboard and the bot (VM)

**Stop the bot on your laptop first.** Telegram lets only one program read a bot's messages.

```bash
cd ~/flight-tracker
npm run assistant:health
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup        # prints one sudo command: run it, so both start again after a reboot
```

`pm2 status` shows them; `pm2 logs` shows their output.

## 6. HTTPS and a password for the dashboard (VM)

```bash
caddy hash-password          # type the password coordinators will use; copy the hash it prints
sudo cp ~/flight-tracker/deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
```

In the file, replace:
- `YOUR_HOSTNAME` with your IP using dashes plus `.sslip.io`, e.g. `34-123-45-67.sslip.io`. That's a free name pointing at your IP, and no domain is needed. Your own domain works too, once its DNS points at the IP.
- `PASSWORD_HASH` with the hash.

Save (Ctrl+O, Enter, Ctrl+X), then `sudo systemctl reload caddy`. Open `https://34-123-45-67.sslip.io` and sign in as `coordinator` with your password. The first visit can take a few seconds while the certificate is issued.

## 7. Run the tracker every 5 minutes (VM)

Before the first real run:
- Run `engine/schema.sql` once in the Supabase SQL editor.
- Stop the Apps Script trigger.
- **Pause the cron-job.org job** (the VM replaces it).
- Copy in this month's AeroDataBox usage from the RapidAPI dashboard.

```bash
cd ~/flight-tracker
node engine/run.js --set-usage UNITS REQUESTS
npm run tracker:dry-run
crontab -e
```

Add this line, save and close:

```
*/5 * * * * cd $HOME/flight-tracker && /usr/bin/node engine/run.js --scheduled 2>&1 | logger -t flight-tracker
```

Check it after 5 minutes: `journalctl -t flight-tracker -n 50`. The dashboard's header should say "Tracker last ran … (just now)".

## Updating later

New code: repeat step 3, then `npm ci --omit=dev && pm2 restart all`. Changed settings: repeat step 4, then `pm2 restart all`.
