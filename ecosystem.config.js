module.exports = {
  apps: [
    {
      name:             'san-queue',
      script:           'server.js',
      node_args:        '--no-warnings',
      instances:        1,
      autorestart:      true,
      watch:            false,
      max_memory_restart: '1400M',

      // Logging
      out_file:   '/tmp/san-queue-out.log',
      error_file: '/tmp/san-queue-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
