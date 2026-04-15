# AURAFLUX_REVERSE_PIPELINE_SPEC.md

**Author:** Claude Code, 2026-04-14  
**Status:** Concept spec — not yet in development  
**Relationship to CWN:** CWN is the Forward Assembly Line (prototype). This is the Reverse Assembly Line (AuraFlux product).  
**Move to:** Jira epic + Confluence once Atlassian migration lands  

---

## The Two Assembly Lines

```
FORWARD ASSEMBLY (CWN today)
Source clips + articles + highlights
    → Gemini analyzes
    → Bobby G script generated
    → HeyGen renders avatar
    → FFmpeg assembles broadcast
    → Long-form OR short-form MP4 out

REVERSE ASSEMBLY (AuraFlux product)
Long-form MP4 in (upload / URL / local)
    → Gemini watches + identifies best moments
    → Directive generated per clip (timestamps + captions + brand)
    → FFmpeg cuts + crops + burns chrome
    → N short-form MP4s out → distribute
```

Same engine. Same directive schema. Same FFmpeg burn pipeline. Same set design architecture. Different direction of travel.

---

## What the Reverse Pipeline does

A user has a long-form video — a podcast, a game stream, a keynote, a raw interview, a sports highlight reel. They want 10 short-form clips for YouTube Shorts / TikTok / Instagram Reels, each branded with their design spec.

Today that's a manual editor job: watch the video, find the moments, cut, crop, add captions, export. AuraFlux automates the entire chain.

---

## Input sources

Any source the system can read a video file from:

| Source type | Method |
|---|---|
| User upload (browser) | Multipart POST → temp storage |
| Public URL | yt-dlp (same as current News/NBA clip pipeline) |
| Signed cloud URL (S3, GCS, Drive) | Direct download via axios |
| Local file path (self-hosted / CLI mode) | fs.readFile |
| RSS feed with enclosures | Parse feed → extract video URLs → yt-dlp |
| Any URL yt-dlp supports | YouTube, Twitch VODs, Twitter/X, Facebook, etc. |

**Constraint:** Only sources the operator is authorized to pull from. No DRM bypass. No paywalled content. Same SSRF protection as current `downloadFile()`.

---

## Gemini "moment extraction" step

This is the core intelligence difference from the Forward pipeline. Instead of writing a script, Gemini watches the long-form video and outputs a **moment manifest** — a structured list of the N best shareable moments with timestamps.

**Prompt goal:** "Watch this video. Find the 10 most engaging, self-contained moments that would work as a standalone short-form clip (15-60 seconds). For each moment output: start timestamp, end timestamp, a 5-10 word hook (top of screen), 1-2 caption lines (bottom of screen), and a content category tag."

**Output shape (directive per clip):**
```json
{
  "sourceFile": "input.mp4",
  "totalDurationSec": 3600,
  "brandConfig": { ... },
  "clips": [
    {
      "index": 0,
      "startSec": 142,
      "endSec": 187,
      "durationSec": 45,
      "hookText": "He had no idea what was coming",
      "captionLine1": "The moment everything changed",
      "captionLine2": "Watch the full episode — link in bio",
      "category": "reaction",
      "chrome": {
        "hook": { "visible": true, "text": "He had no idea what was coming" },
        "caption": { "visible": true, "line1": "...", "line2": "..." },
        "logo": { "visible": true },
        "watermark": { "visible": true }
      }
    }
  ]
}
```

**Why Gemini:** Already proven on News (watches Al Jazeera clips, Gate 3 QA). The same `uploadToGeminiFiles()` + multimodal prompt pattern works on any MP4. For long-form (>34MB Gemini upload limit), chunk the video or use timestamp-based sampling.

---

## FFmpeg reverse assembly chain

Per clip in the manifest:

```
1. TRIM     — ffmpeg -ss {startSec} -to {endSec} -i input.mp4
2. CROP     — scale + crop to 9:16 (1080×1920) — same zoom-to-fill filter as News clips
3. CHROME   — Puppeteer renders branded overlay PNG (hook text, caption, logo, watermark)
              using same tools/clipzworld_newscast.html set engine with brand variables swapped
4. BURN     — ffmpeg overlay: chrome PNG burned onto cropped clip
5. ENCODE   — libx264, AAC, loudnorm I=-14 TP=-1.5 LRA=11, 30fps
6. OUT      — short_{index}_{hookText_slug}.mp4
```

**Reused from Forward pipeline:**
- `burnSceneChromeFromDirective()` — already burns chrome per scene
- `generateNewscastOverlay()` — already renders Puppeteer PNG
- Zoom-to-fill crop filter — already in News clip processing
- loudnorm audio normalization — already in assembly
- `downloadFile()` with SSRF protection — already handles URL inputs

**New work:**
- `trimClip(inputPath, startSec, endSec, outputPath)` — simple ffmpeg wrapper
- `reverseAssemble(manifest)` — orchestrates trim → crop → chrome → burn per clip
- Parallel processing: N clips can trim+crop simultaneously, chrome burns sequentially (Puppeteer instance reuse)

---

## Brand config (multi-tenant surface)

The only thing that changes between customers is `brandConfig`. Every visual decision — colors, logo, font, watermark position, caption style — lives here. The FFmpeg chain and Puppeteer renderer are identical for every customer.

```json
{
  "brandConfig": {
    "primaryHex": "#1a1a2e",
    "accentHex": "#e94560",
    "showName": "The Daily Pod",
    "logoPath": "uploads/customer_123/logo.png",
    "logoPos": { "x": 20, "y": 20, "size": 80, "opacity": 0.9 },
    "watermarkText": "@thedailypod",
    "fontFamily": "Bebas Neue",
    "captionBgOpacity": 0.75,
    "hookTextSize": 48,
    "captionTextSize": 28
  }
}
```

Each AuraFlux customer tenant has one `brandConfig` stored in Postgres. Passed into every reverse assembly job for that tenant. Changing the brand config changes every future output — no code change.

---

## User-facing API (AuraFlux SaaS endpoints)

```
POST /api/jobs/reverse
  Body: { sourceUrl, brandConfigId, clipCount, minDurationSec, maxDurationSec }
  Returns: { jobId, status: 'queued' }

GET  /api/jobs/:jobId/status
  Returns: { status, progress, clips: [{ index, previewUrl, downloadUrl }] }

GET  /api/jobs/:jobId/clips/:index/download
  Returns: MP4 file

POST /api/jobs/:jobId/publish
  Body: { platforms: ['youtube_shorts', 'tiktok', 'instagram_reels'], scheduleAt? }
  Returns: { requestId } — async via Upload-Post
```

---

## Relationship to Forward pipeline

| | Forward (CWN) | Reverse (AuraFlux) |
|---|---|---|
| Input | Source URLs + script prompt | Long-form MP4 or URL |
| AI role | Gemini generates content | Gemini extracts moments |
| Avatar | HeyGen renders Bobby G | None (source audio preserved) |
| Output form | Long-form broadcast OR short | N short-form clips |
| Brand | CWN fixed brand | Per-tenant brand config |
| Multi-tenant | No (single show) | Yes (any customer) |
| Set engine | Same | Same |
| FFmpeg chain | Same | Same (+ trim step) |
| Directive schema | Same (chrome per scene) | Same (chrome per clip) |

**The set engine is the shared foundation.** CWN proved it works. AuraFlux productizes it.

---

## What needs to be built (in order)

1. **`trimClip()` FFmpeg wrapper** — simple, 20 lines
2. **Gemini moment extraction prompt** — the "find N best moments" prompt, tuned per content category (podcast, sports, gaming, interview)
3. **`reverseAssemble(manifest)`** — orchestrates the per-clip chain
4. **Brand config schema + Postgres table** — multi-tenant storage (Phase 2 Railway)
5. **User upload endpoint** — multipart POST to temp storage
6. **Job queue** — concurrent reverse assembly jobs (Railway worker + Postgres job table)
7. **AuraFlux dashboard** — upload UI, brand config editor, clip preview, publish controls
8. **Upload-Post integration** — same `/publish` endpoint, different job source

**Prerequisite:** News forward pipeline locked (all chrome elements rendering, smoke test passing). The set engine must be proven stable before it's productized.

---

## Why this is the product

Every creator with a podcast, stream, or long-form video needs short-form clips. The manual editing workflow is the bottleneck. AuraFlux removes it:

- Podcast → 10 Reels in 5 minutes
- Stream VOD → 10 TikToks from last night's session  
- Keynote → 10 LinkedIn clips
- Sports highlight reel → 10 Shorts per game

Same engine. Any source. Any brand. Any platform.

**The CWN pipeline is the prototype. AuraFlux is the product.**
