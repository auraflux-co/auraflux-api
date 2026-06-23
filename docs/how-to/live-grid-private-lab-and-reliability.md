# Live Grid — Private Lab & Swap Reliability Plan

**Status:** Planning / documentation only (not implemented)  
**Repo:** `cwn-c0` · **Sidecar:** pm2 `broadcast-sidecar` :3001  
**Related:** [Brand overlay & go-live](live-grid-branding.md) · [**Full issue inventory + middleware + Render**](live-grid-middleware-and-render-architecture.md) · `config/live_grid_profile_baseline.json` · `config/live_grid_profile_e2e.json`  
**Policy:** [CPD-1037](https://aurafluxco.atlassian.net/browse/CPD-1037) — dedicated streaming worker before Render migration  
**Confluence (production HOW):** C0 Live Grid (page 30932993)

---

## Problem (why patches have not stuck)

Since Live Grid launched, **YouTube ingest can go dead or starved when Twitch streamers log off**, especially when several go offline in a cluster overnight. Root causes stack:

| Layer | What happens |
|-------|----------------|
| **Feeder** | Logoff → slate + `onChannelOffline` → **immediate `pollOnce()`** replace |
| **Relay (CPD-1006)** | RTSP EOF → relay **exits and restarts** → UDP gap into master |
| **Master compositor** | Reads live UDP with timestamp discontinuities; CPU spikes when 4 relay transcodes + master encode run together |
| **RTMP tee** | `onfail=ignore` — process can stay “running” while YouTube shows inactive / `videoIngestionStarved` |
| **Local HLS today** | **Mirror** of same encode (ffmpeg `tee`), not middleware — local watch can look fine while YouTube is down |

**Design promise (CPD-1006):** relay restart, not master kill.  
**Missing guarantee:** **YouTube ingest continuity** during source churn.

---

## Target architecture (planned)

### Output middleware

```
Twitch → feeders → MediaMTX quads → compositor → local stable publish (/grid)
                                                          ↓
                                                grid-restreamer → YouTube RTMP
```

- **Inputs** already use stable local paths (`rtsp://localhost:8554/quadN`).
- **Output** needs the same pattern: compositor publishes locally; a **long-lived restreamer** owns the YouTube RTMP session.

### Staged swap with waiting image

On logoff or manual swap:

1. Tile shows **waiting slate** (`slate.mp4` — “NEXT STREAMER LOADING”) — already exists in `lib/live_grid/feeders.js`.
2. **Local only:** probe bench, prefetch streamlink, stable publish to MediaMTX.
3. **`swap_complete(q)` gate** — all pass before cut to live tile:
   - Twitch probe OK
   - Prefetch handoff or stable streamlink → ffmpeg → SRT/MTX
   - `rtspHasVideo(quadN)` stable ~2–3s
   - Relay quiet (no restart churn)
4. Restreamer either:
   - **Per-tile:** YouTube sees one loading tile (acceptable), or
   - **Full hold:** restreamer freezes last good frame until no quad in `SWAPPING`.

YouTube has **no swap API** — RTMP is a dumb pipe. “Tell YouTube when swap complete” means **tell the restreamer** (or auto-detect local stability), not a Studio action.

### What already exists vs what to build

| Exists | To build |
|--------|----------|
| Branded slate / waiting image | Stop `onChannelOffline` → immediate poll from cutting live path |
| Prefetch handoff (`_prefetchChannelSwap`) | Offline path always prefetch-first; cold swap only on timeout |
| UDP relays + MTX quad paths | Output publish to MTX + `grid-restreamer` process |
| Local HLS tee (QA mirror) | Restreamer hold + dashboard YouTube health (not just “master running”) |
| `LIVE_GRID_LOCAL_ONLY` rehearsal mode | `swap_complete(q)` orchestration in manager |

---

## Definition of done (reliability)

1. **Single logoff:** Kill one streamlink → tile slate → replacement live → YouTube health **good** for 10 min.
2. **Burst logoff:** 3 streamlinks within 60s → same; max ~30s slate per tile; **zero** `inactive` / `videoIngestionStarved` > 2 min.
3. **Overnight soak:** 6+ h, ≥5 natural logoffs → no hard-down periods.
4. **Dashboard truth:** status shows **YouTube ingest health**, not only `running: true`.
5. **Optional:** dedicated encode host (Render/VPS per CPD-1037) — capacity layer, not substitute for staged swap.

---

## Phased engineering plan

| Phase | Work | Deliverable |
|-------|------|-------------|
| **0** | Freeze problem | Confluence: *Swap & Ingest Contract* + sequence diagram; Jira epic under CPD-1037 |
| **1** | Lab reproduce | Scripted logoff tests; Profile A (copy relays / lighter) vs Profile B (baseline transcode) |
| **2** | Decision gate | Mac capacity vs swap transport — pick middleware + staged swap vs profile-only |
| **3** | One vertical slice | Debounce, relay continuity, restreamer, `swap_complete`, RTMP observability |
| **4** | Prove | 30 min private → 3 h private with scripted logoffs → overnight on locked profile |

**Do not** treat mid-stream encoder restart or baseline knob-turning as the fix until Phase 1 data exists.

---

## Private lab & local test (operational)

The sidecar runs **one grid session at a time**. You cannot run a second YouTube encode in parallel on the same `broadcast-sidecar` without stopping the current grid.

### Local URLs (when grid is running)

| Resource | URL |
|----------|-----|
| Watch page | http://127.0.0.1:3000/broadcast/local-watch |
| HLS playlist | http://127.0.0.1:3000/broadcast/preview-hls/index.m3u8 |
| Sidecar status | http://127.0.0.1:3001/live-grid/status |
| Live monitor | http://127.0.0.1:3000/broadcast/live-monitor |
| Preflight | `curl -s http://127.0.0.1:3001/live-grid/preflight \| python3 -m json.tool` |

**Important:** With `LIVE_GRID_LOCAL_HLS=on` (baseline default), local HLS is a **tee of the same encode** as RTMP — good for **QA video**, not proof that YouTube is healthy.

**Video QA rule:** Prefer localhost (`composed.hlsUrl`, live-monitor) over YouTube Studio for swap/tile checks. See `.cursor/agents/live-stream-video-monitor.md`.

### Option A — Local only (no YouTube, safest lab)

No YouTube API calls. Compositor writes HLS only (`localOnly: true`).

**Prerequisites:** Grid not running (or stop first).

```bash
SIDECAR="${LIVE_SIDECAR_URL:-http://127.0.0.1:3001}"

# Stop encoder — default keeps listing open (no endBroadcast)
curl -s -X POST "$SIDECAR/live-grid/stop" \
  -H 'Content-Type: application/json' -d '{}' | python3 -m json.tool

# Rehearsal start
curl -s -X POST "$SIDECAR/live-grid/start" \
  -H 'Content-Type: application/json' \
  -d '{"localOnly":true,"operatorMode":true,"programMode":"grid"}' | python3 -m json.tool
```

Equivalent env: `LIVE_GRID_LOCAL_ONLY=on` in `.env` before start.

### Option B — Private YouTube listing + local HLS tee

Creates a **new private** listing on the permanent RTMP stream key (`LIVE_GRID_RTMP_URL`). Local HLS stays on if `LIVE_GRID_LOCAL_HLS=on`.

**Cost:** Stops current encode (~30–60s RTMP gap on whatever listing was live).

```bash
SIDECAR="${LIVE_SIDECAR_URL:-http://127.0.0.1:3001}"

curl -s -X POST "$SIDECAR/live-grid/stop" \
  -H 'Content-Type: application/json' -d '{}' | python3 -m json.tool

curl -s -X POST "$SIDECAR/live-grid/start" \
  -H 'Content-Type: application/json' \
  -d '{
    "privacyStatus": "private",
    "freshListing": true,
    "operatorMode": true,
    "programMode": "grid",
    "seo": {
      "title": "LAB PRIVATE — Live Grid swap test",
      "description": "Private rehearsal — swap/middleware testing. Not public."
    }
  }' | python3 -m json.tool
```

Sidecar persists new `LIVE_GRID_BROADCAST_ID` / `LIVE_GRID_WATCH_URL` to `.env`. Only you (and link holders) see the stream while `privacyStatus` is `private`.

E2E lockdown profile uses private + scheduled go-public:

```json
"startPayload": {
  "createListing": false,
  "privacyStatus": "private",
  "goPublicAt": "18:00"
}
```

See `config/live_grid_profile_e2e.json`.

### Option C — Test local on production encode (no stop)

If the nightly grid is already running, **local HLS is already available** on the URLs above. Use this to inspect swaps without creating a new listing. YouTube may still be unhealthy — local watch does not prove ingest.

### Return to production listing after lab

After a lab run overwrote `.env` broadcast ids, reattach to the known production listing (example — replace with your canonical id):

```bash
SIDECAR="${LIVE_SIDECAR_URL:-http://127.0.0.1:3001}"

curl -s -X POST "$SIDECAR/live-grid/stop" \
  -H 'Content-Type: application/json' -d '{}'

curl -s -X POST "$SIDECAR/live-grid/start" \
  -H 'Content-Type: application/json' \
  -d '{
    "broadcastId": "YOUR_PRODUCTION_BROADCAST_ID",
    "createListing": false,
    "privacyStatus": "public"
  }' | python3 -m json.tool
```

Or restore `LIVE_GRID_BROADCAST_ID` / `LIVE_GRID_WATCH_URL` in `.env` and start with `createListing: false` + `LIVE_GRID_TRUST_ENV_BROADCAST=on`.

### Stop semantics

| Body | Effect |
|------|--------|
| `{}` (default) | Stop ffmpeg; **keep** YouTube listing open (`skipEndBroadcast` when env RTMP bypass) |
| `{"endBroadcast": true}` | Stop ffmpeg **and** end listing via YouTube API |

---

## Lab test matrix (Phase 1 — when implemented)

Run on **private listing** or **local only**; log to `logs/stream_health.jsonl`.

| Test | Action | Pass |
|------|--------|------|
| Single logoff | Kill one quad streamlink | Tile slate → live; YT `good` 10 min (Option B) or local stable (Option A) |
| Triple logoff | 3 quads within 60s | No hard down > 2 min |
| Profile A | Copy relays, 720p ladder | Baseline comparison |
| Profile B | Baseline transcode 1080p | Document failure mode |
| Host load | Mac idle vs household load | Correlate CPU vs `videoIngestionStarved` |

---

## Config reference

| File | Purpose |
|------|---------|
| `config/live_grid_profile_baseline.json` | Locked overnight encode + env |
| `config/live_grid_profile_e2e.json` | Nightly lockdown + private start payload |
| `config/live_grid_go_live.json` | Template SEO + operator locks |
| `scripts/live_grid_baseline.sh` | Apply / verify baseline |
| `scripts/live_grid_e2e_lockdown.sh` | E2E preflight before go-live |

---

## Jira / Confluence (to create)

| Item | Purpose |
|------|---------|
| **Epic (new)** e.g. CPD-XXXX | Live Grid: logoff must not drop YouTube ingest |
| **HOW (Confluence)** | Swap & Ingest Contract — diagrams, gate definitions, lab pass/fail |
| **CPD-1037** | Parent policy — dedicated streaming worker / Render path |

---

## Related code

| Module | Role |
|--------|------|
| `lib/live_grid/feeders.js` | Slate, prefetch handoff, `onChannelOffline` |
| `lib/live_grid/relays.js` | Quad RTSP → UDP |
| `lib/live_grid/compositor.js` | Master encode, RTMP + HLS tee |
| `lib/live_grid/manager.js` | Start/stop, `_onChannelWentOffline`, go-live |
| `lib/live_grid/local_preview.js` | Local HLS paths + watch URLs |
| `lib/live_grid/youtube_sync.js` | YouTube lifecycle vs local `running` |
