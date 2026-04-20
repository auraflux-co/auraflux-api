# Render Readiness — Jira Epic + Stories

**Created:** 2026-04-17
**Note:** Jira MCP was not available at time of creation. Paste these into Jira project CPD manually, or run via Jira API using `lib/clients/jira_client.js`.

---

## Epic: Phase 1 Production Render — All 3 Content Types Locked

**Project:** CPD
**Type:** Epic
**Priority:** High
**Labels:** `phase_1`, `render`, `qa`

**Description:**

First real production renders for News, Twitch, and NBA after synth test QA passes. Each content type runs through the full gate sequence (0→4) and produces a publishable episode.

Completion of this epic = Phase 1 locked per `docs/strategy/AUTONOMOUS_PRODUCTION_ROADMAP.md`.

**Definition of Done:**
- News, Twitch, and NBA each have ≥1 successful end-to-end production render
- All runs: Gate 1 ≥90, Gate 2 ≥85, Gate 3 ≥70, Gate 4 job_id present
- Rob visual review passed ("ship it") for each content type
- `run_metrics_*.json` saved for each run
- Synth test suite passing for all 4 show types (permanent pre-render gate)

---

## Story 1: News Production Render

**Title:** `[RENDER] News — first production episode end-to-end`
**Type:** Story
**Epic:** Phase 1 Production Render — All 3 Content Types Locked
**Assignee:** Sub-Agent A (`sub_agent_a`)
**Labels:** `render`, `news`, `gate_sequence`
**Story Points:** 3
**Priority:** High

**Description:**

Run first real News production render through all gates. Uses Al Jazeera portrait clips (9:16). Expect 4-6 stories. Bobby G narrates with newscast chrome overlay.

Pre-requisites:
- Synth test `node test/synth_assembly_test.js news` exits 0
- `GATE_TEST_MODE` is not `true` in `.env`
- Disk space ≥10 GB free

**Acceptance Criteria:**

- [ ] Gate 0 PASS: AJ scraper returns ≥4 portrait clips (9:16)
- [ ] Gate 1 PASS: Script score ≥90, no placeholders, correct scene count
- [ ] HeyGen renders all segments (no stuck renders, all COMPLETED status)
- [ ] Gate 2 PASS: Score ≥85 on sampled segments
- [ ] Gate 3 PASS: Score ≥70 on assembled video
- [ ] Gate 4 PASS: Video uploaded to Drive, published to YouTube + TikTok
- [ ] Rob visual review: "ship it"
- [ ] `run_metrics_*.json` saved with all stage timings

**Subtasks:**

1. Verify AJ scraper returns portrait clips (Gate 0) — check `GET /news/us-canada-videos`
2. Run script gen, confirm Gate 1 auto-pass (score ≥90)
3. Monitor HeyGen segments via dashboard — all segments reach COMPLETED status (Gate 2)
4. Review assembly output — watch video, confirm chrome overlay, clips, audio (Gate 3)
5. Confirm Drive upload + multi-platform publish (Gate 4)

**Notes:**
- Script gen ~90s (Gemini video analysis)
- HeyGen render ~8-10min (35-45 segments)
- Assembly ~4min
- Total expected: ~16min end-to-end

---

## Story 2: Twitch Production Render

**Title:** `[RENDER] Twitch — first production episode end-to-end`
**Type:** Story
**Epic:** Phase 1 Production Render — All 3 Content Types Locked
**Assignee:** Sub-Agent A (`sub_agent_a`)
**Labels:** `render`, `twitch`, `gate_sequence`
**Story Points:** 3
**Priority:** High

**Description:**

Run first real Twitch production render. Clips from Twitch CDN — URLs expire in ~1 hour. Must complete assembly within 1 hour of script approval or re-resolve clip URLs.

Pre-requisites:
- Synth test `node test/synth_assembly_test.js twitch` exits 0
- `GATE_TEST_MODE` is not `true` in `.env`
- Disk space ≥10 GB free

**Acceptance Criteria:**

- [ ] Gate 0 PASS: ≥8 streamers with valid CDN clip URLs
- [ ] Gate 1 PASS: Script score ≥90, all streamer display names correct (not Twitch usernames)
- [ ] HeyGen renders all segments (no stuck renders)
- [ ] Gate 2 PASS: Score ≥85
- [ ] Gate 3 PASS: Score ≥70, source clips visible (not just avatar segments)
- [ ] Gate 4 PASS: Video published to YouTube + TikTok + Instagram
- [ ] Rob visual review: "ship it"
- [ ] `run_metrics_*.json` saved with all stage timings

**Subtasks:**

1. Verify ≥8 streamers have valid Twitch CDN clip URLs
2. Run script gen, confirm Gate 1 auto-pass
3. Start HeyGen render — monitor for stuck segments
4. Verify assembly uses correct clip-to-streamer order (Gate 3)
5. Confirm Drive upload + publish (Gate 4)

**Notes:**
- CDN URLs expire ~1hr — set a timer after script gen approval
- Script gen ~120s (Gemini analyzes each clip)
- HeyGen render ~10-14min (55-72 segments for 8-12 streamers)
- Assembly ~5min
- Total expected: ~21min end-to-end
- Maya/Emily clips expire fastest — early download cache handles this automatically

---

## Story 3: NBA Production Render

**Title:** `[RENDER] NBA — first production episode end-to-end`
**Type:** Story
**Epic:** Phase 1 Production Render — All 3 Content Types Locked
**Assignee:** Sub-Agent A (`sub_agent_a`)
**Labels:** `render`, `nba`, `gate_sequence`
**Story Points:** 3
**Priority:** High

**Description:**

Run first real NBA production render. Clips are Game Highlights reels from ESPN (typically 40-115 seconds each). Bobby G narrates live OVER the clip — this is not setup/reaction style, he talks while the clip plays.

Pre-requisites:
- Synth test `node test/synth_assembly_test.js nba` exits 0
- `GATE_TEST_MODE` is not `true` in `.env`
- Disk space ≥10 GB free

**Acceptance Criteria:**

- [ ] Gate 0 PASS: ≥3 games with Game Highlights clips from ESPN (not press conferences)
- [ ] Gate 1 PASS: Script score ≥90, live-narration style confirmed (Bobby G narrates over clip, not before/after)
- [ ] HeyGen renders all segments (no stuck renders)
- [ ] Gate 2 PASS: Score ≥85
- [ ] Gate 3 PASS: Score ≥70, ESPN highlight clips detected in video
- [ ] Gate 4 PASS: Video published to YouTube + TikTok
- [ ] Rob visual review: "ship it"
- [ ] `run_metrics_*.json` saved with all stage timings

**Subtasks:**

1. Run SELECT GAMES flow to scrape ESPN Game Highlights reels (Gate 0)
2. Verify clips are game highlights, not press conferences
3. Run script gen, confirm Gate 1 auto-pass and live-narration style
4. Monitor HeyGen render
5. Review assembly output — confirm ESPN clips play correctly with Bobby G narration (Gate 3)
6. Confirm Drive upload + publish (Gate 4)

**Notes:**
- Script gen ~90s
- HeyGen render ~6-8min (30-40 segments for 3-5 games)
- Assembly ~4min
- Total expected: ~14min end-to-end
- ESPN pre-roll ads trimmed by `CONFIG.NBA.AD_TRIM_SECONDS` (15 seconds)

---

## Story 4: Synth Test Suite — Permanent CI Asset

**Title:** `[QA] Synth test suite locked as permanent pre-render gate`
**Type:** Story
**Epic:** Phase 1 Production Render — All 3 Content Types Locked
**Assignee:** Claude Code
**Labels:** `qa`, `testing`, `synth`
**Story Points:** 1
**Priority:** High

**Description:**

`test/synth_assembly_test.js` is the permanent pre-render gate. Run before every production render to confirm chrome/set design is correct without burning HeyGen credits. All 4 show types (news/twitch/nba/short) must PASS before any real render proceeds.

This story locks the synth test suite as a mandatory step in the pre-render checklist (see `docs/ops/RENDER_RUNBOOK.md` section 1).

**Acceptance Criteria:**

- [ ] `node test/synth_assembly_test.js` exits 0 for all 4 content types
- [ ] News: 3 sidebar cards visible, "WORLD NEWS" label, logo bottom-right mug position
- [ ] Twitch: sidebar visible (not faded), purple accent `#6441A5`, logo bottom-right mug
- [ ] NBA: sidebar visible (not faded), blue accent `#17408B`, logo bottom-right mug
- [ ] Short: split-screen layout (avatar top, clip bottom), caption text visible, logo bottom-right avatar zone
- [ ] Synth test is referenced in `docs/ops/RENDER_RUNBOOK.md` pre-render checklist
- [ ] `MORNING_BRIEFING.md` updated after each synth test run

**Subtasks:**

1. Verify `node test/synth_assembly_test.js news` exits 0 — Rob visual check on output PNG
2. Verify `node test/synth_assembly_test.js twitch` exits 0 — Rob visual check
3. Verify `node test/synth_assembly_test.js nba` exits 0 — Rob visual check
4. Verify `node test/synth_assembly_test.js short` exits 0 — Rob visual check
5. Add synth test to pre-render checklist in `RENDER_RUNBOOK.md` (already done in v1.0)

**Notes:**
- Synth test uses FFmpeg `lavfi` test sources (no real video files needed)
- Test runs in ~30 seconds per content type
- Output PNGs saved to `output/synth_test_*.png` for Rob to visually verify
- No HeyGen API calls made — zero cost to run

---

## Paste Instructions for Jira

1. In CPD project, click **Create** → Epic
2. Paste Epic title and description from above
3. Set labels: `phase_1`, `render`, `qa`
4. Create 4 Stories under the Epic (Stories 1-4 above)
5. For each Story, create Subtasks from the subtask lists
6. Assign Sub-Agent A to Stories 1-3, Claude Code to Story 4
7. Set priority: High for all

**Suggested Sprint:** "Phase 1 Production Lock" sprint

---

*Tickets created 2026-04-17. Update acceptance criteria as renders complete.*
