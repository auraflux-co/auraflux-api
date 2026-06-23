# Live Grid — Brand Overlay & YouTube Go-Live

**Jira:** CPD-1005 · **Code:** `lib/live_grid/brand_overlay.js`, `lib/live_grid/avatar_cache.js`, `lib/live_grid/manager.js`  
**See also:** [Private lab & swap reliability plan](live-grid-private-lab-and-reliability.md) — local/private test procedures + staged-swap architecture (planning)  
**Architecture:** [Stream issues, middleware & Render setup](live-grid-middleware-and-render-architecture.md)

## Go live (no API credits)

1. Create **one** listing in YouTube Studio on the permanent stream key (`LIVE_GRID_RTMP_URL` in `.env`).
2. Paste title/description from `output/GO_LIVE_6PM_*.md` **or** rely on `config/live_grid_go_live.json` template at GO LIVE.
3. Update `.env`: `LIVE_GRID_BROADCAST_ID`, `LIVE_GRID_WATCH_URL`.
4. `bash scripts/live_grid_go_live.sh` (or `WAIT_FOR_BROADCAST_ID=1` while you finish Studio).
5. Studio → **Go live** when RTMP is active.

## Title & description (how they are built)

| Path | When | OpenAI? |
|------|------|---------|
| **`config/live_grid_go_live.json`** | Nightly GO LIVE with operator locks (default) | **No** — hardcoded template + `buildGoLiveSeo()` |
| **`fallbackSeo()`** | Poller-driven / no template / `grid` mode | **No** — deterministic copy in `lib/live_grid/seo.js` |
| **`generateGridSeo()` GPT** | Only if `LIVE_GRID_SEO_GPT=on` and mode is not `grid`/`news_desk`/`event_night` | Yes (rare; grid explicitly skips GPT — it hallucinated events) |

**Not** the same pipeline as clip/VOD metadata (that uses different prompts/models elsewhere). Live grid SEO is **template-first** for reliability.

**Title rules (2026-06-19):** `#ClipzWorldNews` removed from title by default (`LIVE_GRID_TITLE_CHANNEL_HASHTAG=off`). ET date still inserted via `withLiveTitleDate`. Hashtags remain in the **description** footer only.

**Description:** `ON SCREEN NOW` lists Q1–Q4 with **Twitch URLs** next to each starting streamer (from `operatorLocks` in go-live config). Update locks + optional `seo.title` in `config/live_grid_go_live.json`; omit `seo.description` to auto-generate from locks.


## RTMP protection (do not disable mid-stream)

| Env | Default | Purpose |
|-----|---------|---------|
| `LIVE_GRID_AUTOTUNE` | `off` | Never restart ffmpeg for CPU load during live |
| `LIVE_GRID_PROTECT_YT_RTMP` | `on` | Skip avatar/PIP encoder restarts while listing attached |
| `LIVE_GRID_TRUST_ENV_BROADCAST` | `on` | Attach to `.env` listing with zero YouTube API calls |
| `LIVE_GRID_SEO_ON_START` | `off` | Edit title/description in Studio instead of API |

## Brand overlay

- Full-width name strips (no vertical seam between Q1/Q2).
- On-air: centered name + Twitch avatar + gold ON AIR badge (`assets/live_grid/on_air_badge.png`).
- Baseline profile: `config/live_grid_profile_baseline.json` — apply with `bash scripts/live_grid_baseline.sh apply`.
- **E2E lockdown** (nightly go-live): `config/live_grid_profile_e2e.json` — apply + verify with `bash scripts/live_grid_e2e_lockdown.sh preflight` before every stream.

## Preflight

```bash
curl -s http://127.0.0.1:3001/live-grid/preflight | python3 -m json.tool
bash scripts/live_grid_baseline.sh preflight
```
