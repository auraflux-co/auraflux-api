# Generate + Job Queue — Code Pushed 2026-06-26 (C0)

Operator awareness summary for all commits on `c0/main` today.

## Content Library follow-ups (CPD-1108–1111)

| Commit | Ticket | What changed |
|--------|--------|--------------|
| `4e9e9fca` | CPD-1108, 1109 | Generate → Streamers: **Clips \| Videos** sub-tabs; VOD fetch + Analyze UI; Library **Send to Generate** opens picker with clips pre-selected |
| `9659e993` | CPD-1111 | `GET /content-library/used-clip-ids` — picker **USED** badges from SQLite `used_at` (no more `localStorage cwn_used_clips`) |
| `2647eac0` | CPD-1110 | VOD analyze: yt-dlp stream + ffmpeg frames → Gemini multimodal highlight window |
| `7d2687ad` | CPD-1103 | Hotfix: removed bad `windowToSinceMs` export that crashed server on boot |
| `52c89143`–`c3f23e0b` | CPD-1098–1105 | Full library epic: SQLite cache, crons, Library page, ingest/purge API, job save marking |

**Operator notes:**
- Library tab → select clips → **Send to Generate** lands on Streamers with picker open and clips checked.
- **Videos** tab: enter streamers → **Fetch VODs** → **Analyze** per VOD (~1–3 min; needs yt-dlp + ffmpeg + GEMINI_API_KEY).
- **USED** badges now match jobs saved to server; refresh on page load and before Pick clips.

## Clip comp / creative (CPD-1095–1097, 1106–1107)

| Commit | Ticket | Generate / queue impact |
|--------|--------|-------------------------|
| `3e2288be` | CPD-1096 | Creative catalog C1–C7 presets; brief 90s timeout; preset guards lock Short/Comp/Comp VOD buttons; **nav('queue')** after CLIPS COMP; Gate 1 FK save order fix |
| `525b1aec` | CPD-1097 | Twitch picker fetches up to **100 clips** per streamer (`TWITCH_PICKER_CLIP_CAP`) |
| `acef6410` | CPD-1106 | Hook Master: structured candidates, Claude QA 92+, Queue hook picker, `POST /job/:id/select-hook` |
| `5a1feed2` | CPD-1107 | Operator custom hook/title pickers; re-assemble preserves hooks/SEO |
| `c493850f` | CPD-1095 | Full bleed: Whisper probe before hook box; hook y≈620; logo top-right |

**Operator notes:**
- Pick a **Creative Mode** preset before Short/Comp — buttons stay locked to matching output type.
- After **Comp** completes, dashboard auto-navigates to **Queue**.
- Hook picker on Queue when multiple Hook Machine candidates pass QA.

## Queue / stats (CPD-1094)

| Commit | Ticket | Impact |
|--------|--------|--------|
| `2fb2647a` | CPD-1094 | Stats refresh via child process; queue auto-restores review jobs on load |

## Key files touched today

```
lib/content_library/*     — library store, ingest, purge, VOD analyze, frame samples
lib/clip_comp_hooks.js    — Hook Master + Gemini multimodal hooks
lib/clip_comp_creative.js — C1–C7 presets
lib/pickers/streamers/    — Twitch pagination, 100 cap, VOD duration parse
cwn_production.html       — Library page, Generate Videos tab, handoff, used-clip sync, creative UI, hook picker
server.js                 — content library routes, saveJobCard mark used, generate-clip-comp
```

## API routes (new today)

- `GET /content-library/clips|roster|vods|used-clip-ids`
- `POST /content-library/ingest|purge|vod/analyze`
- `GET /content-library/vod/:sessionId/segments`
- `POST /job/:id/select-hook` (CPD-1106)

## Deploy

```bash
cd ~/cwn-c0 && bash scripts/deploy_c0.sh
```

Confluence: [HOW — Streamer Content Library (CPD-1098)](https://aurafluxco.atlassian.net/wiki/spaces/CP/pages/38928386)

---

## Generate Composer (CPD-1112) — Phase 1 shipped

| Commit | Ticket | What changed |
|--------|--------|--------------|
| `392e61b4` | CPD-1114–1116 | **COMPOSER** panel: 9:16 preview mockup, trim sliders, templates, EXECUTE → assembly |
| `e6a76aff` | CPD-1113 | `compositionSpec` + `POST /composition/validate` + `/composition/templates` |

**Operator flow:** Pick clips → COMPOSER opens → review preview + trim → EXECUTE. Short/Comp/Comp VOD buttons open composer first.

**Phase 2 open:** [CPD-1117](https://aurafluxco.atlassian.net/browse/CPD-1117) — FFmpeg real preview + VOD segment timeline.

Confluence: [HOW — Generate Composer (CPD-1112)](https://aurafluxco.atlassian.net/wiki/spaces/CP/pages/39419905)
