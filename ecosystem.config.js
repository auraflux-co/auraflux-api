// PM2 Ecosystem Config — AuraFlux
// Dev:        npm run dev        (PM2 development mode)
// Production: npm run start      (PM2 single instance)
// Cluster:    npm run start:cluster (PM2 max CPUs, zero-downtime reloads)
// Reload:     npm run restart    (zero-downtime)
// Persist:    pm2 startup && pm2 save  (survive reboots)

// Ensure .env values override stale inherited shell/PM2 daemon variables (repo root, not PM2 cwd).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

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

      // Memory guard — restart if server leaks past 4GB.
      // 1G was too low: Gemini clip-analysis wave (8 parallel ~32MB downloads + base64
      // upload buffers) legitimately peaks ~1.5-2GB and was OOM-killed mid-job (2026-06-10).
      max_memory_restart: '4G',

      // Logging
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // Environment — development (nodemon preferred, but PM2 works)
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        CWN_OVERLAY_BASELINE_PRESET: '0415',
        GATE_TEST_MODE: 'false', // PRODUCTION RUN — intentional full pipeline test
      },

      // Environment — production (Render or local production run)
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        CWN_OVERLAY_BASELINE_PRESET: '0415',
        GATE_TEST_MODE: 'false', // PRODUCTION RUN — intentional full pipeline test
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
    {
      name: 'job-monitor',
      script: 'scripts/job_monitor_daemon.cjs',
      cwd: __dirname,
      interpreter: 'node',
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,
      out_file: 'logs/job_monitor_pm2.log',
      error_file: 'logs/job_monitor_pm2.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'development',
        JOB_MONITOR_INTERVAL_MS: '60000',
        JOB_MONITOR_LOG: 'logs/job_monitor_events.jsonl',
      },
      env_production: {
        NODE_ENV: 'production',
        JOB_MONITOR_INTERVAL_MS: '60000',
        JOB_MONITOR_LOG: 'logs/job_monitor_events.jsonl',
      },
    },
  ],
};
