# Live monitor — 2026-06-20T00:19:23.119Z

**Read-only** — polls stream-health + A/V probe. No fixes applied without operator approval.

**Stability:** CRITICAL · streak **0/10**

## Philosophy
- YouTube viewer count is **not** a tuning signal — audience is on YouTube CDN, not our encoder.
- **4 relay transcodes** = fixed power load; `heavy_sources` / high ffmpeg CPU is baseline, not a failure.
- **Only runtime changes that matter:** which quad has on-air audio, which streamer leaves/enters a grid box.

## Grid changes this tick
- **Q1 swap:** stableronaldo → hasanabi
- **Q3 swap:** cinna → maya

## Blockers (must clear before stable)
- relay_churn:2
- rtsp_probe_fail:4

## A/V probe (sampled RTSP)
- Video: **good** (100/100)
- Audio: **good** (100/100)

## Pipeline (encoder / relays)
- On-air: **Q2** yourragegaming · mode auto
- Master restarts: 0 · relay churn tick: 2

## Baseline load (informational — do not tune for these)
- heavy_sources

## Actionable health flags
- relay_churn_tick:2
- rtsp_probe_fail:4
- relay_churn

## Watch (localhost QA)
- Composed HLS: http://127.0.0.1:3000/broadcast/preview-hls/index.m3u8 (ready)
- Watch page: http://127.0.0.1:3000/broadcast/local-watch
- YouTube (optional): https://youtube.com/live/07nAcIokb6Y

## Agent endpoints
- `GET /broadcast/live-monitor` — this report (JSON + markdown)
- `GET /broadcast/av-probe` — frame snapshots + audio levels
- `GET /broadcast/stream-health` — relay/encode/youtube pipeline

