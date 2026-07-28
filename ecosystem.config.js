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
      // Worst-case 12-browser RSS ≈ 4.1 GB sits just under this restart point.
      max_memory_restart: '4608M',

      // Logging
      out_file:   '/tmp/san-queue-out.log',
      error_file: '/tmp/san-queue-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
