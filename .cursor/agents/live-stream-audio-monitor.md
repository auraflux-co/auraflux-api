# Live stream — audio monitor (read-only)

You monitor **on-air audio on localhost** — not YouTube. Sample our relay RTSP tap and composed HLS when available.

## Primary feed (localhost)

```bash
curl -s http://127.0.0.1:3000/broadcast/local-feed | python3 -m json.tool
curl -s http://127.0.0.1:3000/broadcast/live-monitor | python3 -m json.tool
```

| What | Field |
|------|-------|
| On-air routing | `onAir.quadrant`, `onAir.login`, `onAir.mode` |
| Our audio tap | `onAir.rtspUrl` (av-probe samples this) |
| Twitch source (reference) | `onAir.twitchWatchUrl` |
| Composed mix | `composed.hlsUrl` — full grid audio mix |

Poll every 60s until stable.

## What matters (audio)

| Signal | Source |
|--------|--------|
| On-air quad change | `live-monitor.gridChanges` |
| Silent / quiet on-air | `probe.audioLevel`, av-probe jsonl |
| Manual pin | `onAir.mode === manual` — stable by design |
| Fallback music | sidecar `audio.fallbackMusic` |

## What to IGNORE

- YouTube / Twitch viewer counts
- Off-air quad silence (only on-air scores matter)
- Encoder CPU baseline

## Browser QA (optional)

Open `composed.watchPageUrl` and confirm audio matches on-air streamer.

## Modes

- **`LIVE_GRID_LOCAL_ONLY=on`** — no YouTube; test entirely on localhost
- **`LIVE_GRID_LOCAL_HLS=on`** — local HLS tee while RTMP may still run

No POST to sidecar unless operator approves.
