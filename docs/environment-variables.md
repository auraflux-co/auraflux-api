# Environment Variables — C0 Localhost

Generated reference for ops. Authoritative stubs: `.env.example` (run `node scripts/sync_env_example.js --write` after adding vars).

## Live Grid (`LIVE_GRID_*`)

| Variable | Default | Description |
|----------|---------|-------------|
| `LIVE_GRID_RTMP_URL` | — | Permanent YouTube RTMP ingest URL (stream key from Studio) |
| `LIVE_GRID_STREAM_ID` | — | YouTube stream resource id (optional if using env-only attach) |
| `LIVE_GRID_BROADCAST_ID` | — | Current Studio listing video id — **one listing per session** |
| `LIVE_GRID_WATCH_URL` | — | `https://youtube.com/live/<BROADCAST_ID>` |
| `LIVE_GRID_TRUST_ENV_BROADCAST` | `on` | Skip YouTube API on start; use `.env` listing + RTMP |
| `LIVE_GRID_SEO_ON_START` | `off` | Push title/tags via API on start (costs quota) |
| `LIVE_GRID_AUTOTUNE` | `off` | Restart encoder when CPU high — **drops YouTube RTMP** |
| `LIVE_GRID_PROTECT_YT_RTMP` | `on` | No encoder restart for avatar reload mid-stream |
| `LIVE_GRID_ALWAYS_FRESH_LISTING` | `off` | Never auto-create listings on restart |
| `LIVE_GRID_ALLOW_NEW_STREAM` | `off` | API may create stream keys (first-time setup only) |
| `LIVE_GRID_OPERATOR_MODE` | `on` | Operator locks + offline auto-fill |
| `LIVE_GRID_AUTO_RESUME` | `off` | Sidecar restart auto-starts grid |
| `LIVE_GRID_YOUTUBE_SYNC` | `off` | Poll YouTube lifecycle (costs quota) |
| `LIVE_GRID_YOUTUBE_SQUARE_PAD` | `off` | **Keep off** — 1080×1080 RTMP breaks VODs |
| `LIVE_GRID_OUTPUT_W` / `H` | `1920` / `1080` | Landscape canvas |
| `LIVE_GRID_UDP_RELAY` | `on` | Per-quadrant UDP relays (swap without master kill) |
| `LIVE_GRID_AUDIO_DIRECT` | `on` | Hot-switch audio via volume gates |
| `LIVE_GRID_AUDIO_COPY` | `off` | Direct audio map (requires master restart on hop) |
| `LIVE_GRID_MUSIC_GUARD` | `off` | Gemini music detection (overnight optional) |
| `LIVE_GRID_LOCAL_HLS` | `on` | Tee composed output to `tmp/live_grid/preview/` (same encode as RTMP — QA mirror, not middleware) |
| `LIVE_GRID_LOCAL_ONLY` | `off` | HLS only — skip YouTube RTMP (`localOnly: true` on start also works) |

Full list: grep `^# LIVE_GRID` or `^LIVE_GRID` in `.env.example`.

## Stream health

| Variable | Description |
|----------|-------------|
| `STREAM_SCHEDULER` | `off` on C0 — manual/scheduled go-live |
| `LIVE_SIDECAR_PORT` | Default `3001` — broadcast-sidecar |

See also: `docs/how-to/live-grid-branding.md`, `docs/how-to/live-grid-private-lab-and-reliability.md`, `docs/how-to/live-grid-middleware-and-render-architecture.md`, `config/live_grid_profile_baseline.json`.
