# Live stream — video monitor (read-only)

You monitor **video quality on localhost** — composed grid + relay taps. **Do not use YouTube** for QA unless explicitly checking publish.

## Primary feed (localhost)

```bash
curl -s http://127.0.0.1:3000/broadcast/local-feed | python3 -m json.tool
curl -s http://127.0.0.1:3000/broadcast/live-monitor | python3 -m json.tool
```

| What | URL / field |
|------|-------------|
| **Composed grid (what we ship)** | `composed.hlsUrl` → play in browser |
| **Watch page** | `composed.watchPageUrl` → http://127.0.0.1:3000/broadcast/local-watch |
| **On-air relay tap** | `onAir.rtspUrl` + snapshot in `onAir.snapshotPath` |
| **Twitch source (reference)** | `onAir.twitchWatchUrl` — compare source vs our relay |
| **Per-quad sources** | `sources[]` — each quad's Twitch + RTSP |

Poll `/broadcast/live-monitor` every 60s until `isStable === true`.

## What matters (video)

| Signal | Source |
|--------|--------|
| Composed grid quality | `composed.hlsUrl` (browser or ffprobe) |
| Frozen / black on-air tile | av-probe snapshot + `probe.videoLevel` |
| Relay churn | `live-monitor` pipeline block |
| Master restart | `pipeline.masterRestarts` |

## What to IGNORE

- **YouTube viewer count / CDN** — not our encoder
- **Twitch viewer counts** — not a tuning signal
- **`heavy_sources` / CPU baseline** — fixed 4-stream load

## Stability = done polling

Stop when `isStable: true` and `composed.hlsReady: true` (or RTSP probes green if HLS not enabled yet).

## Modes

- **`LIVE_GRID_LOCAL_ONLY=on`** — grid outputs HLS only, no YouTube RTMP (best for QA)
- **`LIVE_GRID_LOCAL_HLS=on`** (default) — tee same encode to localhost HLS while RTMP live

Repo: **cwn-c0** · sidecar :3001 · auraflux :3000
