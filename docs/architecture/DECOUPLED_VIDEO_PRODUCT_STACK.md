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

This repository’s **current** development rules remain in `CLAUDE.md` and `AGENT_FILE_REGISTRY.md`.
