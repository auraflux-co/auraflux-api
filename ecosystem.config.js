// PM2 Ecosystem Config — AuraFlux
// Dev:        npm run dev        (PM2 development mode)
// Production: npm run start      (PM2 single instance)
// Cluster:    npm run start:cluster (PM2 max CPUs, zero-downtime reloads)
// Reload:     npm run restart    (zero-downtime)
// Persist:    pm2 startup && pm2 save  (survive reboots)

require('dotenv').config();

module.exports = {
  apps: [
    {
      name: 'roo-watcher',
      script: 'scripts/roo_watcher.sh',
      interpreter: 'bash',
      watch: false,
      max_restarts: 10,
      min_uptime: '5s',
      restart_delay: 3000,
      out_file: 'logs/roo_watcher.log',
      error_file: 'logs/roo_watcher.log',
      merge_logs: true,
      // Always runs locally. On Render the RENDER env var is set automatically
      // and the script exits cleanly — no Cursor/Roo available in cloud.
      env: { ROO_WATCHER: 'true' },
      env_production: { ROO_WATCHER: 'true' },
    },
    {
      name: 'auraflux',
      script: 'server.js',
      watch: false,  // nodemon handles dev watching — PM2 watch off in production

      // Restart policy
      max_restarts: 10,
      min_uptime: '10s',       // must stay up 10s to count as a successful start
      restart_delay: 2000,     // 2s between crash restarts

      // Memory guard — restart if server leaks past 1GB
      max_memory_restart: '1G',

      // Logging
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // Environment — development (nodemon preferred, but PM2 works)
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        GATE_TEST_MODE: 'true', // SAFE DEFAULT — change to 'false' only for intentional production runs
      },

      // Environment — production (Render or local production run)
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        GATE_TEST_MODE: 'true', // SAFE DEFAULT — change to 'false' only for intentional production runs
      },

      // Ignore watch dirs (mirrors nodemon.json)
      ignore_watch: [
        'node_modules',
        'tmp',
        'output',
        'assets',
        'data',
        'logs',
        '*.mp4',
        '*.png',
      ],
    },
  ],
};
