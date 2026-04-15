# CWN Production — Full Environment Map
**Last updated:** 2026-04-15

---

## Visual Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   CWN PRODUCTION SYSTEM                                     │
│                              macOS local (M4 Pro) · localhost                               │
└─────────────────────────────────────────────────────────────────────────────────────────────┘

 OPERATOR (Rob)
      │
      ▼
┌─────────────────────────────────────────────────────────────────┐
│           DASHBOARD  cwn_production.html                        │
│           Python static file server · port 8765                 │
│                                                                 │
│  [Generate Script]  [Send to HeyGen]  [Assemble]  [Publish]     │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP REST
                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                          NODE.JS API SERVER  server.js · port 3000                          │
│                          Express 4 · Helmet · CORS · express-validator                      │
│                                                                                             │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────┐   ┌───────────────────────────┐    │
│  │  STAGE 1    │   │   STAGE 2    │   │   STAGE 3    │   │        STAGE 4            │    │
│  │   Script    │──▶│    HeyGen    │──▶│   Assembly   │──▶│       Publish             │    │
│  │ Generation  │   │   Render     │   │   FFmpeg     │   │    Upload-Post            │    │
│  └─────────────┘   └──────────────┘   └──────────────┘   └───────────────────────────┘    │
│        │                  │                  │                        │                     │
│    Gate 1 QA          Gate 2 QA          Gate 3 QA               Gate 4                    │
│   Claude ≥90         Gemini ≥85         Gemini ≥70              job_id                     │
│                                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│  │  INTERNAL LIBRARIES  /lib/                                                           │  │
│  │  config.js · metrics.js · error_logger.js · validation.js · directives.js           │  │
│  │  chromeDirectives.js · clients/heygen · twitch · gemini · jira · confluence         │  │
│  └──────────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┬──────────────────────────────────────┘
                                                       │
              ┌────────────────────────────────────────┼────────────────────────────────┐
              │                                        │                                │
              ▼                                        ▼                                ▼
┌─────────────────────────┐          ┌────────────────────────────┐    ┌───────────────────────┐
│  VECTCUT API  port 9001  │          │   GOOGLE DRIVE             │    │  UPLOAD-POST          │
│  Python FastAPI          │          │   googleapis (OAuth2)      │    │  api.upload-post.com  │
│  CapCut SDK              │          │   Auto-upload after Gate 3 │    │  YouTube              │
│  Split-screen assembly   │          │   Drive folder: CWN Videos │    │  TikTok               │
│  OpenCV · FFmpeg-python  │          │                            │    │  Instagram            │
│  Pillow · numpy          │          └────────────────────────────┘    │  Threads              │
└─────────────────────────┘                                             │  Facebook · X         │
                                                                        └───────────────────────┘

 EXTERNAL AI / API PROVIDERS
 ────────────────────────────────────────────────────────────────────────────────────────────

 ┌─────────────────────────┐   ┌──────────────────────────────┐   ┌───────────────────────┐
 │  ANTHROPIC              │   │  GOOGLE (GEMINI)             │   │  HEYGEN               │
 │  Claude Sonnet 4.6      │   │  Gemini 2.5 Flash            │   │  Avatar rendering      │
 │  Gate 1 script QA       │   │  Script generation           │   │  api.heygen.com        │
 │  Publish copy gen        │   │  Gate 2 HeyGen QA            │   │  2 avatar IDs:         │
 │  api.anthropic.com      │   │  Gate 3 assembly QA          │   │  16:9 (long-form)      │
 │                         │   │  Style guide learning        │   │  9:16 (shorts)         │
 └─────────────────────────┘   └──────────────────────────────┘   └───────────────────────┘

 ┌─────────────────────────┐   ┌──────────────────────────────┐   ┌───────────────────────┐
 │  TWITCH                 │   │  ATLASSIAN                   │   │  OPTIONAL SERVICES    │
 │  GQL API                │   │  Jira (CPD project)          │   │  Canva Connect API    │
 │  Clip resolution         │   │  Confluence (CP space)       │   │  Topaz Labs (upscale) │
 │  CDN MP4 URLs            │   │  Issue tracking              │   │  Fin. Modeling Prep   │
 │  TWITCH_CLIENT_ID        │   │  Docs / wiki                 │   │  (stock ticker data)  │
 │  TWITCH_TOKEN            │   │                              │   │                       │
 └─────────────────────────┘   └──────────────────────────────┘   └───────────────────────┘

 LOCAL TOOLS (no API — binaries / browser automation)
 ────────────────────────────────────────────────────────────────────────────────────────────

 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
 │   FFMPEG     │  │  FFPROBE     │  │  PUPPETEER   │  │  NODE CANVAS │  │  CHEERIO     │
 │  Video enc.  │  │  Metadata    │  │  Chromium    │  │  Cairo/PNG   │  │  HTML parser │
 │  Concat      │  │  Duration    │  │  Ticker PNG  │  │  Intro cards │  │  OG image    │
 │  Normalize   │  │  Resolution  │  │  1-hr cache  │  │  TV overlay  │  │  scraping    │
 │  Overlay     │  │  Bitrate     │  │              │  │              │  │              │
 └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘

 CONTENT SOURCES (scraped / resolved at runtime — no persistent auth)
 ────────────────────────────────────────────────────────────────────────────────────────────

 ┌─────────────────┐   ┌─────────────────┐   ┌───────────────────────────────────────────┐
 │  TWITCH CDN     │   │  ESPN / NBA.com  │   │  NEWS SITES (Al Jazeera, AP, Reuters...) │
 │  clip MP4 URLs  │   │  highlight clips │   │  RSS feeds + og:image scrape              │
 │  expire ~1hr    │   │  game thumbnails │   │  Article hero images for overlays         │
 └─────────────────┘   └─────────────────┘   └───────────────────────────────────────────┘
```

---

## Full Component Definitions

### What We Built Ourselves

#### `server.js` — The Production Engine
12,000+ line Node.js file. Every pipeline stage lives here: script generation, HeyGen polling, assembly, QA gates, publishing, job persistence, cleanup, metrics. Split into logical sections but intentionally one file for operational simplicity. Handles all REST endpoints at port 3000.

#### `cwn_production.html` — The Operator Dashboard
Single-page app served at port 8765. No framework — vanilla HTML/CSS/JS. Contains all production controls: script generation, HeyGen send, assembly trigger, job queue, rollback/force-advance, publish, segment viewer. Communicates with server.js via fetch() calls.

#### `tools/clipzworld_newscast.html` — The Chrome Renderer
Loaded by Puppeteer to generate overlay PNGs: ticker bar, story sidebar, lower-third flag, "NOW COVERING" segment tag. Puppeteer screenshotters it at 1920×1080 and the resulting PNGs get baked into the video via FFmpeg overlay filters.

#### `VectCutAPI/capcut_server.py` — Video Editing Microservice
Python FastAPI server on port 9001. Wraps the CapCut cloud editing SDK (VectCut). Handles split-screen short-form layout (source clip top, Bobby G avatar bottom), intro card positioning, multi-track layer composition. Node.js calls it via HTTP from server.js.

#### `/lib/` — Internal Library Modules

| File | What it does |
|------|------|
| `config.js` | All CONFIG constants (intro card size, dissolve duration, Gemini file size limit, ticker TTL, logo position, etc.) |
| `metrics.js` | `StageTimer` class — tracks wall time + custom data for every pipeline stage. Saves `run_metrics_{jobId}.json` |
| `error_logger.js` | Writes structured JSON to `logs/errors.jsonl`. Survives server restarts. Rate-limited to prevent log spam |
| `validation.js` | Request input validation and sanitization middleware (URL check, array length, string sanitize) |
| `directives.js` | Reads/writes per-scene chrome directives from `data/directives/{jobId}.json` (the "directive sidecar") |
| `chromeDirectives.js` | Zod schema for chrome directives: flag, sidebar, ticker, logo, tvCard fields. `directiveToOverlayParams()` maps directive → FFmpeg overlay options |
| `clients/heygen_client.js` | HeyGen API wrapper with retry logic, rate limiting, exponential backoff |
| `clients/twitch_client.js` | Twitch GQL API — resolves clip slugs to signed CDN MP4 URLs |
| `clients/gemini_client.js` | Gemini API wrapper (file upload, prompt, structured output) |
| `clients/jira_client.js` | Atlassian Jira REST client (issue creation, JQL search, health check) |
| `clients/confluence_client.js` | Atlassian Confluence REST client (page creation, space management) |

#### `data/jobs.json` — Job State Persistence
Runtime JSON file loaded into memory at startup. Every job card (script, HeyGen video IDs, assembly status, drive URL, publish record) is written here on every state change. Pruned to 7 days. Never committed to git.

#### `logs/errors.jsonl` — Persistent Error Log
Newline-delimited JSON. Every error path in the pipeline (assembly crash, disk fail, pre-flight fail, validation error) writes a structured entry here via `logError()`. Survives server restarts.

#### `streamers.json` — Streamer Roster
Static config for all Twitch streamers: display name, origin city, fun fact, profile image URL, phonetic pronunciation notes. Loaded at startup, used for intro card generation and script generation prompts.

#### `cwn_style_guides.json` — AI Style Memory
Gemini-learned style fingerprints per content type (twitch/nba/news). Updated via `POST /analyze-style-library`. Used to inject content-type-specific writing style into the Gemini script generation prompt.

---

### External APIs & Services

#### Anthropic — Claude Sonnet 4.6
**What it does:** Reviews Gemini's generated scripts (Gate 1 QA), generates platform-specific publish copy (title, description, hashtags, YouTube chapters, pinned comment).
**Not** the script writer — Gemini writes, Claude reviews.
**Auth:** `ANTHROPIC_API_KEY`
**SDK:** `@anthropic-ai/sdk` v0.39.0
**Endpoint:** `api.anthropic.com`

#### Google — Gemini 2.5 Flash
**What it does:** The primary creative engine. Generates full scripts by watching video clips (Twitch CDN URLs), analyzing game thumbnails (NBA), and reading news articles (news). Also runs Gate 2 (HeyGen segment QA) and Gate 3 (assembly QA) by watching the actual video output. Learns and stores style guides per content type.
**Auth:** `GEMINI_API_KEY`
**SDK:** `@google/generative-ai` via direct REST calls
**Endpoint:** `generativelanguage.googleapis.com`

#### HeyGen
**What it does:** Renders AI avatar video segments from script text. Bobby G (the avatar) reads each script segment and lip-syncs to the voice. Returns MP4 segment URLs. Pipeline sends ~42 segments per long-form episode, polls until all are `COMPLETED`.
**Auth:** `HEYGEN_API_KEY`
**Avatars:** 2 — landscape 16:9 for long-form (`842f20b75ce242aea397f5030aa018aa`), portrait 9:16 for shorts
**Voice:** `2e598f1a6022448cb6710e5d44665325` at 0.85x speed (long-form) / 0.95x (shorts)
**Endpoint:** `api.heygen.com`

#### Google Drive (googleapis)
**What it does:** Final video archive. After Gate 3 QA passes, the assembled MP4 is uploaded to a designated Drive folder. The returned `uc?export=download` URL is what Upload-Post uses to pull the video for platform publishing.
**Auth:** OAuth2 refresh token (`DRIVE_REFRESH_TOKEN`) — one-time setup via `node cwn-auth.js`
**SDK:** `googleapis` v171.4.0 (Drive v3)

#### Upload-Post
**What it does:** Single API call publishes to up to 6 platforms simultaneously. Takes a Google Drive URL, title, description, tags, privacy setting, and platform-specific metadata. Returns a `request_id` for async status polling. Handles all platform auth on their side.
**Auth:** `UPLOADPOST_API_KEY` (JWT token)
**Endpoint:** `https://api.upload-post.com/api/upload`
**Platforms:** YouTube, TikTok, Instagram Reels, Threads, Facebook, X (Twitter)
**Cost:** $50/month flat (unlimited uploads)

#### Twitch (GQL API)
**What it does:** Resolves clip slugs to signed CDN MP4 URLs. Twitch clips have a short slug (e.g. `AbundantWildEmuPanicVis`) — the GQL API exchanges that for a signed `https://production.assets.clips.twitchsvc.net/...?sig=...&token=...` URL that FFmpeg can download directly.
**Auth:** `TWITCH_CLIENT_ID` + `TWITCH_TOKEN`
**Expiry:** CDN URLs expire ~1 hour — always re-resolved at assembly time, not script time

#### Atlassian Jira + Confluence
**What it does:** Issue tracking (Jira project `CPD`) and documentation (Confluence space `CP`). Aider (overnight agent) creates and triages tickets, enriches issues with spec links, generates docs from resolved issues. Not in the live content pipeline — strictly operational tooling.
**Auth:** `ATLASSIAN_DOMAIN`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`

---

### Local Binaries & Tools (No API Cost)

#### FFmpeg + FFprobe
The video production workhorse. Every video operation goes through FFmpeg: normalizing segment audio levels, concatenating avatar segments with source clips, overlaying the ticker and logo, applying crossfades, zooming clips to fill, baking chrome. FFprobe probes metadata (duration, resolution, bitrate) before and after each step.
Uses `execFile()` (not `exec()`) throughout to prevent command injection. Platform-aware encoder: `h264_videotoolbox` on macOS (hardware, ~5x faster), `libx264 ultrafast` on Linux/Railway.

#### Puppeteer (Chromium)
Headless browser that screenshots `tools/clipzworld_newscast.html` at 1920×1080 to produce overlay PNGs. The ticker (scrolling news text at the bottom) is rendered here — not generated in Canvas — because it uses CSS animations and web fonts. Cached for 1 hour to avoid re-rendering every job.

#### Node Canvas (node-canvas / Cairo)
Server-side canvas renderer. Draws the intro card PNGs: TV-rectangle shape with gold border, profile image, name, origin, and fun fact text. All 3 content types use the same 640×360 TV-rectangle design. Requires native Cairo graphics library installed on the system.

#### Cheerio
jQuery-like HTML parser. Used during News script generation to scrape Open Graph metadata (`og:image`, `og:title`, `article:published_time`) from news article URLs, so Gemini gets article hero images and metadata without running a full browser.

---

### Content Sources (No Auth — Scraped at Runtime)

| Source | Content type | How accessed | Expiry |
|--------|-------------|-------------|--------|
| Twitch CDN (`production.assets.clips.twitchsvc.net`) | Twitch clips | Resolved via GQL API | ~1 hour |
| ESPN / NBA.com | NBA highlights | URL-based scrape + thumbnail analysis | Same-day |
| Al Jazeera, AP, Reuters, etc. | News clips + images | RSS feed + Cheerio og:image scrape | Same-day |

---

### Dev & Runtime Tools

| Tool | Purpose |
|------|---------|
| **nodemon** | Watches server.js and restarts automatically on file save. Standard dev loop. |
| **dotenv** | Loads `.env` at startup. Required API keys validated before server accepts requests. |
| **ESLint** | Linting (configured but not enforced in CI — no CI pipeline yet) |
| **Playwright** | Browser automation for cross-browser QA testing (in deps, not in active pipeline) |
| **python3 -m http.server** | Serves the dashboard HTML at port 8765. No Node dependency — pure Python stdlib. |

---

## Pipeline Flow (End to End)

```
Rob clicks "Generate Script"
        │
        ▼
  /generate-full-script
        │
        ├─ [news]  RSS feed + Cheerio scrape article images
        ├─ [nba]   ESPN highlight URLs + game thumbnails
        └─ [twitch] Twitch GQL resolves clip slugs → CDN URLs
        │
        ▼
  Gemini 2.5 Flash
  ├─ Watches clips / analyzes thumbnails / reads articles
  └─ Writes full script (72+ scenes for Twitch, ~22 for News/NBA)
        │
        ▼
  Claude Sonnet 4.6 — Gate 1 QA
  ├─ ≥90: auto-proceed
  ├─ 70-89: Rob reviews
  └─ <70: hard fail, regenerate
        │
        ▼
  Rob clicks "Send to HeyGen" (or auto-advance)
        │
        ▼
  /heygen-send (per segment)
  └─ HeyGen API: text → avatar video
        │
        ▼
  HeyGen poller (per segment, ~8.5s avg)
  └─ GET /heygen-status/:videoId until COMPLETED
        │
        ▼
  Gemini 2.5 Flash — Gate 2 QA (samples 3 segments)
  ├─ ≥85: auto-proceed
  └─ <65: flag for Rob
        │
        ▼
  Rob clicks "Assemble" (or auto-advance after Gate 2)
        │
        ▼
  /assemble
  ├─ Download all HeyGen segments (SSRF-protected, domain whitelist)
  ├─ Re-resolve Twitch CDN URLs (expired since script gen)
  ├─ Node Canvas → intro card PNGs (640×360 TV-rectangle)
  ├─ Puppeteer → ticker PNG (1920×1080 bottom bar, 1hr cache)
  ├─ FFmpeg normalize: each segment → 1920×1080, 44.1kHz stereo
  │   macOS: h264_videotoolbox (hardware)
  │   Linux: libx264 ultrafast
  ├─ FFmpeg concat: avatar segs + source clips + intro card overlays
  ├─ FFmpeg ticker bake: overlay ticker PNG on full assembled file
  └─ FFmpeg crossfades between segments
        │
        ▼
  Gemini 2.5 Flash — Gate 3 QA (watches assembled video)
  ├─ ≥70: auto-proceed to Drive + publish
  ├─ 60-69: Rob reviews
  └─ <60: hard fail
        │
        ▼
  Google Drive upload (googleapis)
  └─ Returns https://drive.google.com/uc?export=download&id=...
        │
        ▼
  Claude Sonnet 4.6 — Generate publish copy
  └─ Title (60 chars), description, hashtags, chapters, pinned comment
        │
        ▼
  Upload-Post API
  └─ Publishes to YouTube (private) + TikTok + Instagram Reels
        │
        ▼
  Rob reviews private YouTube draft → flips to public
```

---

## Cost Summary (Current Production Volume: 60 long-form + 180 shorts/month)

| Service | Cost Model | Monthly Est. |
|---------|-----------|-------------|
| HeyGen | ~$0.038/segment × avg 42 segments = ~$1.60/video | ~$96 (60 long-form) |
| Anthropic (Claude) | ~$0.05/job (script QA + publish copy) | ~$12 |
| Google Gemini | ~$0.02/job (3 gates) | ~$5 |
| Google Drive | Free tier (15GB) | $0 |
| Upload-Post | Flat rate | $50 |
| Twitch API | Free | $0 |
| Atlassian | Existing plan | existing |
| **Total** | | **~$163/month** |

---

## Environment Variables Reference

```bash
# AI / ML
ANTHROPIC_API_KEY=          # Claude Sonnet — Gate 1 QA, publish copy
GEMINI_API_KEY=             # Gemini 2.5 Flash — script gen, Gate 2, Gate 3

# Avatar
HEYGEN_API_KEY=             # Avatar rendering
HEYGEN_AVATAR_ID=           # 16:9 long-form avatar ID
HEYGEN_AVATAR_SHORT_ID=     # 9:16 portrait avatar ID
HEYGEN_VOICE_ID=            # "cw" voice ID
HEYGEN_SPEAK_SPEED=         # 0.85 (long) / 0.95 (shorts)

# Clip sources
TWITCH_CLIENT_ID=           # Clip GQL resolution
TWITCH_TOKEN=               # GQL auth

# Storage & publishing
DRIVE_FOLDER_ID=            # Google Drive target folder
DRIVE_REFRESH_TOKEN=        # OAuth2 refresh (run cwn-auth.js once)
UPLOADPOST_API_KEY=         # Upload-Post JWT
UPLOADPOST_PROFILE=         # Upload-Post account username

# Pipeline controls
AUTO_PUBLISH_PLATFORMS=     # youtube,tiktok,instagram (comma-separated)
SKIP_AUTO_PUBLISH=          # true = hold at Drive, don't fire Gate 6

# Optional
TOPAZLABS_API_KEY=          # Video upscaling
CANVA_CLIENT_ID=            # Thumbnail template generation
CANVA_CLIENT_SECRET=
FMP_API_KEY=                # Stock ticker data
VECTCUT_API_URL=            # http://localhost:9001

# Logo/branding
SHORT_FORM_LOGO_SIZE=       # 80px
SHORT_FORM_AUDIO_MIX=       # both / source_only / avatar_only

# Atlassian
ATLASSIAN_DOMAIN=           # yourworkspace.atlassian.net
ATLASSIAN_EMAIL=
ATLASSIAN_API_TOKEN=
JIRA_PROJECT_KEY=           # CPD
CONFLUENCE_SPACE_KEY=       # CP
```
