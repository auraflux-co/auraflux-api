# AIDER_HANDOFF_RENDER_READINESS.md

**Agent:** Aider (overnight docs + planning, no code edits)
**Created:** 2026-04-17
**Status:** READY TO EXECUTE
**Type:** Documentation + Jira ticket creation only — NO CODE CHANGES

---

## Context

The CWN pipeline is completing its final synthetic set-design QA pass (4 test videos: news/twitch/nba/short). Once Rob approves those visually, the next step is the first real production render. Aider's job is to prepare the documentation and Jira tickets so the team knows exactly how a render works, what gates fire in sequence, what success looks like, and what to do if something fails.

This is a **docs + Jira only** task. Do not touch any `.js`, `.html`, `.json`, or config files.

---

## Task 1 — Write `docs/ops/RENDER_RUNBOOK.md`

Create a step-by-step runbook for executing a production render. This is the document Rob (and eventually operators) reads when kicking off a real episode. It must cover:

### Structure required:

**1. Pre-render checklist**
- Server running (`nodemon server.js` on port 3000)
- Static server running (`python3 -m http.server 8765`)
- VectCut API running (`localhost:9001`) — optional, NBA/News only
- `.env` has all required keys (list: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `HEYGEN_API_KEY`, `DRIVE_FOLDER_ID`, `UPLOADPOST_API_KEY`)
- Disk space: `curl http://localhost:3000/disk-usage` → need ≥10GB free
- Run synth test first: `node test/synth_assembly_test.js [content_type]` → confirm PASS before spending HeyGen credits

**2. Gate sequence — what fires and when**

| Gate | Trigger | What it checks | Pass threshold | On fail |
|------|---------|----------------|----------------|---------|
| Gate 0 | `/generate-full-script` called | Scraper finds clips (AJ/ESPN/Twitch CDN) | ≥1 clip per story/game/streamer | Hard fail — fix scraper or try different topic |
| Gate 1 | Script generated | Claude QA: placeholders, name errors, scene count, structure | ≥90 auto-proceed, 70-89 manual review, <70 hard fail | Rob reviews script, uses Force Advance if acceptable |
| Gate 2 | All HeyGen segments completed | Gemini samples 3 segments: lip sync, audio, rendering quality | ≥85 auto-proceed, 65-84 manual review, <65 hard fail | Check HeyGen dashboard for failed renders; retry segments |
| Gate 3 | Assembly complete | Gemini watches full video: pacing, freeze, transitions, clips present | ≥70 auto-proceed, 60-69 hold for Rob, <60 hard fail | Use Rollback to re-assemble; max 3 auto-retries |
| Gate 4 | Drive upload complete | Upload-Post job_id returned | job_id present = pass | Check Upload-Post dashboard; retry publish |

**3. Per-content-type render notes**

- **News**: AJ clips must be portrait (9:16). Expect 4-6 stories. Script gen takes ~90s (Gemini video analysis). HeyGen render ~8-10min (35-45 segments). Assembly ~4min.
- **Twitch**: Clips from CDN — expire in ~1hr. Start render within 1hr of script approval. 8-12 streamers typical. HeyGen render ~10-14min (55-72 segments).
- **NBA**: ESPN Game Highlights reel only. 3-5 games typical. Bobby G narrates WHILE clip plays (live narration style, not setup/reaction). HeyGen ~6-8min.
- **Shorts (any type)**: Single clip + INTRO/OUTRO. 9:16 split-screen. Caption text burned. Fastest render: ~3min HeyGen, ~1min assembly.

**4. Recovery procedures**

- **Server crashed mid-render**: Page reload → `↩ RESTORE JOBS` → segments in `rendering` state → `🔄 REFRESH IDs` → continue
- **HeyGen segment stuck**: `🔄 REFRESH IDs` → if still stuck after 5min, use `⏭ FORCE ADVANCE` on Gate 2
- **Assembly failed Gate 3**: Check `output/qa_failures/` for report. If pacing/freeze issue: `↩ ROLLBACK` → fix → re-assemble. If score 60-69: Rob approves manually.
- **Drive upload failed**: `⏭ FORCE ADVANCE` on Gate 4 → re-trigger publish manually from dashboard

**5. Expected timings (end-to-end)**

| Content Type | Script Gen | HeyGen | Assembly | Total |
|---|---|---|---|---|
| News (5 stories) | ~90s | ~10min | ~4min | ~16min |
| Twitch (10 streamers) | ~120s | ~14min | ~5min | ~21min |
| NBA (4 games) | ~90s | ~8min | ~4min | ~14min |
| Short (any) | ~45s | ~3min | ~1min | ~5min |

**6. Post-render checklist**
- Gate 3 score logged in `output/run_metrics_{jobId}.json`
- Video uploaded to Google Drive (check `DRIVE_FOLDER_ID` folder)
- Thumbnail generated (check `output/` for `_thumb.jpg`)
- Published to YouTube/TikTok/Instagram via Upload-Post
- Episode counter incremented in `data/episode_counters.json`

---

## Task 2 — Create Jira Epic + Stories in project CPD

Create the following Jira structure. Use the Jira MCP or Aider's Jira client (whichever is available). If neither is available, write the tickets as markdown in `docs/ops/RENDER_JIRA_TICKETS.md` using this exact structure so a human can paste them in.

### Epic: "Phase 1 Production Render — All 3 Content Types Locked"

**Epic description:** First real production renders for News, Twitch, and NBA after synth test QA passes. Each content type runs through the full gate sequence (0→4) and produces a publishable episode. Completion of this epic = Phase 1 locked per AUTONOMOUS_PRODUCTION_ROADMAP.md.

**Labels:** `phase_1`, `render`, `qa`
**Priority:** High

---

### Story 1: News Production Render

**Title:** `[RENDER] News — first production episode end-to-end`
**Assignee:** Sub-Agent A (`sub_agent_a`)
**Labels:** `render`, `news`, `gate_sequence`
**Story points:** 3

**Description:**
Run first real News production render through all gates.

**Acceptance criteria:**
- [ ] Gate 0 PASS: AJ scraper returns ≥4 portrait clips
- [ ] Gate 1 PASS: Script score ≥90, no placeholders, correct scene count
- [ ] HeyGen renders all segments (no stuck renders)
- [ ] Gate 2 PASS: Score ≥85 on sampled segments
- [ ] Gate 3 PASS: Score ≥70 on assembled video
- [ ] Gate 4 PASS: Video published to YouTube + TikTok
- [ ] Rob visual review: "ship it"
- [ ] `run_metrics_*.json` saved with all stage timings

**Subtasks:**
- Verify AJ scraper returns portrait clips (Gate 0)
- Run script gen, confirm Gate 1 auto-pass
- Monitor HeyGen segments (Gate 2)
- Review assembly output (Gate 3)
- Confirm Drive upload + publish (Gate 4)

---

### Story 2: Twitch Production Render

**Title:** `[RENDER] Twitch — first production episode end-to-end`
**Assignee:** Sub-Agent A (`sub_agent_a`)
**Labels:** `render`, `twitch`, `gate_sequence`
**Story points:** 3

**Description:**
Run first real Twitch production render. Note: CDN URLs expire ~1hr — must complete assembly within 1hr of script approval.

**Acceptance criteria:**
- [ ] Gate 0 PASS: ≥8 streamers with valid CDN clip URLs
- [ ] Gate 1 PASS: Script score ≥90, all streamer display names correct
- [ ] HeyGen renders all segments
- [ ] Gate 2 PASS: Score ≥85
- [ ] Gate 3 PASS: Score ≥70
- [ ] Gate 4 PASS: Published
- [ ] Rob visual review: "ship it"

---

### Story 3: NBA Production Render

**Title:** `[RENDER] NBA — first production episode end-to-end`
**Assignee:** Sub-Agent A (`sub_agent_a`)
**Labels:** `render`, `nba`, `gate_sequence`
**Story points:** 3

**Description:**
Run first real NBA production render. Clips are Game Highlights reels from ESPN — Bobby G narrates live over the clip (not setup/reaction style).

**Acceptance criteria:**
- [ ] Gate 0 PASS: ≥3 games with Game Highlights clips from ESPN
- [ ] Gate 1 PASS: Script score ≥90, live-narration style confirmed
- [ ] HeyGen renders all segments
- [ ] Gate 2 PASS: Score ≥85
- [ ] Gate 3 PASS: Score ≥70 — clips detected in video
- [ ] Gate 4 PASS: Published
- [ ] Rob visual review: "ship it"

---

### Story 4: Synth Test Suite — Permanent CI Asset

**Title:** `[QA] Synth test suite locked as permanent pre-render gate`
**Assignee:** Claude Code
**Labels:** `qa`, `testing`, `synth`
**Story points:** 1

**Description:**
`test/synth_assembly_test.js` is the permanent pre-render gate. Run before every production render to confirm chrome/set design is correct without burning HeyGen credits. All 4 show types (news/twitch/nba/short) must PASS before any render proceeds.

**Acceptance criteria:**
- [ ] `node test/synth_assembly_test.js` exits 0 for all 4 types
- [ ] News: 3 sidebar cards visible, logo bottom-right mug
- [ ] Twitch: sidebar visible (not faded), purple accent, logo bottom-right mug
- [ ] NBA: sidebar visible (not faded), blue accent, logo bottom-right mug
- [ ] Short: split-screen layout, caption text visible, logo bottom-right avatar zone

---

## Task 3 — Update `docs/ops/OVERNIGHT_TASKS.md`

Add a new section at the top:

```markdown
## 🎬 RENDER READINESS — Next Session Priority

**Status as of 2026-04-17:** Synth QA in progress (awaiting Rob visual approval on 4 outputs).

**Once synth QA passes → render sequence:**
1. `node test/synth_assembly_test.js` → all 4 PASS
2. News render first (Gate 0→4)
3. Twitch render second
4. NBA render third
5. Phase 1 locked → proceed to Phase 2 client layer

**Runbook:** `docs/ops/RENDER_RUNBOOK.md`
**Jira Epic:** CPD — "Phase 1 Production Render"
```

---

## Deliverables checklist

- [ ] `docs/ops/RENDER_RUNBOOK.md` created
- [ ] `docs/ops/RENDER_JIRA_TICKETS.md` created (if Jira MCP unavailable)
- [ ] `docs/ops/OVERNIGHT_TASKS.md` updated with render readiness section
- [ ] `STATUS.md` Last Agent Action table updated
- [ ] Commit on branch `aider/render-readiness-docs`

**Do not commit to main. Do not touch any code files.**
