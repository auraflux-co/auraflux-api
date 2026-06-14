# AuraFlux — system architecture (product + internal)

**Status:** Authoritative product-facing architecture. Aligns design PDFs, launch plan, and this repository.  
**Audience:** Product, engineering, agents.  
**Last updated:** 2026-04-27  
**Related:** `AURAFLUX_SYSTEM_OVERVIEW.md` (runtime detail), `GATED_PIPELINE_ARCHITECTURE.md` (gate mechanics), `PLATFORM_ARCHITECTURE.md` (two-sided platform), `DECOUPLED_VIDEO_PRODUCT_STACK.md` (future GPU / ComfyUI line), `docs/ops/LAUNCH_PLAN_2026.md` (pre-launch blocks).

---

## 1. Executive picture

AuraFlux is an **AI video production system** that ingests content or ideas, turns them into a **structured job spec**, runs them through **QA gates** and **video production** (FFmpeg, avatar renders, overlays), and **distributes** to social platforms. Internal operators and future end customers see the same logical pipeline; **Customer 0 (CWN)** is the reference implementation in this monorepo.

---

## 2. System architecture pipeline (control plane)

From input to distribution — how work is **orchestrated** (matches product diagram: *System Architecture Pipeline*).

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐    ┌──────────────┐    ┌─────────────┐    ┌──────────────┐
│  Input sources  │ →  │  Spec builder   │ →  │   Node engine   │ →  │ BullMQ+Redis │ →  │   Storage     │ →  │ Distribution  │
│  Feeds, URLs,   │    │  Structured job │    │  server.js     │    │ Async jobs,  │    │ SQLite → PG, │    │ Drive,        │
│  uploads, APIs  │    │  & scene design │    │  routing, lib/ │    │ rate, retry  │    │ assets, logs  │    │ Upload-Post,  │
└─────────────────┘    └─────────────────┘    └─────────────────┘    └──────────────┘    └─────────────┘    │ platforms     │
         │                      │                      │                      │                 │                └──────────────┘
         │                      │                      │                      │                 │
         ▼                      ▼                      ▼                      ▼                 ▼
   External data        Gemini (and            Express API,            Queue depth,      Job spec rows,
   Twitch, YouTube,     helpers) turn          lib/* pipeline          pipeline /        gate results,
   RSS, scrapes,        sources into           code, gate workers      assembly,         outputs,
   user uploads         job spec +             HeyGen, FFmpeg          monitoring        file paths
                        scaffold
```

| Layer | Role in product terms | Primary implementation in this repo |
|--------|------------------------|-------------------------------------|
| **Input sources** | Everything that can start or feed a job: URLs, APIs, uploads, rosters, prompts. | `lib/` source modules, Twitch/News/NBA paths, `createJobSpec`, dashboard POST bodies |
| **Spec builder** | From raw inputs to a **confirmable** job spec: template, scene structure, voice, chrome, commitments. | `lib/job_spec.js`, `lib/scaffold.js`, Gemini-assisted script generation, `designSpec` |
| **Node engine** | Orchestration: which stage runs, idempotency, errors, progress, integration with external APIs. | `server.js`, `lib/script_gen.js`, `lib/assembly.js`, gate workers under `lib/gates/` |
| **BullMQ + Redis** | Durable **async** work: long renders, polls, assembly triggers, backpressure. | `bullmq` + `ioredis` (queues named in `AURAFLUX_SYSTEM_OVERVIEW.md`); not every path is queue-only yet |
| **Storage layer** | Persistent jobs, metrics, assets on disk, publish metadata. | SQLite (`better-sqlite3`), `data/`, `output/`, Google Drive |
| **Distribution** | Final delivery: Drive, Upload-Post, YouTube / TikTok / Instagram / etc. | `lib/publish.js`, Drive upload, platform APIs per `PUBLISH_COPY_SPEC.md` |

---

## 3. Content pipeline flow (production plane)

Six conceptual stages of **what happens to the content** (matches *The Content Pipeline Flow* / *AuraFlux Engine Pipeline*). Numbers are **logical** — some steps map to multiple gates in `GATED_PIPELINE_ARCHITECTURE.md`.

| Step | Name | What happens | Typical technology in stack |
|------|------|--------------|------------------------------|
| **01** | **Source ingestion** | Resolve and validate media: clips, articles, game highlights, user files. | Twitch API, Cheerio/scrapes, `ffprobe`, downloaders, upload handlers |
| **02** | **Story / moment engine** | Find or structure **moments** and narrative arc: what the episode is about, ordering, copy. | Gemini, optional indexers (e.g. Twelve Labs in product vision — **not** required for all job types today) |
| **03** | **Scene engine** | Turn story into **scenes**: headers, avatars, clips, chrome, timings. | Scaffold, `script_gen`, Puppeteer/Canvas (legacy or FFmpeg chrome per spec) |
| **04** | **QA gates** | Self-healing checks: script, segments, assembly quality, broadcast readiness. | Claude (Gate 1 / 3b), Gemini (Gates 0, 2, 3a, 4, 5), code validators |
| **05** | **Video production** | Render avatars, concat, normalize, burn overlays, audio. | HeyGen, FFmpeg, `lib/assembly.js`, `lib/chrome_overlay_ffmpeg.js` |
| **06** | **Distribution** | Upload, metadata, thumbnails, platform posts. | Drive, Upload-Post, publish copy generator |

**End-user framing (same pipeline, product language):** *Finds moments → Builds content → Produces videos → Publishes* — maps to **02–06** (with **01** = your upload or link).

---

## 4. End users — three ways to start (outcomes)

How customers **enter** the product (matches *AuraFlux Content Pipeline* / *Three Ways to Start*). Full self-serve UI may be a **Next.js** app in a later phase; today many paths are **dashboard- or API-driven** for Customer 0.

| User path | Meaning | Product intent | CWN / repo today (typical) |
|------------|---------|----------------|----------------------------|
| **Use my content** | User uploads MP4/MOV/footage. | Engine ingests file → moments/clips → produce → publish. | Upload / extract flows; `EXTRACT_*` job families where implemented |
| **Link content** | Paste Twitch, YouTube, or web URL. | System harvests or resolves media → same pipeline. | `COMPACT_FETCH` / direct URL items, clip resolution, Gate 0 |
| **Start from idea** | Prompt or topic only. | Generate structure and script from scratch (subject to template + policy). | Scaffold + Gemini script path; may combine with library content later |

**Output formats (product):** short-form (TikTok, YouTube Shorts, IG Reels) and long-form (YouTube, compilations, reactions). Template IDs and aspect ratio come from `customerConfig` / job spec.

---

## 5. Internal vs external users

- **Streamers and curators** (two-sided model): see `PLATFORM_ARCHITECTURE.md` — who owns the clip, attribution, and library strategy.  
- **Operators (Rob / production):** dashboard, job cards, manual Studio steps where APIs cannot fully automate.  
- **Engineering / agents:** `CHANGE_IMPACT_MAP.md`, gate YAMLs, `cursor.md`.

---

## 6. Monitoring and observability stack

| Concern | Purpose | In this repo / ops |
|--------|----------|---------------------|
| **Job tracing** | Follow one jobId through gates and stages. | `job_spec` persistence, gate results, `logs/pipeline_events.jsonl`, `logs/errors.jsonl` |
| **Queue health** | Depth, stuck workers, retry storms. | Redis + BullMQ metrics; `lib/monitoring.js` escalation |
| **Failure detection** | Surface hard fails and escalation paths. | `logError`, `PIPELINE_ESCALATION`, `MONITORING_CODE_FIX_NEEDED` |
| **New Relic** | APM, distributed traces, dashboards. | `newrelic.js` — use **License** key (40-char), not Ingest-only key |
| **API latency** | Endpoint SLOs, hot paths. | NR transactions; optional `autocannon` on `/health` for load baseline |

---

## 7. Launch and quality gates (program management)

Pre-production milestones (from `docs/ops/LAUNCH_PLAN_2026.md`):

- **Block 2 — Core pipeline testing:** six end-to-end cases + three full long-form (NBA, News, Twitch) + short-form; documented in `LAUNCH_TEST_MATRIX.md`.  
- **Block 3 — If tests pass:** Render migration + tasks in `POST_RENDER_TASKS.md` + `RENDER_DEPLOY_CHECKLIST.md`.  
- **Block 4 — Platform:** Prettier, load test, rename audit, MCP/Rovo (IDE-side), decoupled stack planning.

These blocks do not change the diagram above; they **prove** it under load and in production.

---

## 8. Future extension: decoupled generative video (RunPod / ComfyUI / SVD)

**Not** required for Customer 0 launch. For **text-to-video**, **long↔short** with heavy GPU, or ComfyUI workflows, see `DECOUPLED_VIDEO_PRODUCT_STACK.md` (Vercel/Next + Render API + RunPod). That line **extends** the same product story; it does not replace HeyGen+FFmpeg assembly until explicitly migrated.

**Manual / hybrid techniques (Gemini + FFmpeg):** highlight detection, lossless `ffmpeg -ss … -c copy` cuts, vertical reframes — can feed both the current pipeline and the future ComfyUI branch.

---

## 9. AuraFlux output formats

From the product design system (matches *AuraFlux Output Formats* diagram):

| Format | Platforms | Description |
|--------|-----------|-------------|
| **Short-form vertical** | TikTok, YouTube Shorts, IG Reels | 9:16 clips, captions, trending-ready. Max 60s. |
| **Long-form horizontal** | YouTube | Full-length reactions, compilations, narrated episodes. |
| **Compilations** | YouTube | Best-of / highlight reels from multiple clips or games. |

All formats produced by the same **Assembly service** (`lib/assembly.js`); aspect ratio and chrome skin come from `order.designSpec` in the job spec.

---

## 10. Document map (read order)

1. **This file** — one-page system view for PO and new engineers.  
2. **`AURAFLUX_SYSTEM_OVERVIEW.md`** — current stack version, job IDs, queue names, MCP list.  
3. **`PIPELINE_CONTRACT_SPEC.md`** — job spec schema and stage contract.  
4. **`GATED_PIPELINE_ARCHITECTURE.md`** — gate behavior and self-healing rules.  
5. **`CWN_ENVIRONMENT_MAP.md`** — every external service and port (operator detail).  
6. **`PLATFORM_ARCHITECTURE.md`** — ICP, layers, two-sided model.  
7. **`DECOUPLED_VIDEO_PRODUCT_STACK.md`** — when building the separate GPU/Next product line.
8. **`docs/strategy/BUSINESS_STRATEGY.md`** — positioning, pricing model, offer structure.
