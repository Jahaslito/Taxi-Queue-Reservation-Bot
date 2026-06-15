module.exports = {
  apps: [
    {
      name:             'san-queue',
      script:           'server.js',
      node_args:        '--no-warnings',
      instances:        1,
      autorestart:      true,
      watch:            false,
      // Kept BELOW the Docker hard cap (docker-compose.yml app limit, 4096M) so
      // pm2 restarts the app gracefully before Docker's OOM killer kills the
      // container. Was 1400M for the 2 GB droplet — raised 2026-06-16 for 8 GB.
      max_memory_restart: '3584M',

      // Logging
      out_file:   '/tmp/san-queue-out.log',
      error_file: '/tmp/san-queue-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
