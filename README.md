# cwn-production
CWN Production
# CWN Production — ClipzWorld News
**Channel:** [@clipznashite](https://youtube.com/@clipznashite) · **Host:** Bobby G · **Brand:** Navy `#22304b` / Gold `#c7af4f`

> **Full production manual:** [CWN_Production_Manual.html](file:///Users/robertgregory/Downloads/CWN_Production_Manual.html)

---

## Quick Start — 3 Terminals Required

```bash
# Terminal 1 — Static file server (dashboard)
cd ~/cwn-production && python3 -m http.server 8765

# Terminal 2 — Node API server (auto-restarts on save)
cd ~/cwn-production && nodemon server.js

# Terminal 3 — CapCut MCP
cd ~/Downloads/VectCutAPI && source venv-capcut/bin/activate && python capcut_server.py
```

Dashboard: [http://localhost:8765/cwn_production.html](http://localhost:8765/cwn_production.html)

---

## Deploy Workflow

```bash
cd ~/cwn-production
git add -A
git commit -m "your message"
git push
# nodemon auto-restarts — no manual step needed
```

---

## Architecture

```
cwn_production.html   ← Dashboard UI (port 8765, static)
server.js             ← Node.js API (port 3000)
streamers.json        ← Streamer roster + card text
cwn_style_guides.json ← Bobby G style + production learning log
.env                  ← All API keys (never committed)
output/               ← Assembled MP4s + thumbs
tmp/                  ← Segments, intro cards, gate samples (auto-cleaned)
```

---

## Content Types & Dimensions

| Content Type | Form | Platform | Aspect | Avatar |
|---|---|---|---|---|
| Twitch Clips | Compilation | YouTube | 16:9 | `19c1d4adf890...` |
| NBA Highlights | Compilation | YouTube | 16:9 | `19c1d4adf890...` |
| News Reaction | Compilation | YouTube | 16:9 | `19c1d4adf890...` |
| Any type | Short | TikTok / Reels / Shorts | 9:16 | `ed57439c9c3d...` |

**Voice ID:** `2e598f1a6022448cb6710e5d44665325` ("cw")  
**Speed:** 0.85 (compilations) · 0.95 (shorts/reactions)

---

## Production Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│  1. SCRIPT GENERATION                                            │
│     Dashboard → Content Type → Streamers/Topic → Generate       │
│     Claude writes Bobby G script (Jon Stewart + Norm Mac style)  │
│                                                                   │
│  ▼ GATE 1: Script QA (Gemini) ≥90=auto / 70-89=manual / <70=fail│
│                                                                   │
│  2. HEYGEN RENDER                                                 │
│     Segments queued → HeyGen renders Bobby G avatar              │
│     16:9 or 9:16 based on form type                              │
│                                                                   │
│  ▼ GATE 2: Segment QA (Gemini samples 3 segments) ≥85=auto      │
│                                                                   │
│  3. ASSEMBLY                                                      │
│     FFmpeg: normalize → intro cards → clips → ticker bake        │
│     Node Canvas: intro card PNG (circle, gold ring, 3 lines)     │
│     Ticker: baked into video (80px/sec, 24 stocks + 10 indices)  │
│                                                                   │
│  ▼ GATE 3: Assembly QA (Gemini watches assembled video) ≥70=auto │
│                                                                   │
│  4. POST-ASSEMBLY LEARNING                                        │
│     Gemini watches 60s → extracts 6 insights → cwn_style_guides  │
│                                                                   │
│  5. PUBLISH PREP                                                  │
│     Generate title / description / hashtags / pinned comment     │
│     Canva thumbnail auto-generated (Option 3 or 4 template)      │
│     Upload-Post → YouTube / TikTok / Instagram                   │
│                                                                   │
│  ▼ GATE 4: Confirm job_id received from Upload-Post              │
└─────────────────────────────────────────────────────────────────┘
```

---

## QA Gates

| Gate | What | Tool | Pass | Manual | Fail |
|---|---|---|---|---|---|
| 1 | Script quality | Gemini | ≥90 | 70–89 | <70 |
| 2 | HeyGen segment QA | Gemini (3 samples) | ≥85 | 65–84 | <65 |
| 3 | Assembly QA | Gemini (watches video) | ≥70 | 60–69 | <60 |
| 4 | Publish confirm | Upload-Post API | job_id received | — | no job_id |

**Gate 2 checks:** lip sync, audio presence, rendering artifacts, motion quality  
**Gate 3 checks:** pacing, transitions, audio levels, visual consistency, overall broadcast readiness  
**QA logs:** stored locally at `output/qa_failures/` — NOT uploaded to Drive

---

## API Keys (`.env`)

```
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
HEYGEN_API_KEY=          # pay-as-you-go, ~$0.038/segment avg 8.5s
TWITCH_CLIENT_ID=
TWITCH_CLIENT_TOKEN=     # hardcoded in twitch tool for OBS Browser Source
DRIVE_FOLDER_ID=         # Videos go here
DRIVE_CLIENT_ID=
DRIVE_CLIENT_SECRET=
DRIVE_REFRESH_TOKEN=
UPLOADPOST_API_KEY=      # Professional $50/mo, profile=clipznashite
PORT=3000
DASHBOARD_PORT=8765
```

---

## API Endpoints

### Script Generation
| Endpoint | Method | Body |
|---|---|---|
| `/generate-script` | POST | `{ contentType, formType, streamers[], topic }` |

`contentType`: `twitch` · `nba` · `news`  
`formType`: `compilation` · `short`

### HeyGen
| Endpoint | Method | Notes |
|---|---|---|
| `/heygen-generate` | POST | Queue segment for rendering |
| `/heygen-status/:videoId` | GET | Poll render status |

### Assembly
| Endpoint | Method | Notes |
|---|---|---|
| `/start-assembly` | POST | `{ asmId, segments[], contentType, formType }` |
| `/assembly-status/:asmId` | GET | Progress + gate results |

### Gate QA
| Endpoint | Method | Notes |
|---|---|---|
| `/gate1-script-qa` | POST | Script review before HeyGen |
| `/gate2-segment-qa` | POST | Samples first/middle/last segment |
| `/gate3-assembly-qa` | POST | Reviews assembled video |

### Publish
| Endpoint | Method | Notes |
|---|---|---|
| `/generate-publish-copy` | POST | Title, description, hashtags via Claude |
| `/generate-thumbnail` | POST | Auto-fills Canva template |
| `/publish` | POST | Sends to Upload-Post API |

### Utility
| Endpoint | Method | Notes |
|---|---|---|
| `/cleanup` | POST | `{ keepCount, cleanTmp, cleanQaLogs }` |
| `/disk-usage` | GET | Report current disk use |
| `/burn-streamer-intro` | POST | Test intro card for one streamer |

---

## Streamer Roster (`streamers.json`)

| Key | Display | Origin | Card Fact |
|---|---|---|---|
| jasontheween | Jason | Arlington | Dep Gai guy |
| hasanabi | Hasan | NB/Istanbul | Hank Pecker bestie |
| adapt | Adapt | Phoenix | Never faked a trickshot |
| stableronaldo | Ron | Cherry Hill | At least he's stable |
| lacy | Lacy | Erie | Married to Drew |
| marlon | Marlon | Malmö | Fooled the Internet |
| cinna | Cinna | VA | Rosi's Contract Extended....Again |
| yonnajay | Yonna | Brevard | Number one roaster |
| jaycinco | Jay Cinco | Watts | Retired his jersey |
| maya | Maya | NorCal | The Gen Z Jane Goodall |
| extraemily | Emily | Omaha | Engaged to Maya |

---

## Intro Card Design (Node Canvas)

- **Shape:** Circle, 160px radius, gold ring (#c7af4f), drop shadow
- **Profile image:** 300px Twitch CDN URL, clipped to circle
- **Line 1:** Streamer name — 68pt gold (#c7af4f), bold
- **Line 2:** Origin — 44pt white, normal
- **Line 3:** Fact — 36pt grey (#aaaaaa), italic
- **Position:** Top-right, `x=1460 y=40` (16:9 frame)
- **Duration:** First 3.5 seconds of each streamer segment
- **No background box** — floating circle on video

---

## Thumbnail Templates (Canva)

| Option | Design ID | URL |
|---|---|---|
| 3 — Ghostly Bobby G Navy | `DAHGB0qZod4` | [Open in Canva](https://www.canva.com/d/4yOalMvJrkVO1wD) |
| 4 — Eerie Bobby G + Streamer Circles | `DAHGB-hGwds` | [Open in Canva](https://www.canva.com/d/lnXWvdOkQW6DPSF) |

Auto-fill: `/generate-thumbnail` uploads streamer profile images, hook line, and date automatically.

---

## Market Ticker

- **Stocks:** 24 symbols (US large caps + crypto)
- **Indices:** 10 global (S&P, DOW, NASDAQ, FTSE, DAX, Nikkei, etc.)
- **Speed:** 80px/sec via `requestAnimationFrame` delta timing (OBS-compatible)
- **Data:** FMP API (Financial Modeling Prep)
- **Location:** `http://localhost:8765/` (also serves as OBS Browser Source)
- **Ticker baked into video** during assembly (not a live overlay in final MP4)

---

## Platform Publishing

| Platform | Format | Privacy | Notes |
|---|---|---|---|
| YouTube | MP4 16:9 or 9:16 | Public | Thumbnail + pinned comment |
| TikTok | MP4 9:16 | Public (DIRECT_POST) | |
| Instagram Reels | MP4 9:16 | Public | |

**Upload-Post profile:** `clipznashite`  
**Thumbnail:** extracted at 15s mark by FFmpeg, stored as `_thumb.jpg`

---

## Disk Management

Assembled MP4s are ~500MB each. Use **Settings → Disk Cleanup** in dashboard or:

```bash
# Keep 2 most recent, clean tmp, don't touch QA logs
curl -X POST http://localhost:3000/cleanup \
  -H "Content-Type: application/json" \
  -d '{"keepCount":2,"cleanTmp":true,"cleanQaLogs":false}'
```

Everything published is backed up to Google Drive before cleanup.

---

## Cost Model

| Item | Rate | Monthly (60 long + 180 shorts) |
|---|---|---|
| HeyGen segments | ~$0.038/seg avg 8.5s | ~$311 |
| Upload-Post | $50/mo Professional | $50 |
| FMP API | included | $0 |
| Anthropic/Gemini | pay-per-use | ~$20 est |
| **Total est.** | | **~$381/mo** |

---

## Bobby G Script Style

Three reference shows (in order of influence):

1. **Jon Stewart / Daily Show** — flat delivery + one devastating observation + immediate pivot
2. **Norm MacDonald Weekend Update** — short sentences, `[beat]` pauses, NEVER explain the joke
3. **Space Ghost Coast to Coast** — non-sequitur cold opens, confident self-contradiction

`[beat]` serves dual purpose: delivery pause guide AND HeyGen segment edit point.

**Always ends with:** *"I'm Bobby G. See you tomorrow."*

---

## Known Issues / Pending

- [ ] Intro card position top-right — verify `x=1460 y=40` lands correctly after next assembly
- [ ] Jay Cinco sometimes gets 2 clips instead of 3 (one clip expired on Twitch)
- [ ] Bobby G photo swap in Canva thumbnail (hooded silhouette → actual photo)
- [ ] Gate 2 detail output was truncated — fixed in latest commit (verify next run)
- [ ] CapCut headless render not yet deployed to Railway (runs locally only)

---

## File Reference

```
cwn-production/
├── server.js                  Main Node.js API
├── cwn_production.html        Dashboard UI
├── streamers.json             Streamer roster + card data
├── cwn_style_guides.json      Bobby G style + Gemini learning log
├── package.json               Node deps (express, canvas, axios, etc.)
├── .env                       API keys (gitignored)
├── output/                    Final MP4s + thumbnails
│   └── qa_failures/           Gate failure logs (local only)
└── tmp/                       Working files (auto-cleaned)
    ├── cwn_font.ttf            Font for ticker/overlays
    └── profile_*.png           Cached Twitch profile images
```

---

*Last updated: April 6, 2026 — Session 4*
