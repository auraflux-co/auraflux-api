# Decoupled AI video product — Vercel / Render / RunPod

**Status:** **Future product line** — does not replace the current AuraFlux Customer 0 pipeline (HeyGen, SQLite, gated assembly in this repo). Use this document when scoping a **separate** app or monorepo package.

**Relationship:** The **current** product and internal operator story (layers, content stages, three entry paths, monitoring) lives in **`SYSTEM_ARCHITECTURE.md`**. This file covers the **GPU / ComfyUI / SVD** extension only.

**Last updated:** 2026-04-27

---

## Architecture overview

| Layer | Role |
|--------|------|
| **Frontend (Vercel, Next.js, shadcn/ui)** | Auth-light or full auth UI, job creation, status, previews. No FFmpeg on the edge. |
| **Backend (Render, Node.js)** | Orchestration: uploads, persistence, **FFmpeg** for cut/segment/concat, API keys, calls to RunPod, webhooks. |
| **AI engine (RunPod, ComfyUI, SVD / SDXL)** | GPU work: image→video (SVD), optional text-to-video workflows, serverless endpoints for scale. **Pause or serverless** when idle to control cost. |

**Security:** RunPod and other secrets live on the **backend** (Render env), never in the browser.

---

## Key workflows

1. **Text → video**  
   UI → Node → RunPod (ComfyUI / workflow JSON) → return URL (S3 or RunPod output) → show in UI.

2. **Long → short**  
   Upload long file to backend → FFmpeg split + 9:16 trim (`-c copy` where keyframes allow; re-encode when precision matters) → optional ComfyUI pass for style → short outputs.

3. **Short → long**  
   Upload or select clip → extension via ComfyUI / generative path **or** assemble/loop with FFmpeg (product decision).

---

## Content Confirmation Gate (pre-generation)

**Every C1+ job must pass a Content Confirmation step before Gate 0 fires.**  
This is the architectural lesson learned from C0: credits, compute, and HeyGen time are wasted when the wrong clips enter the pipeline. The fix is a pre-generation stage where the system fetches and previews available content, and the customer (or operator) confirms the exact inputs before the job spec is committed.

```
URL / CDN / Search Query / Upload
        ↓
  Stage 0: CONTENT DISCOVERY       ← fetch, scrape, or receive files
  [scrape metadata, probe duration, check orientation]
        ↓
  Stage 0b: CONFIRM                ← show preview in UI, customer selects/deselects
  [job spec gets locked: exact URLs, durations, orientations written to order.inputs.items]
        ↓
  createJobSpec() fires             ← scaffold + voice resolve against confirmed inputs
        ↓
  Gate 0 → Gate 1 → Assembly ...   ← pipeline runs on confirmed, verified inputs only
```

### Three entry workflows map to the same confirmation step:

| Workflow | Fetch trigger | Confirmation |
|---|---|---|
| **Link Content** | Customer pastes URL / CDN path | System scrapes + shows clip preview (title, duration, orientation) |
| **Use My Content** | Customer uploads MP4/MOV | System probes with ffprobe + shows file metadata |
| **Start From Idea** | Customer describes topic | System proposes clips from web/search API; customer picks |

In all three cases, `order.inputs.items` is fully populated **before** `createJobSpec()` runs. This enables:
- `designSpec.sceneStructure.sceneHeaders` resolved from actual clip count  
- `designSpec.voice.lockedOutro` resolved from confirmed content type and customer config  
- Gate 1 `canProduce()` passes on first call, no retries needed  
- Zero wasted HeyGen / AI generation runs on unconfirmed content

**C0 today:** The PICK CLIPS / PICK STORIES UI buttons on the dashboard implement this pattern for the manual C0 workflow. C1+ inherits the same pattern but automated via the frontend before job creation.

---

## Gemini + FFmpeg (long-to-short, without Pegasus)

- **Gemini** can propose **windows** (start/end) and **crop** hints for vertical.  
- **ffprobe** finds keyframe-friendly cut points.  
- **FFmpeg** examples: lossless `ffmpeg -ss T0 -i in.mp4 -to T1 -c copy out.mp4`; accurate vertical re-encode with `scale`/`crop` in `-vf` when needed.

This repo already uses FFmpeg heavily; a future product would **add** a small job queue + storage contract, not duplicate Customer 0 assembly.

---

## SVD pipeline (Stability / ComfyUI)

Typical path: **SDXL still** → **SVD img2vid** (14–25 frames) → **FFmpeg** concat / upscale / fps. ComfyUI graphs encode the workflow; RunPod runs the graph.

**VRAM:** start lower resolution, upscale in FFmpeg or a second stage if 4090-class GPU is not always available.

---

## Implementation order (greenfield)

1. RunPod: account, credits, ComfyUI template (SVD-capable), test one workflow ID.  
2. Render: Node service with `RUNPOD_API_KEY`, webhook URL, object storage for uploads.  
3. Vercel: Next.js app calling only your Render API.  
4. Cost: pause idle pods; prefer serverless endpoints for bursty load.

---

## Cursor / MCP (developer ergonomics)

- **Composer** for multi-file API + FFmpeg modules.  
- **MCP** in Cursor for DB/docs when this stack gets its own services.  
- **`.cursor/rules`** (or project rules) for: no shelling to raw user strings in FFmpeg, `fluent-ffmpeg` or audited args only.

This repository’s **current** development rules remain in `cursor.md` and `AGENT_FILE_REGISTRY.md`.

---

## AI Generation Workflows — C1+ "Start From Idea"

These workflows are **Phase 4** (not required for Customer 0 launch). They extend the product into GPU-driven generation and automated long-to-short conversion.

---

### SVD pipeline (Stability Video Diffusion + ComfyUI)

Full path: **text prompt → SDXL still → SVD img2vid → FFmpeg post-process**.

**Step 1 — Image generation (SDXL)**

Generate a high-quality base frame from a text prompt using Stable Diffusion XL. ComfyUI handles this via a SDXL checkpoint node.

**Step 2 — Video generation (SVD)**

SVD takes the SDXL frame and injects motion:
- `svd.safetensors` — 14 frames (~2s at 7fps)
- `svd_xt.safetensors` — 25 frames (~4s at 6fps)

Key parameters:
- `motion_bucket_id` — low (10–50) = subtle camera drift; high (100–200) = active motion
- `fps` — controls playback speed of the generated frames
- VRAM constraint: start at 512x512 if GPU < 24 GB; upscale in FFmpeg afterwards

**Step 3 — FFmpeg post-process**

Convert SVD frame sequence to MP4, upscale, and stitch scenes:

```bash
# Frame sequence → MP4
ffmpeg -r 6 -i frame_%03d.png -vcodec libx264 -crf 15 -pix_fmt yuv420p output.mp4

# Upscale SVD 1024x576 → 1920x1080
ffmpeg -i input_svd.mp4 -vf "scale=1920:1080:flags=lanczos" -c:v libx264 -crf 10 output_1080p.mp4

# Stitch multiple generated scenes (list.txt: file 'scene_01.mp4' per line)
ffmpeg -f concat -safe 0 -i list.txt -c copy output_final.mp4
```

**Key tools:**
- **ComfyUI** — node graph editor that chains SDXL → SVD → output; runs on RunPod
- **EBSynth** — apply SVD keyframes to a longer sequence for consistent extended clips
- **`thecooltechguy/ComfyUI-Stable-Video-Diffusion`** — ComfyUI node pack for SVD

---

### Gemini + FFmpeg — long-to-short (without Pegasus)

Gemini analyzes the video and returns timestamps and crop suggestions. FFmpeg executes the cuts.

**Step 1 — Gemini video analysis**

Send the video file (or URL) to Gemini with a prompt such as:
> "Identify the top 3 most engaging 15-second clips for TikTok. Provide start/end timestamps (HH:MM:SS) and suggest a subject-centered 9:16 crop region."

Gemini returns structured timestamps (e.g., `01:15-01:30`) that feed directly to FFmpeg.

**Step 2 — FFmpeg cuts**

```bash
# Fast lossless cut (snaps to nearest keyframe — instant, no quality loss)
ffmpeg -ss 00:01:15 -i long_video.mp4 -to 00:01:30 -c copy short_clip.mp4

# Accurate cut + vertical reframe (re-encodes — slower but frame-precise)
ffmpeg -i long_video.mp4 -ss 00:01:15 -to 00:01:30 \
  -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" \
  short_vertical.mp4

# Find keyframe cut points (for lossless -c copy cuts)
ffprobe -select_streams v -skip_frame nokey -show_frames \
  -show_entries frame=pts_time -of csv=p=0 input.mp4
```

**In this repo today:** `lib/assembly.js` already uses `-ss` seek + `SHORT_CLIP_WINDOW_MAX_SEC` for short-form clip trimming. `lib/gates/gate3a.js` uses `clipTimingTargets[0].start` from Gemini's analysis for seek offset. The C1+ long-to-short path extends this same pattern to arbitrary long-form uploads.

---

### CTA overlay with FFmpeg

Burn a visual CTA (e.g., "Shop Now" button image) onto a video for a timed window. FFmpeg creates a visual overlay only — clickability requires an external player or HTML wrapper.

```bash
# Overlay cta.png centered near the bottom from second 5 to 15
ffmpeg -i input.mp4 -i cta.png -filter_complex \
  "[1:v]scale=iw/2:-2[scaled_cta]; \
   [0:v][scaled_cta]overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h-20):enable='between(t,5,15)'" \
  -c:a copy output.mp4
```

**Making it clickable (after FFmpeg):**
- **Mindstamp / FastPix** — upload video, define a hotspot at the same coordinates + timing window
- **HTML/CSS overlay** — place video in a div with a transparent anchor button over the CTA region, matching FFmpeg x/y/timing values
- **Mobile note** — set z-index correctly on the overlay button to prevent player chrome from blocking taps

---

### RunPod setup (Phase 4 prerequisites)

1. Create account at runpod.io; add credits ($20–$50 to start)
2. Launch a **ComfyUI pod** — select RTX 4090 template with Stable Video Diffusion (`thecooltechguy/ComfyUI-Stable-Video-Diffusion`)
3. Use **serverless endpoints** for on-demand generation (pay per second, auto-scales to zero when idle)
4. Store `RUNPOD_API_KEY` and `RUNPOD_ENDPOINT_ID` in the **Render environment panel** — never in frontend
5. **Pause pods when idle** to control cost; prefer serverless for bursty workloads

**Backend call pattern (Node.js on Render):**

```javascript
const response = await fetch(
  `https://api.runpod.ai/v2/${process.env.RUNPOD_ENDPOINT_ID}/run`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RUNPOD_API_KEY}` },
    body: JSON.stringify({ input: { workflow: comfyWorkflow, seed: Date.now() } }),
  }
);
const { id } = await response.json();
// Poll GET /v2/:endpointId/status/:id until status === 'COMPLETED', then read output URL
```

**New files needed (Phase 4):**
- `lib/ai/runpod.js` — RunPod API client (POST workflow, poll status, return R2 URL)
- `lib/ai/svd_workflow.json` — ComfyUI workflow definition (SDXL + SVD nodes)
- `lib/ai/svd_pipeline.js` — orchestrates prompt → SDXL image → SVD clip → FFmpeg stitch
