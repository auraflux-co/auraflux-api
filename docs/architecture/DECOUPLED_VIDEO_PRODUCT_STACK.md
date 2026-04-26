# Decoupled AI video product — Vercel / Render / RunPod

**Status:** **Future product line** — does not replace the current AuraFlux Customer 0 pipeline (HeyGen, SQLite, gated assembly in this repo). Use this document when scoping a **separate** app or monorepo package.

**Relationship:** The **current** product and internal operator story (layers, content stages, three entry paths, monitoring) lives in **`SYSTEM_ARCHITECTURE.md`**. This file covers the **GPU / ComfyUI / SVD** extension only.

**Last updated:** 2026-04-21

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
