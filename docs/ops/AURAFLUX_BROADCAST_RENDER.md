# AuraFlux Broadcast on Render (CPD-1040)

Dedicated **auraflux-broadcast-staging** worker: MediaMTX + Live Grid ffmpeg sidecar. C0 dashboard/API proxy via `LIVE_SIDECAR_URL`.

## Architecture

```
c0 dashboard (localhost:3000)
    → LIVE_SIDECAR_URL (HTTPS)
        → auraflux-broadcast-staging:10000
            → MediaMTX (8554/8890) + LiveGridManager ffmpeg
                → YouTube RTMP
```

## Health

```bash
curl -sS "https://auraflux-broadcast-staging.onrender.com/live-broadcast/health"
```

## Go live (operator)

1. Ensure Render broadcast service is healthy.
2. On Mac c0: `LIVE_SIDECAR_URL=https://auraflux-broadcast-staging.onrender.com` in `.env`
3. Stop local sidecar: `pm2 stop broadcast-sidecar` (encode runs on Render)
4. Dashboard → Live Grid → GO LIVE (private listing first)

## Env (broadcast service)

See `render.yaml` `auraflux-broadcast-staging` block + secrets from c0 `.env` and `YOUTUBE_REFRESH_TOKEN` (from `data/youtube_tokens.json` on c0).

R0 profile: `config/live_grid_profile_render.json` — middleware off, `libx264`.

## Rollback

Point `LIVE_SIDECAR_URL` back to `http://127.0.0.1:3001`, restart local `pm2 start broadcast-sidecar`.
