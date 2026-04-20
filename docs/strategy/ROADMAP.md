# CWN Roadmap — Post-Testing Work

**Purpose:** Single consolidated view of all work planned for *after* the 6 test cases pass (Twitch / NBA / News × long-form / short-form). Active test-blocking work lives in `LONGFORM_FIX_ROTATION.md` and (future) `SHORTFORM_FIX_ROTATION.md` — not here.

**Last updated:** 2026-04-12

---

## Scope rules

- ❌ **Not in this doc:** anything required to pass the 6 test cases. Those live in the rotation docs.
- ❌ **Not in this doc:** Priority 1 items from `POST_PUBLISH_TASKS.md` (white strip, ticker gap, auto-publish creative pieces) — test-blocking polish.
- ❌ **Not in this doc:** NBA live-narration rework — currently in `LONGFORM_FIX_ROTATION.md` as test-blocking architectural work.
- ✅ **In this doc:** everything else parked "post-test" across STATUS.md, POST_PUBLISH_TASKS.md, OVERNIGHT_TASKS.md, CLAUDE.md, GATED_PIPELINE_ARCHITECTURE.md, SERVER_SPLIT_PLAN.md, HEYGEN_OPTIONS_INVENTORY.md, and the user's memory files.

## Prioritization method — MoSCoW + dependency graph

Each item is tagged with one MoSCoW tier and a `Blocks` field naming downstream items it unlocks. If an item blocks 2+ others, it auto-climbs regardless of its own size.

- 🔴 **Must-Have** — core functionality, compliance, or blocker for another Must-Have
- 🟠 **Should-Have** — important UX/quality, next in line after Must-Haves
- 🟡 **Could-Have** — valuable but not critical
- ⚪ **Won't-Have (yet)** — explicitly deferred, documented so it isn't lost

**Tiebreaker when MoSCoW + Blocks don't resolve order:** business value > urgency > effort.

**Item fields:** What / Why / Blocks / Effort (XS·S·M·L·XL) / Source.

**Buckets:** four parallel tracks — three per content type plus one enterprise track. Items touching all three shows live in Enterprise, not duplicated across shows.

---

## Bucket 1 — Twitch

### 🟠 Should-Have

- **Phonetic parenthetical glitch (Yonna / Adapt / Lacy)**
  - **What:** Bobby G says the canonical name immediately followed by the phonetic hint aloud ("Yonna… YAWN-uh"). Fix options in POST_PUBLISH_TASKS §2.3: strip parenthetical phonetics in `cleanAvatarText` before HeyGen, OR use SSML `<sub alias="Yawn-uh">Yonna</sub>`, OR remove phonetic-hint rule from Gemini prompt.
  - **Why:** Breaks immersion on 3 streamers. Not gate-blocking — Rob edits it out in YouTube Studio when it happens.
  - **Blocks:** nothing
  - **Effort:** S (one-line text cleanup) or M (SSML sub approach needs HeyGen compatibility probe)
  - **Source:** POST_PUBLISH_TASKS.md §2.3, memory: wait-and-see during testing
  - **Gate:** only escalate to rotation doc if it recurs in a test-case run

### 🟡 Could-Have

- **Signature outro sign-off move**
  - **What:** Bobby G has a recurring sign-off motion (wave, nod, point at camera) that becomes a brand identifier. Three paths: longer SSML break + intentional script shape; curated library of 3–5 pre-rendered sign-off clips; HeyGen Photo Avatar Motion API (requires avatar migration).
  - **Why:** Brand identity, zero-cost per run (library path).
  - **Blocks:** nothing
  - **Effort:** M (library path) or L (Photo Avatar Motion migration)
  - **Source:** POST_PUBLISH_TASKS.md §3.1

---

## Bucket 2 — NBA

*(The NBA live-narration architectural rework is currently in `LONGFORM_FIX_ROTATION.md` as test-blocking work. See rotation doc for active items. This section only holds post-test NBA polish.)*

### 🟡 Could-Have

- **NBA reference URL list for style library**
  - **What:** Rob compiles ~10 YouTube URLs of reference NBA narration/highlight commentary for Gemini to watch and extract a style fingerprint. Separate from Twitch and News reference lists.
  - **Why:** Once NBA is in live-narration mode, the Gemini script prompt needs a distinct style fingerprint (narration-over-footage, not setup/reaction). A generic reaction-video fingerprint won't produce good NBA narration.
  - **Blocks:** NBA narration quality ceiling
  - **Effort:** S (Rob compiles URLs) + existing endpoint work
  - **Source:** POST_PUBLISH_TASKS.md §3.3, Rob's note that style library needs per-content-type URL sets
  - **Depends on:** Enterprise → "Style library per-content-type support"

---

## Bucket 3 — News

### 🟡 Could-Have

- **Video clips for News content feasibility investigation**
  - **What:** Explore embedding video clips (not just OG thumbnails) for News stories. Currently News TV card pulls a scraped Open Graph image; video clips from news articles would make News feel closer to NBA/Twitch.
  - **Why:** Creative parity across content types. Could raise News production value significantly.
  - **Blocks:** News narration mode (if it proves feasible and NBA's narration architecture generalizes)
  - **Effort:** L (scraper rework + legal/rights questions on news video embedding)
  - **Source:** memory: `project_news_overlay_investigation`

- **Unified News TV-card overlay with shared template**
  - **What:** Currently News overlay renders via `/news/generate-intro-card` with OG scraper → 640×360. Consolidate with NBA's TV-card generation path so one shared template serves both (already visually unified per Apr 11 spec, but the code paths are still separate).
  - **Why:** Code hygiene. Easier to evolve one template than two.
  - **Blocks:** nothing
  - **Effort:** M (consolidation refactor)
  - **Source:** memory: `project_news_overlay_investigation`

- **News reference URL list for style library**
  - **What:** Rob compiles ~10 YouTube URLs of reference news anchor / commentary style for Gemini to watch. Separate from Twitch and NBA lists.
  - **Why:** News has a different tone than Twitch reactions or NBA highlights. The current style guide is generic reaction-commentary.
  - **Blocks:** News script quality ceiling
  - **Effort:** S (Rob compiles URLs) + existing endpoint work
  - **Depends on:** Enterprise → "Style library per-content-type support"

---

## Bucket 4 — Enterprise (cross-content, infra, dev-experience)

### 🔴 Must-Have

- **Complete `server.js` module split (Phase 2–5)**
  - **What:** Continue extracting modules per `SERVER_SPLIT_PLAN.md`. Phase 1 done (config/logger/metrics). Next: `lib/services/gemini.js`, `lib/services/heygen.js`, `lib/services/ffmpeg.js`, `lib/routes/*.js`. Target: server.js drops from ~10,000 lines to ~300.
  - **Why:** server.js hit 172K tokens — Aider literally cannot load it alongside CLAUDE.md + STATUS.md (200K context limit). Every future refactor is harder until this ships. Unblocks every Aider task that touches server.js.
  - **Blocks:** Enterprise → rate limiting per endpoint, input validation, structured logging, Gate self-healing upgrades (most gate code is inside server.js), `/health` + `/metrics` route modules, and every other `lib/routes/*.js` extraction
  - **Effort:** XL (5 modules × ~1 night each per OVERNIGHT_TASKS.md cadence)
  - **Source:** SERVER_SPLIT_PLAN.md, OVERNIGHT_TASKS.md

- **Gate 5 — Full-Video QA (does not exist yet)**
  - **What:** New gate between current Gate 4 (Assembly QA) and Gate 6 (Publish). Chunked upload of full assembled video to Gemini, full-video audio/visual/pacing review, broadcast-readiness judgment. Per GATED_PIPELINE_ARCHITECTURE.md §4.4, this is the biggest gap in the current 7-gate architecture.
  - **Why:** Current Gate 3 (called "Gate 4" in the architecture) samples only 3 points (early/middle/late). A structurally broken video with issues outside those 3 samples can pass. Full-video review catches what sampling misses.
  - **Blocks:** reliable end-to-end self-healing pipeline; Gate 7 (Rob reviews on platforms) confidence
  - **Effort:** L (new endpoint + Gemini chunked upload + prompt engineering + threshold tuning)
  - **Source:** POST_PUBLISH_TASKS.md §4.4, GATED_PIPELINE_ARCHITECTURE.md

- **Input validation & sanitization on all POST endpoints**
  - **What:** Add `express-validator` checks to `/assemble`, `/generate-full-script`, `/publish`, `/generate-thumbnail`. Validate required fields, array lengths, contentType enum, URL formats.
  - **Why:** Security baseline. Currently nothing stops a malformed payload from crashing mid-assembly or a bad URL from triggering SSRF retries.
  - **Blocks:** nothing strictly, but required for Railway deployment
  - **Effort:** M
  - **Source:** OVERNIGHT_TASKS.md QUEUED

- **Rate limiting per endpoint**
  - **What:** `express-rate-limit` middleware with per-endpoint limits: `/generate-full-script` 10/min (Gemini cost protection), `/assemble` 5/min (FFmpeg resources), `/publish` 20/min (Upload-Post), `/generate-thumbnail` 30/min, default 60/min.
  - **Why:** Currently nothing prevents a dashboard bug or refresh loop from triggering a $5 Gemini run. Cost protection.
  - **Blocks:** safe multi-user access, Railway deployment
  - **Effort:** S
  - **Source:** OVERNIGHT_TASKS.md QUEUED

### 🟠 Should-Have

- **Railway migration**
  - **What:** Move CWN from localhost to Railway. Node API, VectCut API, dashboard, persistent `data/*.json` storage, env vars, domain.
  - **Why:** Rob's strategy: *"localhost = sandbox until outgrown by feature gap, not date-driven."* The feature gap that triggers this is multi-user access, scheduled runs outside Rob's waking hours, or monitoring reliability. Currently blocking #1 is just "Rob's Mac has to be awake for overnight runs."
  - **Blocks:** GitLab revisit, multi-tenant features, scheduled content generation (Task #21)
  - **Effort:** L (Node + Python services + persistent storage + secrets)
  - **Source:** memory `project_railway_migration_strategy`, RAILWAY_MIGRATION_DECISION.md

- **Dashboard metrics panel (unified per-run report)**
  - **What:** Build `/metrics/:jobId` endpoint that stitches the three separate `run_metrics_*.json` files (`script_twitch_*`, `asm_*`, `publish_*`) into one unified response. Add "📊 RUN METRICS" collapsible panel to each job card showing per-stage wall time + totals inline.
  - **Why:** Metrics write to disk only — no UI surface. Three separate files per run instead of one unified report. Rob has never seen the timing data.
  - **Blocks:** cost optimization decisions
  - **Effort:** M
  - **Source:** OVERNIGHT_TASKS.md BLOCKED "POST-12-A"

- **Structured logging enhancement**
  - **What:** Add log levels (DEBUG/INFO/WARN/ERROR), request IDs, and duration tracking to `lib/error_logger.js`. Correlation IDs flow through all log statements in a request.
  - **Why:** Currently debugging a failed run means grep-scrolling nodemon output. Structured logs enable actual log-aggregation tools post-Railway.
  - **Blocks:** Railway observability, known-errors catalog value
  - **Effort:** M
  - **Source:** OVERNIGHT_TASKS.md QUEUED

- **Gate 6 retry logic + per-platform status tracking**
  - **What:** Upgrade publish delivery from "basic success check" to retry with backoff, platform-specific error handling, per-platform status tracking. Enables Gate 7 (Rob reviews) to show "approved on TikTok, pending IG, rejected YT" state cleanly.
  - **Why:** Currently a single platform failure silently loses that delivery. Short-form fan-out (3 platforms × short) makes this much worse.
  - **Blocks:** short-form fan-out architecture
  - **Effort:** M
  - **Source:** POST_PUBLISH_TASKS.md §4.4

- **Style library per-content-type support**
  - **What:** `cwn_style_guides.json` currently has per-content-type keys, but the `/analyze-style-library` endpoint assumes one URL list fed in per call. Upgrade endpoint to accept `contentType` parameter and store the 3 fingerprints separately. Rob then feeds 3 different URL lists (one for Twitch reactions, one for NBA narration, one for News anchor style).
  - **Why:** Enables per-content-type style learning. Unblocks NBA and News style quality ceilings.
  - **Blocks:** NBA reference URL list, News reference URL list
  - **Effort:** M
  - **Source:** POST_PUBLISH_TASKS.md §3.3, Rob's note during roadmap planning

- **Short-form fan-out architecture (Gate 5 → 3× Gate 6)**
  - **What:** After Gate 5 passes on a short, branch into 3 parallel Gate 6 delivery jobs (TikTok, IG Reels, YT Shorts). Per-platform job persistence, dashboard fan-out UX (checkboxes, 3 parallel progress indicators).
  - **Why:** Short-form ships to 3 platforms simultaneously. Current serial publish is slow and fragile.
  - **Blocks:** short-form production at scale
  - **Effort:** L
  - **Source:** POST_PUBLISH_TASKS.md §4.1
  - **Depends on:** Gate 6 retry logic

- **Title / description generator quality investigation**
  - **What:** Rob currently uses ChatGPT instead of `/generate-publish-copy` because the output isn't good enough. Investigate what's wrong with the current Claude-based generator (prompt? context? reference examples?) and either improve it or replace it.
  - **Why:** Every published video requires manual Rob work that should be automated. Fixing this eliminates a recurring friction point.
  - **Blocks:** full autonomous publish pipeline
  - **Effort:** S (prompt refinement) or M (full replacement)
  - **Source:** memory `feedback_title_desc_generator`

- **`/health` endpoint for Railway load-balancer compatibility**
  - **What:** Tiny `lib/routes/health.js` returning `{status, uptime, version, node_version, memory_usage_mb, active_jobs_count, last_commit_hash}`. <10ms latency, no external calls.
  - **Why:** Railway and any load balancer needs a lightweight health check. Currently only heavy endpoints exist.
  - **Blocks:** Railway deployment
  - **Effort:** XS
  - **Source:** OVERNIGHT_TASKS.md INDEPENDENT
  - **Depends on:** server.js module split (for the registration pattern)

### 🟡 Could-Have

- **Rebrand Twitch and NBA long-form to match the News newscast chrome design**
  - **What:** After News long-form passes its test cases, port the locked News newscast chrome layout to Twitch and NBA long-form so all three shows share the same broadcast-graphics visual language. Key elements to replicate: top bar with show name ("BECAUSE THE LIGHT WAS ON" or per-show equivalent) + "Episode N" + LIVE indicator + date; left-side lower-third TV card (720px wide, top:48) with gold category strip + navy headline strip; right-side always-on story/streamer/game list sidebar at 420px with uniform 90px min-height items and red ▶ ON AIR highlight that moves per segment; top-right segment-tag with "NOW COVERING / {category}" that updates per active item; logo repositioned from top-left to on-the-mug in Bobby G's desk scene at `{x:1725, y:910, size:90, opacity:0.85}` (same coffee mug, same position across all 3 shows). Also includes the state machine pattern: sidebar and top bar always-on from frame 0 through last word; TV card time-gated at first `CONFIG.INTRO_CARD.DURATION_SECONDS` seconds of each section's INTRO scene then hidden for remainder of that section's cycle; cold open pre-highlights first item; outro keeps last item highlighted.
  - **Why:** Brand consistency across the three content types. Currently Twitch uses a small top-right TV card (`OVERLAY_ZONE = {x:1360, y:60, w:520, h:293}`) and NBA uses the same zone with a different Canvas-generated PNG. News is getting the richer full-chrome design in Fix 7 and it should become the shared visual language for all three shows. Rob's directive 2026-04-12 evening: *"post test cases I want to rebrand this look for the other shows."*
  - **Blocks:** shared long-form visual-design spec (informal today; should become `VISUAL_DESIGN_SPEC.md` long-form section when this ships)
  - **Effort:** L — touches `server.js` Twitch and NBA per-segment burn branches + `lib/config.js` OVERLAY_ZONE/LOGO_POS values + possibly new Canvas/HTML template files for Twitch and NBA equivalents of `clipzworld_newscast.html` + Gate 3 prompt updates so Gemini's TV-card check recognizes the new chrome (Fix 7 only fixes this for News)
  - **Source:** Rob directive 2026-04-12 evening after Fix 7 preview approval (captured in LONGFORM_FIX_ROTATION.md rotation log + inline comment at the top of `tools/clipzworld_newscast.html` so the decision survives even if this roadmap doc is archived). Reference implementation: the Fix 7 `clipzworld_newscast.html` template and the server-side state machine it introduces.
  - **Depends on:** News long-form passes all test cases (Fix 7 ships and Rob reviews a full News run end-to-end with visible chrome); NBA and Twitch long-form also pass their test cases (so we're not rebranding a content type that has other known-broken creative work). Effectively post-6-case-completion.

- **Avatar 5 migration**
  - **What:** Side-by-side comparison render (current landscape 4K avatar vs Avatar 5), pick winner. Tests micro-expression quality, idle gesture range, lip-sync, emotional delivery, matting.
  - **Why:** Avatar 5 is the next-gen HeyGen avatar. Currently blocked on API access (~1-2 months per HeyGen support per POST_PUBLISH_TASKS §4.6).
  - **Blocks:** Bobby G micro-glitch at segment boundaries fix, emotion parameter experiments
  - **Effort:** M (once API access lands)
  - **Source:** POST_PUBLISH_TASKS.md §4.6

- **Per-scene emotion parameter experiments**
  - **What:** Probe script `scripts/probe_heygen_emotions.js` tests which emotion values and field locations HeyGen accepts. Then build scene-type → emotion mapping (COLD_OPEN → serious, CLIP_SETUP → neutral, CLIP_REACTION → happy/deadpan, etc.).
  - **Why:** Currently all scenes render with the same avatar emotional range. Per-scene emotion would lift creative ceiling on all 3 content types.
  - **Blocks:** nothing
  - **Effort:** M (probe script) + L (mapping architecture)
  - **Source:** POST_PUBLISH_TASKS.md §4.5, HEYGEN_OPTIONS_INVENTORY.md
  - **Depends on:** Avatar 5 migration (API availability)

- **Bobby G micro-glitch at segment boundaries**
  - **What:** Subtle shoulder/hand position change at scene transitions visible as a "tick" when FFmpeg concats back-to-back HeyGen segments. Mitigations: short crossfade (0.15–0.3s), frame-freeze hold at segment ends, per-scene emotion parameter, or Avatar 5 migration.
  - **Why:** Polish item. Viewer-noticeable micro-tick on every transition.
  - **Blocks:** nothing
  - **Effort:** M (crossfade approach) — L (Avatar 5 solves it architecturally)
  - **Source:** POST_PUBLISH_TASKS.md §2.4
  - **Depends on:** Avatar 5 migration (best fix path)

- **Drawtext ticker replacement (Task #22)**
  - **What:** Replace Puppeteer pre-rendered MP4 ticker with FFmpeg `drawtext` filter. Smooth integer-math scrolling instead of 30fps cached MP4.
  - **Why:** Eliminates the remaining ticker stutter class of bugs entirely. Ticker becomes deterministic and restart-safe (no cache warmup step).
  - **Blocks:** nothing
  - **Effort:** L (~4 hours Cline work per STATUS.md row 83)
  - **Source:** STATUS.md Task #22

- **Prometheus `/metrics` endpoint**
  - **What:** New `lib/routes/metrics.js` emitting Prometheus exposition format: total_jobs_processed, jobs_per_gate_pass/fail, ffmpeg_assembly_seconds_histogram, gemini_api_calls_total, heygen_segment_count_total, current_active_jobs.
  - **Why:** Grafana dashboard integration post-Railway. Observability baseline.
  - **Blocks:** production monitoring
  - **Effort:** M
  - **Source:** OVERNIGHT_TASKS.md INDEPENDENT
  - **Depends on:** server.js module split, `/health` endpoint pattern

- **Unit tests for `parseSegments_v2` + Gate 2 validator**
  - **What:** Take the 10 test cases in `test/GATE2_TEST_CASES.md` and turn them into executable `node:test` tests. Each asserts segment count, labels, clip order against a hand-crafted script input.
  - **Why:** Gate 2 is the foundation of the gated pipeline (Phase 1). Automated tests prevent regressions when future script prompt changes land.
  - **Blocks:** confidence in future script prompt refactors
  - **Effort:** M (2 hours)
  - **Source:** OVERNIGHT_TASKS.md INDEPENDENT

- **`qa_failures/` rotation script**
  - **What:** Nightly script keeps 50 most-recent files per gate kind, compresses older files into `archive_YYYY-MM-DD.tar.gz`, deletes archives older than 90 days.
  - **Why:** 343 files and growing. At production scale (100 jobs/day × 6 gates = 600/day = 18K/month) the directory becomes unusable and disk usage blows up.
  - **Blocks:** production scale
  - **Effort:** S
  - **Source:** OVERNIGHT_TASKS.md INDEPENDENT

- **Nightly backup of `data/*.json` to Google Drive**
  - **What:** Node script tar.gzs `data/jobs.json`, `data/streamers.json`, `data/cwn_style_guides.json`, `data/episode_counters.json`, `data/upload_status.json`, uploads to Drive. 30-day retention.
  - **Why:** `data/` is runtime state, not in git. Losing it loses job history, episode counters, streamer config. Cheap insurance.
  - **Blocks:** nothing
  - **Effort:** S
  - **Source:** OVERNIGHT_TASKS.md INDEPENDENT

- **Known-errors catalog from `logs/errors.jsonl`**
  - **What:** Parse errors.jsonl, group by normalized message, write a searchable markdown catalog with pattern, frequency, root cause, fix strategy, examples.
  - **Why:** When a new error surfaces in production, first question is "have we seen this before?" Cuts diagnosis time from hours to minutes.
  - **Blocks:** Gate 1 diagnostic upgrade quality
  - **Effort:** S
  - **Source:** OVERNIGHT_TASKS.md INDEPENDENT

- **Markdown link linter**
  - **What:** Node script walks every `.md` file, extracts markdown links, verifies each target exists. Reports broken links, exits 1 on breakage. Optional pre-commit hook.
  - **Why:** 15+ handoff files + architecture docs. Cross-references go stale as files move (e.g. archived handoffs). Other agents read broken links and work from wrong assumptions.
  - **Blocks:** doc hygiene at scale
  - **Effort:** S
  - **Source:** OVERNIGHT_TASKS.md INDEPENDENT

- **Test suite restructure (12 → 6 cases)**
  - **What:** Rewrite `test/test_suite_12cases.json` from 12 cases stopping at Gate 6 → 6 cases going all the way to platform private drafts (3 long-form + 3 short-form, one per content type per form).
  - **Why:** Current test suite is outdated — runner may need to push through to Upload-Post or be deprecated in favor of dashboard-driven runs.
  - **Blocks:** automated regression testing post-test-completion
  - **Effort:** M
  - **Source:** POST_PUBLISH_TASKS.md §4.3

- **Database migration (JSON → SQLite/Postgres)**
  - **What:** Move `data/jobs.json`, `data/upload_status.json`, `data/episode_counters.json` from flat JSON files to SQLite (local) or Postgres (Railway). Multi-tenant preparation.
  - **Why:** JSON files are single-writer, no concurrent access, no transactions. At scale or multi-user, this breaks.
  - **Blocks:** multi-tenant features
  - **Effort:** L
  - **Source:** OVERNIGHT_TASKS.md "Future INDEPENDENT tasks"
  - **Depends on:** Railway migration (triggers the need)

- **Audit trail for rollback/force-advance**
  - **What:** Dashboard log + `logs/errors.jsonl` append on every rollback/advance event with `{level:'warn', kind, jobId, before, after, at}`. Currently untracked.
  - **Why:** No way to diagnose "why did this job get to stage X" when rollback/advance was used. Tech Debt #5 in STATUS.md.
  - **Blocks:** production debugging
  - **Effort:** S
  - **Source:** STATUS.md Tech Debt #5, ROLLBACK_FORCE_ADVANCE_SPEC.md

- **Phonetic auto-injection from `streamers.json`**
  - **What:** Read `phonetic` field from `streamers.json` at script gen time, auto-inject into HeyGen `input_text`. Currently manual.
  - **Why:** Bobby G mispronounces names that have phonetic entries because they aren't wired through.
  - **Blocks:** nothing
  - **Effort:** S
  - **Source:** OVERNIGHT_TASKS.md QUEUED (blocked-by was the scene count fix which is done)

- **Streamer dropdown UX (Task #8)**
  - **What:** Multi-select UI replacing the textarea for streamer input. Dashboard convenience.
  - **Why:** Reduces typos, exposes the full roster, faster workflow.
  - **Blocks:** nothing
  - **Effort:** M
  - **Source:** STATUS.md Task #8

- **Scheduled content generation from dashboard (Task #21)**
  - **What:** Schedule runs from dashboard UI (daily 7 AM Twitch, etc.) instead of manual trigger.
  - **Why:** Production autonomy. Currently requires Rob to be at the keyboard.
  - **Blocks:** fully autonomous daily production
  - **Effort:** L
  - **Source:** STATUS.md Task #21
  - **Depends on:** Railway migration

- **Stage 3.5 Topaz ring removal (Task #18)**
  - **What:** Investigate removing Topaz upscaling stage. May be unnecessary with landscape-native 4K avatar.
  - **Why:** Topaz adds cost + time. If the new avatar is already high enough quality, Topaz is dead weight.
  - **Blocks:** nothing
  - **Effort:** S (investigate) or M (remove + verify quality)
  - **Source:** STATUS.md Task #18

- **`/assemble` status=done race condition (Task #15)**
  - **What:** Investigate and fix race condition where `/assemble` status returns `done` before all outputs are actually written.
  - **Why:** Causes intermittent "file not found" errors in downstream consumers.
  - **Blocks:** reliable dashboard state transitions
  - **Effort:** S
  - **Source:** STATUS.md Task #15

- **Duplicate `/generate-thumbnail` route removal**
  - **What:** server.js lines 9242 and 9575 define two routes with same path. Second silently overrides first. Audit both, keep correct one, remove duplicate.
  - **Why:** Code hygiene. Bug magnet.
  - **Blocks:** nothing
  - **Effort:** XS
  - **Source:** OVERNIGHT_TASKS.md QUEUED

- **Legacy publish stub routes cleanup**
  - **What:** `/publish/youtube`, `/publish/tiktok`, `/publish/instagram` at server.js:7539–7705 are stubs that call `/publish`. Either remove (if dashboard doesn't use) or document as intentional.
  - **Why:** Code hygiene.
  - **Blocks:** nothing
  - **Effort:** XS
  - **Source:** OVERNIGHT_TASKS.md QUEUED

- **Gate 1 diagnostic upgrade (Phase 2)**
  - **What:** Upgrade Gate 1 clip availability report from generic "not in this episode" to 9 specific failure modes (TWITCH_API_EMPTY, STREAMER_NOT_FOUND, GQL_RESOLUTION_FAILED, CDN_DOWNLOAD_BLOCKED, GEMINI_ANALYSIS_TRUNCATED, etc.) each with cause + evidence + fix suggestion.
  - **Why:** Current generic diagnostics make root-causing clip failures slow. Per GATED_PIPELINE_ARCHITECTURE.md §4.4 — Gate 1 partially done, this completes it.
  - **Blocks:** Gate 1 strategy-based fix proposals
  - **Effort:** M
  - **Source:** `CLINE_HANDOFF_GATE1_CLIP_DIAGNOSTIC_UPGRADE.md` (still in repo root, Phase 2 pending)

- **Gate 2 Gemini judge fallback for ambiguous cases**
  - **What:** Current Gate 2 uses a pure-code 6-check validator. Add Gemini as a judge when the validator flags ambiguous cases (not clearly pass or fail).
  - **Why:** Gate 2 mostly done but lacks the fallback for edge cases. Per GATED_PIPELINE_ARCHITECTURE.md §4.4.
  - **Blocks:** Gate 2 self-healing completeness
  - **Effort:** M
  - **Source:** POST_PUBLISH_TASKS.md §4.4

- **Gate 3 automated re-render fix path**
  - **What:** When Gate 3 (HeyGen render QA) fails a segment, automatically trigger re-render with phonetic enhancement or parameter adjustment instead of just pass/fail.
  - **Why:** Current Gate 3 has no fix path — if lip sync is bad, the pipeline stops. Per GATED_PIPELINE_ARCHITECTURE.md §4.4.
  - **Blocks:** full Gate 3 self-healing
  - **Effort:** L
  - **Source:** POST_PUBLISH_TASKS.md §4.4

- **Gate 4 frame-level analysis upgrades**
  - **What:** Expand current assembly QA to include frame-level analysis at segment boundaries, pillarbox detection, overlay verification. Rename from "Gate 3" to "Gate 4" to match architecture.
  - **Why:** Current check is basic. Per GATED_PIPELINE_ARCHITECTURE.md §4.4.
  - **Blocks:** confidence in boundary-level issues
  - **Effort:** L
  - **Source:** POST_PUBLISH_TASKS.md §4.4
  - **Note:** Fix 3 in the active News rotation adds clip-presence + TV-card checks to this gate — narrows the gap.

- **Gate 7 dashboard feedback loop**
  - **What:** Approve/Reject buttons on job cards already exist but don't feed back to the pipeline state machine cleanly. Wire the feedback so Gate 7 decisions update `persistedJobs` and trigger per-platform status changes.
  - **Why:** Per GATED_PIPELINE_ARCHITECTURE.md §4.4 — Gate 7 is currently manual-only, no closed loop.
  - **Blocks:** full 7-gate self-healing architecture
  - **Effort:** M
  - **Source:** POST_PUBLISH_TASKS.md §4.4

### ⚪ Won't-Have (yet — explicitly deferred)

- **4K canvas migration**
  - **What:** Migrate full pipeline from 1080p to 4K native. Parked per `FUTURE_4K_MIGRATION_PLAN.md` — recommendation is to stay at 1080p and benefit from avatar supersampling.
  - **Why deferred:** 1080p is the right target; 4K adds cost + complexity without visible creative upside at YouTube's typical viewer resolution.
  - **Source:** FUTURE_4K_MIGRATION_PLAN.md

- **Jira + Confluence migration**
  - **What:** Move task tracking from in-repo markdown to Jira + Confluence. Deterministic cron sync script + agent-driven manual sync handles 10% edge cases, Atlassian native GitHub app handles 90% of commit↔issue linking.
  - **Why deferred:** Rob will handle Atlassian signup himself. Migration plan writing parked until pipeline is stable — "not when we're actively rotating test-case fixes."
  - **Source:** STATUS.md row 83, OVERNIGHT_TASKS.md blocked task

- **GitLab vs GitHub revisit**
  - **What:** Revisit whether to move repo hosting from GitHub to GitLab before locking CI/CD.
  - **Why deferred:** Parked until Railway deployment. Decision should be made *before* CI/CD locks in, not after.
  - **Source:** memory `project_gitlab_revisit`

- **Photo Avatar Motion API migration**
  - **What:** Migrate Bobby G from studio avatar to photo avatar to unlock `/v2/photo_avatar/add_motion` for signature sign-off motions.
  - **Why deferred:** Requires architectural migration to photo avatar; studio avatars don't support the endpoint. Only revisit if the "library of pre-rendered sign-off clips" path (Could-Have in Twitch bucket) doesn't deliver the desired effect.
  - **Source:** POST_PUBLISH_TASKS.md §3.1 "Path A"

- **Video Agent API**
  - **What:** HeyGen Video Agent API experiment — alternative to studio avatar.
  - **Why deferred:** Post-test investigation. No evidence yet that it outperforms the current landscape 4K setup.
  - **Source:** STATUS.md row 58

- **ElevenLabs voice integration**
  - **What:** Feed ElevenLabs voice clones to HeyGen via `voice.type='audio'` + `audio_url`. Tier 5 escape hatch for voice quality.
  - **Why deferred:** Parked until CWN exhausts native HeyGen options (emotion parameter, Starfish engine, default voice pairing).
  - **Source:** HEYGEN_OPTIONS_INVENTORY.md

- **Starfish TTS engine probe**
  - **What:** Confirm whether `engine=starfish` works on V2 `video/generate` or only on V3 `voices` endpoint. May require 2-call flow (V3 voice → V2 video with audio_url).
  - **Why deferred:** Architectural uncertainty, may require refactor for unclear upside.
  - **Source:** HEYGEN_OPTIONS_INVENTORY.md

---

---

## Bucket 5 — Platform Ownership (Direct API + TubeBuddy Lite)

**Strategic context:** Upload-Post and TubeBuddy are middlemen calling the same YouTube, TikTok, and Instagram APIs that AuraFlux has direct access to. The path to full platform ownership is phased — Upload-Post stays until direct is proven, then removed. TubeBuddy stays as a personal tool until AuraFlux Analytics replaces its value with customer-specific data.

**Why this matters for Customer 1:** A customer publishing through AuraFlux direct owns their analytics relationship. AuraFlux knows their specific audience, their specific content performance, their specific best publish windows. That data moat is what makes AuraFlux defensible — competitors can't replicate it because it's built from each customer's own channel data.

### 🔴 Must-Have (Phase 2 — Render deploy prerequisite)

- **Pre-publish validator against platform API limits**
  - **What:** Hard gate before Upload-Post fires. Validates every field against YouTube (title ≤100 chars, description ≤5000 bytes, tags ≤500 chars total), TikTok (caption ≤2200 UTF-16 runes, no scheduling), Instagram (caption ≤2200 chars, ≤30 hashtags, Reels ≤15min/300MB) limits. Fails loudly with specific field + limit + current value.
  - **Why:** Currently no validation — Upload-Post rejects silently or truncates. Platform API limits documented in `docs/architecture/PIPELINE_CONTRACT_SPEC.md`.
  - **Blocks:** reliable upload, Customer 1 readiness
  - **Effort:** S
  - **Source:** `CLINE_HANDOFF_PUBLISH_SYSTEM_OVERHAUL.md`, `docs/specs/PUBLISH_COPY_SPEC.md`

- **Publish copy overhaul — ChatGPT-quality output**
  - **What:** Rewrite `handleGeneratePublishCopy()` to produce: timestamps from actual segment durations, 5 A/B title variants, 4 thumbnail text options, content-type specific categoryId, channel handle variable in pinned comment, full hashtag sets per show, per-platform captions. Reference format: `docs/specs/PUBLISH_COPY_SPEC.md`.
  - **Why:** Rob uses ChatGPT instead of the endpoint. Every published video requires manual work that should be automated.
  - **Blocks:** full autonomous publish pipeline
  - **Effort:** M
  - **Source:** `CLINE_HANDOFF_PUBLISH_SYSTEM_OVERHAUL.md`, memory `feedback_title_desc_generator`

- **Upload-Post wiring fix**
  - **What:** `thumbnail_url` + `pinnedComment` required (hard fail if missing, not silent drop). Hashtags appended to description footer. Tags always sent from publish-copy. categoryId from publish-copy not hardcoded. TikTok full caption not 90-char truncated. embeddable/license/publicStatsViewable always sent.
  - **Why:** Critical fields silently dropped today — YouTube gets black frame thumbnails, no pinned comment, wrong category.
  - **Blocks:** upload quality
  - **Effort:** S
  - **Source:** `CLINE_HANDOFF_PUBLISH_SYSTEM_OVERHAUL.md`

### 🟠 Should-Have (Phase 2 — after Render deploy)

- **Direct YouTube upload (alongside Upload-Post)**
  - **What:** Implement YouTube Data API v3 `videos.insert` directly in AuraFlux. One endpoint, two providers (Upload-Post or direct), same Job Spec. Customer or operator selects provider. Scheduling via `privacyStatus: PRIVATE` + `publishAt`.
  - **Why:** Removes Upload-Post dependency for YouTube. Enables title updates (`videos.update`), analytics reads, and scheduling from the same auth flow.
  - **Blocks:** title switcher (post-publish), analytics integration, content calendar
  - **Effort:** L
  - **Source:** 2026-04-18 platform ownership strategy discussion

- **Direct TikTok posting (alongside Upload-Post)**
  - **What:** Implement TikTok Content Posting API directly. `privacy_level: SELF_ONLY` for private drafts. Note: TikTok has no scheduling API — post immediately or use SELF_ONLY + manual flip.
  - **Why:** Removes Upload-Post dependency for TikTok. Direct control over caption, privacy, AI disclosure flags.
  - **Blocks:** full Upload-Post removal
  - **Effort:** M
  - **Source:** 2026-04-18 platform ownership strategy discussion

- **Direct Instagram posting (alongside Upload-Post)**
  - **What:** Implement Instagram Graph API directly. Reels via `media_type: REELS`. Scheduling via `published: false` + `scheduled_publish_time`. Rate limit: 100 posts/24h.
  - **Why:** Removes Upload-Post dependency for Instagram. Direct control over caption, hashtags, scheduling.
  - **Blocks:** full Upload-Post removal
  - **Effort:** M
  - **Source:** 2026-04-18 platform ownership strategy discussion

- **Post-publish outcome card in dashboard**
  - **What:** After upload confirms, surface a card showing: all platform statuses, thumbnail applied, title used, pinned comment posted. Manual items: end screen + cards (add in Studio — can't be automated), chapters (verify YouTube parsed them — add manually if not), playlist (assign in Studio). Title switcher reads stored alternatives from Job Spec. Flip to public button.
  - **Why:** Customer sees outcomes not instructions. Everything automatic shown as ✅. Three Studio deep links for what genuinely can't be automated.
  - **Blocks:** Customer 1 UX
  - **Effort:** M
  - **Source:** `CLINE_HANDOFF_PUBLISH_SYSTEM_OVERHAUL.md`, 2026-04-18 discussion

- **Thumbnail auto-generation via Gemini Imagen + Canva**
  - **What:** Claude selects template variant (reaction/drama/funny/clean) + hook text from publish-copy output → Gemini Imagen generates background image from ChatGPT-style prompt → Canva autofill (image + hook text) → export → `thumbnail_url` in upload package. Long-form only — Shorts use `cover_timestamp`.
  - **Why:** Thumbnail currently manual — operator exports from Canva each time. Auto-generation means thumbnail goes with the video automatically.
  - **Blocks:** fully automatic upload package
  - **Effort:** L (Gemini Imagen integration + Canva autofill wiring)
  - **Source:** `docs/specs/PUBLISH_COPY_SPEC.md`, 2026-04-18 discussion

### 🟡 Could-Have (Phase 3 — Customer 1 readiness)

- **Remove Upload-Post entirely**
  - **What:** Once direct YouTube + TikTok + Instagram are proven in production, remove Upload-Post dependency. All publishing goes direct. `UPLOADPOST_API_KEY` removed from env.
  - **Why:** Cost reduction ($50/mo flat), full ownership of publish flow, no third-party dependency for core function.
  - **Blocks:** nothing
  - **Effort:** S (removal only — direct APIs already built by this point)
  - **Depends on:** Direct YouTube + TikTok + Instagram all stable in production
  - **Source:** 2026-04-18 platform ownership strategy discussion

- **YouTube Analytics integration (TubeBuddy lite — Phase 1)**
  - **What:** Pull YouTube Analytics API data per customer channel: CTR by title, retention by content type, views by publish day/time. Surface in AuraFlux dashboard as a performance panel per job. Use data to generate content calendar suggestions.
  - **Why:** TubeBuddy shows this data via browser extension. AuraFlux can show it in the dashboard, specific to each customer's channel, without a subscription or ToS risk. CTR per title enables real A/B tracking not just guessing.
  - **Blocks:** data-driven content calendar, Customer 1 data moat
  - **Effort:** L
  - **Depends on:** Direct YouTube upload (same OAuth flow)
  - **Source:** 2026-04-18 platform ownership strategy discussion

- **Content calendar — audience-data driven**
  - **What:** Replace generic "post at 7pm Tuesday" suggestions with suggestions derived from each customer's actual YouTube Analytics (when their specific audience is online, what days/times their videos perform best). Show in scheduling UI at `app.auraflux.co`. Customer selects suggested time or picks their own. Selection saved to `deliverySpec.scheduledAt` in Job Spec.
  - **Why:** Current Customer 0 scheduling is manual in YouTube Studio. Customer 1 needs it in the AuraFlux dashboard with data behind the suggestions.
  - **Blocks:** full scheduling autonomy for Customer 1
  - **Effort:** L
  - **Depends on:** YouTube Analytics integration, direct YouTube upload (for `publishAt`)
  - **Source:** `docs/architecture/PIPELINE_CONTRACT_SPEC.md` scheduling section, 2026-04-18 discussion

- **YouTube Search Console integration (TubeBuddy lite — Phase 2)**
  - **What:** Pull YouTube Search Console / keyword data via YouTube Data API. Surface tag performance, search impression data, keyword opportunities per content type. Claude uses this data to improve tag and title generation in publish copy.
  - **Why:** TubeBuddy's tag suggestions use search volume data. AuraFlux can approximate this from each customer's own search impression data — more relevant than generic keyword research.
  - **Blocks:** nothing
  - **Effort:** L
  - **Depends on:** YouTube Analytics integration
  - **Source:** 2026-04-18 platform ownership strategy discussion

### ⚪ Won't-Have (yet)

- **YouTube cards + end screens via API**
  - **Why:** YouTube Data API does not support cards or end screens. Manual in YouTube Studio — confirmed no automation path. Dashboard post-publish card surfaces these as manual items with Studio deep links.

- **TikTok scheduling via API**
  - **Why:** TikTok Content Posting API does not support scheduling. Posts immediately. Workaround: upload as `SELF_ONLY` (private), dashboard shows reminder to flip at scheduled time manually.

- **A/B thumbnail testing via API**
  - **Why:** No platform API supports A/B thumbnail testing. TubeBuddy wraps YouTube's internal experiment system which is not publicly accessible. AuraFlux approach: store 5 title variants + 4 thumbnail text options in Job Spec, operator switches via dashboard, CTR tracked via Analytics integration.

- **TubeBuddy API integration**
  - **Why:** TubeBuddy has no public API. Browser extension only. Automation would violate their ToS and YouTube's API terms. Not viable. AuraFlux builds the equivalent value directly from YouTube APIs.

---

## Maintenance notes

- **When a new post-test item surfaces in conversation or a doc:** add it to the correct bucket with all 5 fields. Don't just drop it in without Blocks + Effort + Source.
- **When an item ships:** delete it. This doc is not an activity log — that's `STATUS.md`.
- **When MoSCoW tiers shift:** update and date in the rotation log below. Tier shifts usually signal a dependency changed or business priority moved.
- **Keep this doc ≤ 1 page per bucket.** If a bucket grows beyond ~15 items, it's time to prune Could-Haves or promote some to Won't-Have.
- **Never duplicate items between this doc and the rotation docs.** If it's test-blocking, it's in `LONGFORM_FIX_ROTATION.md` / `SHORTFORM_FIX_ROTATION.md`. If it's post-test, it's here. Pointer references are fine; duplication is not.

## Rotation log

| Date | Change |
|------|--------|
| 2026-04-12 | Doc created. Harvested from STATUS.md Tech Debt, POST_PUBLISH_TASKS.md §2–4, OVERNIGHT_TASKS.md (QUEUED + INDEPENDENT + BLOCKED), CLAUDE.md Pending Features, GATED_PIPELINE_ARCHITECTURE.md §4.4, SERVER_SPLIT_PLAN.md, HEYGEN_OPTIONS_INVENTORY.md, memory files. ~45 items across 4 buckets. |
| 2026-04-18 | Added Bucket 5 — Platform Ownership. Strategy: Upload-Post and TubeBuddy are middlemen calling the same APIs AuraFlux has direct access to. Phase 2: direct YouTube/TikTok/Instagram alongside Upload-Post. Phase 3: Upload-Post removed, full direct ownership. Phase 3+: YouTube Analytics + Search Console integration = TubeBuddy lite, data-driven content calendar per customer. TubeBuddy (no API, ToS violation risk) documented as Won't-Have. Cards/end screens/TikTok scheduling/A/B thumbnails all confirmed as platform limitations — documented in Won't-Have with AuraFlux workarounds. Also: publish copy overhaul + upload-post wiring fix promoted to Must-Have (handoff written: CLINE_HANDOFF_PUBLISH_SYSTEM_OVERHAUL.md). Railway references updated to Render throughout. |
