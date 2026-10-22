// pm2 process list for the Google Cloud VM (deploy/README.md): keeps the dashboard and the Telegram bot running
// and restarts them after a crash or a reboot. The tracker itself runs from cron every 5 minutes, not from pm2.
//   pm2 start deploy/ecosystem.config.js && pm2 save
// Both read their settings from the repository's own env files (.env.engine, local-assistant/.env.local-assistant).
module.exports = {
  apps: [
    {
      name: 'dashboard',
      script: 'tools/preview-server.js',
      cwd: __dirname + '/..',
      env: { PORT: '3000' },          // localhost only; Caddy serves it over HTTPS with a password
      max_memory_restart: '300M'
    },
    {
      name: 'telegram-bot',
      script: 'local-assistant/src/main.js',
      args: 'start',
      cwd: __dirname + '/..',
      max_memory_restart: '200M'
    }
  ]
};
