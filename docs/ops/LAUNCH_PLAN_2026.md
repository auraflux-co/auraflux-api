# Launch plan — Blocks 2–4 (2026)

**Purpose:** Single execution map for “code to launch” after the strategy work in session. This repo is the **AuraFlux / Customer 0 pipeline** (Node API, HeyGen, gates, FFmpeg). A **separate** decoupled product (Vercel + RunPod ComfyUI) is specified in `docs/architecture/DECOUPLED_VIDEO_PRODUCT_STACK.md` and is **not** required to ship the current production line.

**Last updated:** 2026-04-21

---

## Block 2 — Core pipeline testing (~4 hrs) — **gate to everything**

| # | Deliverable | What “done” means | Owner / note |
|---|-------------|-------------------|----------------|
| 3 | **6 E2E test cases** | 4× one-clip + long-form matrix + 1 short-form, all passing gates you care about for launch. | See `LAUNCH_TEST_MATRIX.md` for the exact table. |
| 4 | **3 full long-form runs** | NBA, News, Twitch at **full** intended clip/story counts (not minimal smoke). | Log job IDs + outcomes in `STATUS.md` or test notes. |

**If Block 2 fails:** fix pipeline/assembly/source issues first; do not start Block 3 deploy work.

---

## Block 3 — If tests pass (~2 hrs)

| # | Deliverable | Notes |
|---|-------------|--------|
| 5 | **Render migration** + post-render task list | **Checklist:** `RENDER_DEPLOY_CHECKLIST.md`. **Existing backlog:** `POST_RENDER_TASKS.md` (do not duplicate — cross-link only). After deploy: NR, monitoring, TZ, then items in POST_RENDER by priority. |

---

## Block 4 — Platform / architecture (remaining hours)

| # | Deliverable | Repo action |
|---|-------------|-------------|
| 6 | **Rovo MCP setup** | Atlassian Rovo / Jira — enable in **Cursor → MCP** with your org’s server; not something this repo can configure in code. |
| 7 | **C0 → C1 UI code review + Equinox assessment** | Track as **issue / doc review**; no code in this pass unless findings are filed. |
| 8 | **Autocannon load test (HeyGen off)** | `GET /health` does **not** call HeyGen. Run: `npm run load-test:health` with API up (see script). |
| 9 | **Prettier setup** | `npm run format` / `format:check` (see `package.json`). |
| 10 | **GitHub cleanup / .gitignore** | Ongoing; patterns in root `.gitignore` + this plan. |
| 11 | **CWN → AuraFlux rename audit** | **Checklist only:** `RENAME_CWN_TO_AURAFLUX.md` — mass rename is a dedicated commit, not part of this launch block. |

---

## Future product line (out of scope for this launch)

- **Vercel/Next.js + Render Node + RunPod ComfyUI/SVD** — architecture and workflows: `docs/architecture/DECOUPLED_VIDEO_PRODUCT_STACK.md`.
- **Gemini + FFmpeg long-to-short** — operational techniques (timestamps, `ffprobe`, lossless cut) are reference material; automation hooks belong in that product or a new package, not a forced change to the current `server.js` monolith.

---

## Order of operations

1. Complete **Block 2** and record results.  
2. If green, **Block 3** (Render) using Docker + env parity.  
3. **Block 4** in parallel with low risk: Prettier, load test, .gitignore, rename audit doc.  
4. Schedule **decoupled stack** and **Rovo** when accounts and time are available.
