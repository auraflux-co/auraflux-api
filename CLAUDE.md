# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Environment Setup

**4 terminals required:**

```bash
# Terminal 1 — Static file server (dashboard at localhost:8765)
cd ~/cwn-production && python3 -m http.server 8765

# Terminal 2 — Node API server (auto-restarts via nodemon)
cd ~/cwn-production && nodemon server.js

# Terminal 3 — VectCut API server (port 9001, for video editing)
cd ~/cwn-production/VectCutAPI && ./venv-capcut/bin/python3 capcut_server.py

# Terminal 4 — Dashboard monitor (optional, for real-time logs)
cd ~/cwn-production && tail -f output/*.log
```

**Dashboard:** http://localhost:8765/cwn_production.html
**API:** http://localhost:3000
**VectCut API:** http://localhost:9001

**Note:** VectCut API is required for NBA/News intro card generation and short-form split-screen assembly

## Core Architecture

### Multi-Stage Production Pipeline

ClipzWorld News (CWN) is an AI-generated news/reaction show using Claude (script), Gemini (QA), and HeyGen (avatar). The production pipeline has 4 stages with 4 quality gates:

```
Script Gen → Gate 1 (≥90) → HeyGen Render → Gate 2 (≥85) → Assembly → Gate 3 (≥70) → Publish → Gate 4 (job_id)
```

**Key files:**
- `server.js` — Node.js API (6000+ lines, all endpoints)
- `cwn_production.html` — Dashboard UI (all production controls)
- `streamers.json` — Streamer roster with intro card data
- `cwn_style_guides.json` — Gemini-learned style fingerprints per content type
- `IMPLEMENTATION_SPEC.md` — Technical spec for missing features (NBA/News cards, short-form layout)
- `VectCutAPI/` — Python-based video editing API server (port 9001)

### Content Types & Forms

**3 content types:** `twitch` (Twitch clips), `nba` (NBA highlights), `news` (world news)
**2 form types:** `compilation` (long-form 16:9, 5-10min) or `short` (9:16, 45-60sec)

**Avatar IDs:**
- 16:9 compilations: `19c1d4adf890...`
- 9:16 shorts: `ed57439c9c3d...`

**Voice:** ID `2e598f1a6022448cb6710e5d44665325` ("cw") at 0.85 speed (compilations) or 0.95 speed (shorts)

### Script Generation (`/generate-full-script`)

**CRITICAL ROLE SWAP (as of April 2026):**
1. **Gemini analyzes all clips/games** — watches video with audio when available (Twitch CDN URLs, ESPN highlights), falls back to thumbnail analysis
2. **Gemini writes complete script** — uses `geminiScriptGeneration()` with style guides from `cwn_style_guides.json`
3. **Gate 1 QA (Claude)** — reviews Gemini's script via `claudeScriptQA()`, checks for placeholders, name errors, clip-to-streamer mismatches, scene count accuracy
4. **Returns:** `script`, `orderedClipUrls[]`, `scriptQA` results

**Why the swap:** Claude was generating only 11 scenes instead of 72 for Twitch content. Gemini now generates, Claude reviews.

**Critical implementation details:**
- Global Anthropic client initialized at `server.js:106` (required for Claude QA)
- `claudeScriptQA()` function at `server.js:1522-1728` performs Gate 1 review
- `geminiScriptGeneration()` function at `server.js:1437-1520` generates scripts with style guide integration
- Style guides loaded from `cwn_style_guides.json` per content type
- Expected scene count calculated: Twitch = `1 + (streamers × 7) + 1`, NBA/News = `1 + (items × 4) + 1`
- Gate 1 score ≥90 = auto-proceed to HeyGen, 70-89 = manual review, <70 = hard fail
- QA reports saved with "Scored by: Claude (did not write the script)" notation

**RECENT FIX (April 8, 2026):** Gemini was also generating incorrect scene counts (65 instead of 72). Enhanced both system and user prompts with:
- Explicit mathematical breakdown: "1 INTRO + (10 streamers × 7 scenes) + 1 OUTRO = 72 total"
- Examples showing scene structure per streamer
- Final validation reminder to count `=== HEADER ===` markers before submitting
- Emphasized "DO NOT COMBINE" and "DO NOT SKIP" for each header
- See `server.js:4594-4605` (system prompt) and `server.js:5460-5473` (user prompt)

### HeyGen Rendering (Frontend-driven)

Dashboard sends each script segment to HeyGen API individually. Frontend polls `/heygen-status/:videoId` until `COMPLETED`, then logs metrics via `/log-heygen-metrics` (new endpoint tracking total segments, avg render time, retries).

**Critical:** HeyGen segments contain `[CLIP PLAYS HERE]` markers — assembly must replace these with actual source clips at correct positions.

### Assembly Pipeline (`/assemble`)

**Inputs:** `{ asmId, segments[], contentType, formType, clipUrls[], title }`

**Process:**
1. **Gate 2 QA** — samples first/middle/last HeyGen segments, checks lip sync, audio, rendering quality
2. **Download segments** — uses cached files when possible, validates file size (≥100KB min)
3. **Intro cards** — Node Canvas renders circle profile image + 3 text lines for Twitch compilations
4. **FFmpeg assembly:**
   - Normalize audio levels
   - Build concat list (avatar segments + source clips in order)
   - Insert intro cards as overlays at start of each streamer section
   - Bake ticker at bottom (cached for 1 hour via Puppeteer screenshot)
   - Apply crossfades between segments
5. **Gate 3 QA** — Gemini watches assembled video, checks pacing, transitions, freeze detection
6. **Auto-upload to Google Drive** — if Gate 3 passes (score ≥70)
7. **Save metrics** — writes `run_metrics_{asmId}.json` with per-stage timing

**Critical file operations:**
- Downloads use `downloadFile()` with SSRF protection (whitelisted domains only)
- Temp files auto-cleaned after 24 hours on server startup
- Assembly requires ~500MB disk overhead per job

### QA Gates (Gemini-powered)

All gates use `gemini-2.5-flash` with structured prompts + point deduction scoring:

| Gate | Stage | Pass | Manual | Fail | Checks |
|------|-------|------|--------|------|--------|
| 1 | Script | ≥90 | 70-89 | <70 | Placeholders, name errors, structure |
| 2 | HeyGen segs | ≥85 | 65-84 | <65 | Lip sync, audio, rendering artifacts |
| 3 | Assembly | ≥70 | 60-69 | <60 | Pacing, transitions, freeze detection |
| 4 | Publish | job_id | — | no job_id | Upload-Post confirmation |

**QA logs saved to:** `output/qa_failures/gate{N}_{outcome}_{timestamp}.txt` (local only, never uploaded)

### Metrics Tracking (NEW)

`StageTimer` class tracks performance for each pipeline stage:

```javascript
const timer = new StageTimer(jobId, 'Script Generation');
timer.addData('claudeTokens', 5420).addData('gate1Score', 95);
addStageMetrics(jobId, timer.end());
finalizeJobMetrics(jobId); // Saves to run_metrics_{jobId}.json
```

**Tracked metrics:**
- Script gen: Gemini calls, Claude tokens, Gate 1 score
- HeyGen: segment count, avg render time (via `/log-heygen-metrics` endpoint)
- Assembly: download time, normalize time, FFmpeg encode, Gate 2 score
- Publish: platform count, Upload-Post request_id, success/failure

All jobs produce `output/run_metrics_{jobId}.json` with per-stage wall time + totals.

## Publishing Workflow

### Title/Description Generation (`/generate-publish-copy`)

Claude generates:
- Title (60 chars max for YouTube)
- Description (platform-specific formatting)
- Hashtags (TikTok/Instagram)
- Pinned comment (YouTube)

Uses assembled video context + script content.

### Thumbnail Generation (`/generate-thumbnail`)

Auto-fills Canva templates (Option 3: `DAHGB0qZod4` or Option 4: `DAHGB-hGwds`):
- Uploads streamer profile images via Canva MCP
- Inserts hook line text
- Adds date overlay
- Returns design URL for manual export

### Multi-Platform Publish (`/publish`)

Single endpoint publishes to YouTube, TikTok, Instagram via Upload-Post API:

```javascript
{
  driveUrl: "https://drive.google.com/uc?export=download&id=...",
  platforms: ['youtube', 'tiktok', 'instagram'],
  title: "...",
  description: "...",
  contentType: 'long' | 'short',
  scheduledAt: null, // or ISO-8601 for scheduled publish
  metricsJobId: "script_twitch_123" // optional, links to metrics
}
```

Returns `request_id` (async) or `job_id` (scheduled). Frontend polls `/publish/status?request_id=X` for completion.

## Key Patterns & Conventions

### Error Handling

- **Command injection prevention:** Use `execFile()` instead of `exec()` for FFmpeg/FFprobe
- **SSRF protection:** `downloadFile()` validates URLs against trusted domain whitelist
- **File size validation:** Min 100KB, max 2GB for video segments
- **API error handling:** `callClaudeAPI()` wrapper provides detailed error messages for rate limits, auth failures, context length

### Security

- **Helmet middleware** enabled for security headers (CSP disabled for inline scripts, COEP disabled for embedded media)
- **CORS whitelist:** `localhost:8765`, `localhost:3000` (configurable via `ALLOWED_ORIGINS` env var)
- **Environment validation:** Server exits on startup if required API keys missing (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `HEYGEN_API_KEY`)
- **No hardcoded credentials:** All removed from `cwn-auth.js` and server code

### Performance Optimizations

- **Ticker caching:** 1-hour TTL, avoids Puppeteer re-render every job
- **Gemini upload retry:** 3 attempts with exponential backoff (2s, 4s, 8s)
- **Twitch token validation:** HEAD request before using stored CDN URLs (they expire ~1 hour)
- **Early download for high-expiry streamers:** Maya/Emily clips cached immediately after script gen (CDN tokens expire quickly)
- **Disk space pre-flight checks:** Validates free space before assembly (est. 20MB/segment + 500MB overhead)

### API Key Management

**Required in `.env`:**
```
ANTHROPIC_API_KEY=         # Claude Sonnet 4
GEMINI_API_KEY=            # Gemini 2.5 Flash
HEYGEN_API_KEY=            # Avatar rendering
HEYGEN_AVATAR_ID=          # Landscape avatar (16:9 compilations)
HEYGEN_AVATAR_SHORT_ID=    # Portrait avatar (9:16 shorts)
HEYGEN_VOICE_ID=           # Voice ID ("cw")
HEYGEN_SPEAK_SPEED=        # 0.85 for compilations, 0.95 for shorts
TWITCH_CLIENT_ID=          # Clip resolution
TWITCH_TOKEN=              # GQL API (formerly TWITCH_CLIENT_TOKEN)
DRIVE_FOLDER_ID=           # Google Drive folder for uploads
DRIVE_REFRESH_TOKEN=       # Run cwn-auth.js once to generate
UPLOADPOST_API_KEY=        # Multi-platform publish
UPLOADPOST_PROFILE=        # Upload-Post profile name
TOPAZLABS_API_KEY=         # Topaz Labs upscaling (optional)
CANVA_CLIENT_ID=           # Canva Connect API
CANVA_CLIENT_SECRET=       # Canva Connect API
```

**First-time Google Drive setup:**
```bash
node cwn-auth.js  # Opens browser, saves DRIVE_REFRESH_TOKEN to .env
```

## Common Operations

### Manual Cleanup

```bash
# Keep 2 most recent MP4s, clean tmp/, preserve QA logs
curl -X POST http://localhost:3000/cleanup \
  -H "Content-Type: application/json" \
  -d '{"keepCount":2,"cleanTmp":true,"cleanQaLogs":false}'
```

### Test Intro Card Rendering

```bash
curl -X POST http://localhost:3000/burn-streamer-intro \
  -H "Content-Type: application/json" \
  -d '{"streamer":"jasontheween"}'
# Returns PNG path in output/
```

### Check Disk Usage

```bash
curl http://localhost:3000/disk-usage
# Returns: { totalGB, usedGB, freeGB, outputDirGB, tmpDirGB }
```

### Verify CapCut MCP Health

```bash
curl http://localhost:3000/capcut/health
# Returns: { ok: true, capcut: 'online' } or 503 if offline
```

## Streamer Display Names

**Critical:** Bobby G ALWAYS uses display names (never Twitch usernames) in spoken text:

```javascript
const STREAMER_DISPLAY_NAMES = {
  'jasontheween': 'Jason',
  'hasanabi': 'Hasan',
  'stableronaldo': 'Ron',      // NOT "StableRonaldo"
  'yonnajay': 'Yonna',          // NOT "YonnaJay"
  'jaycinco': 'Jay Cinco',      // NOT "Jaycinco"
  // ... (see server.js line 431-465)
};
```

Use `getDisplayName(twitchUsername)` helper — it handles case-insensitive lookup and phonetic overrides (e.g., "Yawn-uh" for Yonna).

## Bobby G Script Voice Rules

Scripts follow **Jon Stewart + Norm MacDonald + Space Ghost** blend:

1. **Flat delivery** — never say "incredible", "amazing", "crazy", "wild"
2. **[beat] pauses** — used liberally for timing AND as HeyGen segment boundaries
3. **Short sentences** — state fact, observation, done
4. **Never explain the joke** — clip speaks for itself
5. **Non-sequitur cold opens allowed** — Space Ghost influence for chaotic tone
6. **Always end:** "I'm Bobby G. See you tomorrow." (compilations) or "Subscribe. Appreciate you." (shorts)

**Gate 1 will fail if:**
- Script contains placeholder brackets like `[YOUR OBSERVATION HERE]`
- Wrong name used (Twitch username instead of display name)
- Missing required sections (cold open, outro)
- Too short (< target word count for content type)

## Configuration Constants

**Magic numbers extracted to CONFIG object** (server.js:137-177):

```javascript
CONFIG.INTRO_CARD.CIRCLE_RADIUS = 160;    // Intro card circle size
CONFIG.TRANSITIONS.DISSOLVE_DURATION = 0.7;
CONFIG.GEMINI.MAX_FILE_SIZE = 34 * 1024 * 1024;  // 34MB upload limit
CONFIG.VIDEO.MIN_SEGMENT_SIZE = 100000;   // 100KB minimum valid video
CONFIG.TICKER.CACHE_TTL_MS = 3600000;     // 1 hour
```

Change these instead of hardcoding values throughout codebase.

## Testing & Deployment

**No formal test suite.** Production testing done via dashboard + manual QA review. Each stage validates via Gemini gates.

**Deploy:**
```bash
git add -A
git commit -m "your message"
git push
# nodemon auto-restarts server.js — no manual step
```

**Server runs on macOS** (Darwin). FFmpeg paths auto-detect Windows vs Unix. Cross-platform compatibility maintained for future Railway/cloud deployment.

## Known Gotchas

1. **HeyGen segment order matters** — `orderedClipUrls[]` from script gen must match segment insertion points exactly
2. **Twitch CDN URLs expire ~1 hour** — always re-resolve with `resolveTwitchClipMp4()` at assembly time, not script time
3. **Maya/Emily clips expire fastest** — use early download cache (`tmp/early_clips/`) to survive long HeyGen render times
4. **Gate 2 samples only 3 segments** — first, middle, last. Fast streamers get auto-pass even if some segments have minor issues
5. **Ticker baked into video** — not a live overlay. Cached for 1 hour to avoid Puppeteer re-render overhead
6. **Intro cards only for Twitch compilations** — NBA/news use resized game thumbnails (640×360 TV shape)
7. **`[CLIP PLAYS HERE]` is structural marker** — never spoken by avatar, replaced by source clip video during assembly
8. **Assembly timeout: 30 minutes** — jobs abort if FFmpeg hangs (network issues, corrupted segment)
9. **Logo overlay now on ALL long-form videos** — 120px CWN logo, top-right at `W-w-20:20`, 85% opacity (see `server.js:3359-3383`)
10. **Short-form videos need 80px logo** — smaller size for 9:16 format, top-right at `W-w-15:15`

## File Locations

```
output/                  ← Final MP4s (500MB each), thumbnails, metrics JSON
output/qa_failures/      ← Gate failure logs (never uploaded to Drive)
tmp/                     ← HeyGen segments, intro cards, Gate 2 samples (auto-cleaned >24h)
tmp/early_clips/         ← Pre-downloaded Maya/Emily clips (survives HeyGen delay)
cwn_style_guides.json    ← Gemini-learned style per content type (POST /analyze-style-library)
streamers.json           ← Roster + intro card data (origin, fact, profile image URL)
```

**Never commit:** `.env`, `output/`, `tmp/`, `cwn-drive-key.json`

## Important Implementation Details

### Twitch Clip Resolution (GQL vs Thumbnail-derived URLs)

Two methods for getting MP4 URLs:

1. **GQL API** (`resolveTwitchClipMp4()`) — fetches signed CDN URL with `?sig=...&token=...` query params. Expires ~1 hour. Requires Twitch Client ID + Token. Preferred for assembly (high quality).
2. **Thumbnail-derived** (`twitchThumbToMp4()`) — converts `preview-480x272.jpg` → `.mp4`. Lower quality, no auth required. Fallback for Gemini analysis if GQL fails.

**Pattern:** Resolve both at script gen time (720p for Gemini, 1080p for assembly), cache early for high-expiry streamers, re-resolve at assembly time to get fresh tokens.

### FFmpeg Concat Protocol

Assembly uses `concat` demuxer (not filter):

```javascript
// concat.txt format:
file '/absolute/path/segment1.mp4'
file '/absolute/path/segment2.mp4'

// FFmpeg command:
ffmpeg -f concat -safe 0 -i concat.txt -c copy output.mp4
```

**Must re-encode (not copy)** when mixing HeyGen segments + source clips — they have different codecs. Use `-c:v libx264 -c:a aac`.

### Node Canvas Intro Cards

Rendered server-side with `node-canvas` (requires native Cairo deps):

```javascript
const canvas = createCanvas(720, 840);
const ctx = canvas.getContext('2d');

// 1. Draw profile image clipped to circle
ctx.beginPath();
ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
ctx.clip();
ctx.drawImage(profileImg, ...);

// 2. Draw gold ring border
ctx.strokeStyle = '#c7af4f';
ctx.lineWidth = 6;
ctx.stroke();

// 3. Draw text lines (name, origin, fact)
ctx.font = 'bold 68px Arial';
ctx.fillText(streamer.displayName, x, y);
```

Saved as PNG, overlayed via FFmpeg at `x=1460 y=40` for 3.5 seconds at start of each streamer segment.

### Gate QA Prompts

All gates use point-deduction scoring:

```
Start: 100 points
-5 for minor issue (e.g., slightly fast pacing)
-10 for moderate issue (e.g., wrong name used once)
-25 for major issue (e.g., missing audio in segment)
-100 (auto-fail) for critical failure (e.g., placeholder brackets in script)
```

Gemini returns JSON-like output parsed by regex. If parsing fails, gate auto-passes with warning (defensive design).

## Cost & Performance Targets

**Current production volume:** 60 long-form + 180 shorts/month

**Per-job costs:**
- HeyGen: ~$0.038/segment × avg 42 segments = ~$1.60/long-form
- Claude script gen: ~$0.05 (5000 tokens avg)
- Gemini QA (3 gates): ~$0.02 total
- Upload-Post: $50/mo flat (unlimited uploads)

**Total monthly:** ~$381 at full production

**Performance targets:**
- Script gen: <60s (Gemini parallel analysis)
- HeyGen render: ~6min total (42 segments × 8.5s avg render time)
- Assembly: <5min (FFmpeg concat + normalize + ticker bake)
- Total pipeline: <12min end-to-end (excluding HeyGen wait time)

Metrics now tracked per job via `run_metrics_{jobId}.json` — use this to identify bottlenecks.

## Pending Features (In Development)

See `IMPLEMENTATION_SPEC.md` for full technical specifications.

### 1. NBA Long-Form Intro Cards
**Status:** Specification complete, implementation pending
**What:** Resize `nba_thumbnail_generator.html` output to 640×360 TV-shaped overlay
**When:** Display at each `GAME#_[TEAMS]_INTRO` scene
**Position:** Right of Bobby G avatar at `overlay=W-640-40:H/2-180`
**Requires:** VectCut API running on port 9001

### 2. News Long-Form Intro Cards
**Status:** Specification complete, implementation pending
**What:** Scrape Open Graph images from article URLs, resize to 640×360
**When:** Display at each `STORY#_INTRO` scene
**Position:** Same as NBA cards (TV shape, right of avatar)
**Dependencies:** `axios`, `cheerio` (already in package.json)

### 3. Short-Form Split-Screen Layout
**Status:** Specification complete, implementation pending
**Format:** 1080×1920 portrait (9:16)
**Layout:**
- Top 50%: Source clip (1080×960, cropped/scaled)
- Bottom 50%: Bobby G avatar (1080×960, from HeyGen)
**Content Flow:** Intro → Clip plays → Reaction
**Logo:** 80px CWN logo at `W-w-15:15` (smaller for vertical format)
**Audio:** TBD - either mix both tracks or use source-only

### 4. VectCut API Integration
**Status:** Server running on port 9001, endpoints not yet implemented
**Location:** `/Users/robertgregory/cwn-production/VectCutAPI`
**Capabilities:** PiP, multi-track editing, video keyframes, overlay positioning
**Use Cases:** NBA/News card positioning, short-form split-screen assembly

### Implementation Priority
1. Start VectCut API server (port 9001) ✅
2. Add environment variables to .env
3. Create NBA card endpoint
4. Create News scraper endpoint
5. Implement short-form split-screen assembly
6. Run production test suite (`test_3_longform_production.js`)