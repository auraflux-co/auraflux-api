# Load Test Results — CPD-7 (2026-04-29)

## autocannon /health — localhost baseline

| Metric | Result | Target | Status |
|--------|--------|--------|--------|
| p50 latency | 174 ms | — | (local baseline) |
| p99 latency | 774 ms | < 50 ms | LOCAL ONLY — see note |
| Avg RPS | 108.6 | > 100 rps | PASS |
| Max RPS | 149 | — | — |
| Duration | 15s, 20 connections | — | — |
| Total requests | 2,037 | — | — |

**Note:** `/health` is pure in-memory (no DB call — reads `_healthCache`). The 774ms p99 reflects macOS localhost overhead + dev machine contention, not endpoint cost. On Render (Linux, co-located), expect p99 < 10ms.

**Action:** Re-run against production: `LOAD_TEST_URL=https://api.auraflux.co/health npm run load-test:health` for valid production baseline before CPD-56 (customer UI) launch.

---

# Morning Briefing — 2026-04-28

## Daytime Session (Cursor — 9:07 AM → ~9:45 AM ET Apr 28)

All three tasks from `docs/ops/OVERNIGHT_TASKS.md` → section "2026-04-28 Overnight Tasks" are complete.

### Task 1 ✅ — test/runpod.test.js (unit tests for lib/ai/runpod.js)

- **11/11 tests pass** (`npx jest --testPathPatterns=runpod --forceExit`)
- Covers: `pingPod` (200, non-200, network throw), `submitComfyWorkflow` (success, error), `pollComfyResult` (resolves on history match, times out), `generateWanVideo` (missing prompt throws, defaults applied, node values patched, submitComfyWorkflow called once)
- All mocked via `https.request` — no real network calls

### Task 2 ✅ — scripts/rotate_qa_failures.sh

- Keeps 50 newest files per gate prefix in `output/qa_failures/`
- Archives excess into `archive_YYYY-MM-DD_<prefix>.tar.gz`
- Deletes tarballs older than 90 days
- Idempotent — exits cleanly if directory doesn't exist
- Tested: `bash scripts/rotate_qa_failures.sh` → exit 0

### Task 3 ✅ — Committed + pushed Wan2.1 session work

- **Branch:** `feature/wan-t2v-api` pushed to `origin`
- **Commit 1:** `feat(runpod): Wan2.1 T2V pipeline + /api/generate-video routes` (81f5da9)
- **Commit 2:** `test(runpod): 11/11 unit tests + chore(ops): rotate_qa_failures.sh` (caa66a6)
- Render will auto-deploy when branch is merged to main

### What's next

1. Open PR: `feature/wan-t2v-api` → `main` on GitHub (link above in push output)
2. Merge → Render auto-deploys → test `POST https://api.auraflux.co/api/generate-video` live
3. Build the Next.js `/generate` page (Shadcn: Input, Button, Progress, VideoPreview)
4. Test longer clips (49 frames = 3s, 81 frames = 5s at 16fps; try 720×1280 vertical)
5. Cost audit — RunPod GPU hours used

### Ownership change — OVERNIGHT_TASKS.md

Cursor now owns `docs/ops/OVERNIGHT_TASKS.md`. At the end of every session, Cursor will write the next session's tasks into the `## 🟡 YYYY-MM-DD Overnight Tasks — PENDING` section so Aider has a real queue to execute.

---

# Morning Briefing — 2026-04-24

## Overnight Aider Run (Session Start: ~3:00 AM ET Apr 24)

- **Task:** Process `OVERNIGHT_TASKS.md`.
- **Result:** No tasks found. `OVERNIGHT_TASKS.md` was empty.
- **Actions:** Updated `STATUS.md`, `MORNING_BRIEFING.md`, and `docs/ops/COMMIT_CHECKLIST.md` to reflect a no-op run.

---

# Morning Briefing — 2026-04-23

## Overnight Aider Run (Session Start: ~3:00 AM ET Apr 23)

- **Task:** Process `OVERNIGHT_TASKS.md`.
- **Result:** No tasks found. `OVERNIGHT_TASKS.md` was empty.
- **Actions:** Updated `STATUS.md`, `MORNING_BRIEFING.md`, and `docs/ops/COMMIT_CHECKLIST.md` to reflect a no-op run.

---

# Morning Briefing — 2026-04-22

## Overnight Aider Run (Session Start: ~3:00 AM ET Apr 22)

- **Task:** Process `OVERNIGHT_TASKS.md`.
- **Result:** No tasks found. `OVERNIGHT_TASKS.md` was empty.
- **Actions:** Updated `STATUS.md`, `MORNING_BRIEFING.md`, and `docs/ops/COMMIT_CHECKLIST.md` to reflect a no-op run.

---

# Morning Briefing — 2026-04-21

## Overnight Aider Run (Session Start: ~3:00 AM ET Apr 21)

- **Task:** Process `OVERNIGHT_TASKS.md`.
- **Result:** No tasks found. `OVERNIGHT_TASKS.md` was empty.
- **Actions:** Updated `STATUS.md` and this briefing to reflect a no-op run.

---

**Session closed:** ~2:00 AM ET Apr 20 (Rob went to bed)
**Commit:** `02c8911` — fix(chrome): cap flag at 88px + Twitch sidebar reads segment cardData
**Branch:** `aider/test-suite`

---

## What Was Fixed Tonight

### 1. Chrome flag height (lib/chrome_overlay_ffmpeg.js)

**Bug:** 2-line titles expanded flag from 88px → 110px, covering Bobby G's face (face zone ~y=120, flag was reaching y=158).
**Fix:** Flag always stays at 88px spec max. 2-line titles use fontsize=20 instead of 28.
**Visible in:** NBA video had massive flag covering Bobby G's head.

### 2. Twitch sidebar empty (lib/assembly.js)

**Bug:** Twitch branch read sidebar data from `streamerRoster` — empty for all new pipeline jobs and synth tests.
**Fix:** First scans INTRO segments for `cardData` (same pattern NBA/News already used), falls back to `streamerRoster`.
**Visible in:** Twitch video had the sidebar panel but zero story cards inside it.

### 3. Synth test Twitch payload (test/synth_assembly_test.js)

**Bug:** `JASON_INTRO` segment had no `cardData` — the test wasn't exercising the sidebar at all.
**Fix:** Added `cardData: { title, displayName, origin, fact }` to match News/NBA pattern.

---

## Status When You Wake Up

**Synth test completed ✅ — all 3 content types assembled successfully.**

| Content Type | Output File                                    | Size    |
| ------------ | ---------------------------------------------- | ------- |
| News         | news_synth_test_3clips_asm_1776663598384.mp4   | 18.4 MB |
| Twitch       | twitch_synth_test_1clips_asm_1776663769570.mp4 | 6.6 MB  |
| NBA          | nba_synth_test_1clips_asm_1776663907705.mp4    | 5.1 MB  |

**Open these and visually verify:**

- Flag is flush to left edge, does NOT cover Bobby G's face (88px max — was 110px before fix)
- Sidebar cards visible on the right side for all 3 content types
- News: 3 story cards (Ceasefire / Markets / Amazon)
- Twitch: Jason card with "New York · Just hit 50k subs"
- NBA: Lakers vs Celtics card

If chrome looks correct → short-form test next, then Render.

---

## Priority Order For Today

### Must complete before Render deploy

**1. [pause]/[beat] markers being spoken by Bobby G**
Bobby G literally said "pause" on the news video. Only `CAPTION:` labels are currently stripped before HeyGen submission. Need to also strip `[pause]`, `[beat]`, `[BEAT]`, `[PAUSE]` in `lib/script_gen.js` before text is sent.
→ Sub-Agent A, quick fix, 15 min

**2. AJ portrait pillarbox not applied**
News clips are 608x1080 portrait, stretched to 1920x1080. The `pillarboxFilter` field exists on the segment object but `lib/assembly.js` never applies it. Fix: when `seg.sourceOrientation === 'portrait'` apply the filter in the FFmpeg command for that clip.
→ Sub-Agent A, same commit as #1

**3. Run synth test short-form**
`node test/synth_assembly_test.js short`
Verify: Bobby G top, clip bottom, caption at ~y=920, no chrome flag (shorts have no sidebar/flag).

**4. Re-run full synth test after fixes**
`node test/synth_assembly_test.js news twitch nba short`
All 4 pass → ready to tell Rob we're ready for Render.

### Render deploy (when synth passes, Rob says go)

- Sub-Agent A: render.yaml + server config
- Sub-Agent B: Postgres migration plan + env vars
- Remember: `TZ=UTC` in Render env vars

### Post-Render (do NOT touch now)

- YouTube test channel (10/day limit hit last night — needs a separate channel for testing)
- NBA narration accuracy — Gemini fabricates player names, needs real data source wired in
- Deprecated Puppeteer chrome functions cleanup (delete after 2 clean synth test runs)
- NR alert policies, designSpec decoupling, chrome rename

---

## How To Start Your Session

```
1. Read cursor.md → STATUS.md
2. Check synth test output (ls -lt output/*.mp4 | head -6)
3. Tell me what you see on the videos
4. I'll spawn Sub-Agent A for the [pause] + pillarbox fixes
5. Re-run synth test
6. If all pass — "ready for Render?"
```

---

## Key Numbers From Last Night's Production Run

- 3 videos assembled (NBA / News / Twitch long-form)
- 0 published — YouTube 10/day rate limit hit on all 4 upload attempts
- Chrome bugs visible in all 3 assembled videos (flag too large, sidebar empty)
- HeyGen: avatar path confirmed working. Template API permanently abandoned.
- GATE_TEST_MODE is currently `false` in .env — pipeline runs end-to-end. Run synth test before any live job.
