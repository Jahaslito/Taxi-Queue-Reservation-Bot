module.exports = {
  apps: [
    {
      name:             'san-queue',
      script:           'server.js',
      node_args:        '--no-warnings',
      instances:        1,
      autorestart:      true,
      watch:            false,
      // Kept BELOW the Docker hard cap (docker-compose.yml app limit) so pm2
      // restarts the app gracefully before Docker's OOM killer kills the
      // container. Was 1400M for the 2 GB droplet — raised 2026-06-16 for 8 GB.
      // ⚠️ 2026-07-28 — 3584M → 4608M for the 12-browser armed pool (Lever 1).
      // Docker app cap raised in lockstep 4096M → 5120M to keep this 512M gap.
      // ⚠️ 2026-08-07 — 4608M → 11264M for the 16 GB droplet + 25-browser / 100-
      // armed pool. Docker app cap raised in lockstep 5120M → 12288M to keep a
      // ~1 GB graceful-restart gap. Worst-case 25-browser RSS ≈ 8.4 GB sits well
      // under this restart point.
      max_memory_restart: '11264M',

      // Logging
      out_file:   '/tmp/san-queue-out.log',
      error_file: '/tmp/san-queue-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
