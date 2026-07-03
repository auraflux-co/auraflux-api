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
      name: 'broadcast-sidecar',
      script: 'scripts/live_broadcast_sidecar.js',
      cwd: __dirname,
      interpreter: 'node',
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,
      out_file: 'logs/broadcast_sidecar.log',
      error_file: 'logs/broadcast_sidecar.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'development',
        LIVE_SIDECAR_PORT: 3001,
        LIVE_BROADCAST_SIDECAR: 'on',
        STREAM_SCHEDULER: 'off',
        LIVE_GRID_AUTO_RESUME: 'off',
        LIVE_GRID_SCHEDULE_AHEAD: 'off',
        LIVE_GRID_LOCAL_HLS: 'on',
        LIVE_GRID_AUDIO_DIRECT: 'on',
        LIVE_GRID_AUDIO_COPY: 'off',
        LIVE_GRID_ENCODER: 'videotoolbox',
      },
      env_production: {
        NODE_ENV: 'production',
        LIVE_SIDECAR_PORT: 3001,
        LIVE_BROADCAST_SIDECAR: 'on',
        STREAM_SCHEDULER: 'off',
        LIVE_GRID_AUTO_RESUME: 'off',
        LIVE_GRID_SCHEDULE_AHEAD: 'off',
        LIVE_GRID_LOCAL_HLS: 'on',
        LIVE_GRID_AUDIO_DIRECT: 'on',
        LIVE_GRID_AUDIO_COPY: 'off',
        LIVE_GRID_ENCODER: 'videotoolbox',
      },
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
        C0_LOCALHOST: '1',
        STREAM_SCHEDULER: 'off',
        LIVE_GRID_AUTO_RESUME: 'off',
        LIVE_GRID_SCHEDULE_AHEAD: 'off',
        CWN_OVERLAY_BASELINE_PRESET: '0415',
        GATE_TEST_MODE: 'false', // PRODUCTION RUN — intentional full pipeline test
        AUTO_PUBLISH_PLATFORMS: 'none', // Gate 5 off during assembly/editorial testing
        YOUTUBE_DIRECT_PUBLISH: 'false',
        USE_LOCAL_FFMPEG: process.env.USE_LOCAL_FFMPEG || '1',
        FFMPEG_FILTER_PATH: process.env.FFMPEG_FILTER_PATH || '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
      },

      // Environment — production (Render or local production run)
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        C0_LOCALHOST: '1',
        STREAM_SCHEDULER: 'off',
        LIVE_GRID_AUTO_RESUME: 'off',
        LIVE_GRID_SCHEDULE_AHEAD: 'off',
        CWN_OVERLAY_BASELINE_PRESET: '0415',
        GATE_TEST_MODE: 'false', // PRODUCTION RUN — intentional full pipeline test
        AUTO_PUBLISH_PLATFORMS: 'none', // Gate 5 off during assembly/editorial testing
        YOUTUBE_DIRECT_PUBLISH: 'false',
        USE_LOCAL_FFMPEG: process.env.USE_LOCAL_FFMPEG || '1',
        FFMPEG_FILTER_PATH: process.env.FFMPEG_FILTER_PATH || '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
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
      name: 'stream-health',
      script: 'scripts/stream_health_daemon.cjs',
      cwd: __dirname,
      interpreter: 'node',
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,
      out_file: 'logs/stream_health_pm2.log',
      error_file: 'logs/stream_health_pm2.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'development',
        STREAM_HEALTH_INTERVAL_MS: '45000',
      },
      env_production: {
        NODE_ENV: 'production',
        STREAM_HEALTH_INTERVAL_MS: '45000',
      },
    },
    {
      name: 'stream-av-probe',
      script: 'scripts/stream_av_probe_daemon.cjs',
      cwd: __dirname,
      interpreter: 'node',
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      out_file: 'logs/stream_av_probe_pm2.log',
      error_file: 'logs/stream_av_probe_pm2.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'development',
        STREAM_AV_PROBE_INTERVAL_MS: '60000',
        // On-air quad only for stability scores; set true to sample all 4 (diagnostic, heavier).
        STREAM_AV_PROBE_ALL_QUADS: 'false',
      },
      env_production: {
        NODE_ENV: 'production',
        STREAM_AV_PROBE_INTERVAL_MS: '60000',
        STREAM_AV_PROBE_ALL_QUADS: 'false',
      },
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
    {
      name: 'dashboard-cache-warm',
      script: 'scripts/warm_dashboard_cache.js',
      cwd: __dirname,
      interpreter: 'node',
      watch: false,
      autorestart: false,
      max_restarts: 0,
      cron_restart: process.env.DASHBOARD_CACHE_WARM_CRON || '*/20 * * * *',
      out_file: 'logs/dashboard_cache_warm.log',
      error_file: 'logs/dashboard_cache_warm.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'development',
        DASHBOARD_CACHE_WARM_ENABLED: process.env.DASHBOARD_CACHE_WARM_ENABLED || '1',
      },
      env_production: {
        NODE_ENV: 'production',
        DASHBOARD_CACHE_WARM_ENABLED: process.env.DASHBOARD_CACHE_WARM_ENABLED || '1',
      },
    },
    {
      // CPD-1224 — daily seed run of our published Apify Twitch Clips Scraper.
      // Store ranking weights run count + success rate; a small daily run keeps
      // the actor warm. No-op unless APIFY_ACTOR_SEED_ENABLED=1. Does not touch
      // the production clip path (that still uses Helix in twitch_clips_fetch.js).
      name: 'apify-actor-seed',
      script: 'scripts/apify_seed_twitch_actor.js',
      cwd: __dirname,
      interpreter: 'node',
      watch: false,
      autorestart: false,
      max_restarts: 0,
      cron_restart: process.env.APIFY_ACTOR_SEED_CRON || '17 9 * * *',
      out_file: 'logs/apify_actor_seed.log',
      error_file: 'logs/apify_actor_seed.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'development',
        APIFY_ACTOR_SEED_ENABLED: process.env.APIFY_ACTOR_SEED_ENABLED || '0',
      },
      env_production: {
        NODE_ENV: 'production',
        APIFY_ACTOR_SEED_ENABLED: process.env.APIFY_ACTOR_SEED_ENABLED || '0',
      },
    },
  ],
};
