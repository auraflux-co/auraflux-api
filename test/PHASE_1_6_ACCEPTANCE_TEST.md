# CWN Phase 1-6 Acceptance Test Plan

**Version:** 1.0  
**Created:** 2026-04-09  
**Owner:** Rob (creative review) + Cline (pipeline execution)  
**Purpose:** Validate the full Phase 1-6 pipeline end-to-end before production launch  
**Upload setting:** ALL jobs upload as **PRIVATE** — Rob reviews before any go public

---

## Phases on Record

| Phase   | What It Covers                                                       | Status      |
| ------- | -------------------------------------------------------------------- | ----------- |
| Phase 1 | Thumbnails — tagline, overlay, blur on all 3 content types           | ✅ Complete |
| Phase 2 | Short-form infrastructure — 9:16 split-screen, CapCut routes         | ✅ Complete |
| Phase 3 | Caption generation + news story prioritization                       | ✅ Complete |
| Phase 4 | Operations — Gate 3 human approval, Gate 6 auto-publish wiring       | ✅ Complete |
| Phase 5 | Creative layer — NBA/News intro cards, newscast UI, layout decisions | ✅ Complete |
| Phase 6 | Publish integration — Upload-Post API → YouTube, TikTok, Instagram   | 🟡 Active   |

**This test validates all 6 phases together in a single end-to-end run.**

---

## Test Jobs (6 Total)

### Long-Form Jobs (3)

| Job  | Content Type | Format         | Platforms                  | Privacy | Upload Timing |
| ---- | ------------ | -------------- | -------------------------- | ------- | ------------- |
| LF-1 | Twitch       | Long-form 16:9 | YouTube, TikTok, Instagram | Private | Immediate     |
| LF-2 | NBA          | Long-form 16:9 | YouTube, TikTok, Instagram | Private | Immediate     |
| LF-3 | News         | Long-form 16:9 | YouTube, TikTok, Instagram | Private | Immediate     |

### Short-Form Jobs (3)

| Job  | Content Type | Format          | Platforms                         | Privacy | Upload Timing |
| ---- | ------------ | --------------- | --------------------------------- | ------- | ------------- |
| SF-1 | Twitch       | Short-form 9:16 | YouTube Shorts, TikTok, Instagram | Private | Immediate     |
| SF-2 | NBA          | Short-form 9:16 | YouTube Shorts, TikTok, Instagram | Private | Immediate     |
| SF-3 | News         | Short-form 9:16 | YouTube Shorts, TikTok, Instagram | Private | Immediate     |

---

## Pipeline Stages Per Job

Each job must pass all 6 stages:

```
Stage 1: Script Gen (Gate 1 ≥90)
Stage 2: HeyGen Render (Gate 2 ≥85)
Stage 3: Assembly (Gate 3 ≥70)
Stage 4: Thumbnail Generation
Stage 5: Upload-Post → All 3 Platforms (Private)
Stage 6: Rob Creative Review (Pass/Fail)
```

---

## Stage-by-Stage Pass Criteria

### Stage 1 — Script Generation (Gate 1)

- [ ] Gate 1 score ≥ 90 (auto-proceed) or ≥ 70 (manual review)
- [ ] Correct scene count: Twitch = `1 + (streamers × 7) + 1`, NBA/News = `1 + (items × 4) + 1`
- [ ] No placeholder brackets `[YOUR TEXT HERE]` in script
- [ ] Correct display names used (not Twitch usernames)
- [ ] Bobby G voice rules followed (flat delivery, no "incredible/amazing/crazy")

### Stage 2 — HeyGen Render (Gate 2)

- [ ] Gate 2 score ≥ 85
- [ ] All segments rendered (no missing segments)
- [ ] Lip sync acceptable on sampled segments (first/middle/last)
- [ ] No audio dropouts

### Stage 3 — Assembly (Gate 3)

- [ ] Gate 3 score ≥ 70
- [ ] No freeze frames
- [ ] Transitions smooth
- [ ] CWN logo visible (120px long-form, 80px short-form)
- [ ] Ticker baked in (long-form only)
- [ ] **Long-form:** Intro cards present at each segment (NBA/News TV card, Twitch profile circle)
- [ ] **Short-form:** Split-screen layout correct (top 50% source clip, bottom 50% Bobby G)

### Stage 4 — Thumbnail

- [ ] Tagline "BECAUSE THE LIGHT WAS ON" visible
- [ ] Dark overlay applied (40-60%)
- [ ] 8px blur on background
- [ ] Text readable at 1280×720
- [ ] Episode counter incremented correctly

### Stage 5 — Upload-Post (All 3 Platforms, Private)

- [ ] YouTube: video appears in YouTube Studio as Private
- [ ] TikTok: video appears in TikTok profile as Private
- [ ] Instagram: video appears in Instagram as Private
- [ ] `trackingId` returned and stored in `data/upload_status.json`
- [ ] `GET /upload-status/:trackingId` returns `completed` for all platforms

### Stage 6 — Rob Creative Review (Human Gate)

Rob reviews each uploaded video on each platform and marks Pass/Fail:

| Check             | What to Look For                                                                |
| ----------------- | ------------------------------------------------------------------------------- |
| Bobby G delivery  | Flat, dry, no over-enthusiasm                                                   |
| Script accuracy   | Names correct, facts match clips                                                |
| Visual quality    | No artifacts, clean transitions                                                 |
| Thumbnail         | Readable, on-brand, compelling                                                  |
| Intro card        | Correct content, positioned left of Bobby G                                     |
| Short-form layout | Split-screen balanced, both halves clear                                        |
| Logo              | Visible, correct size, correct position                                         |
| Outro             | "I'm Bobby G. See you tomorrow." (long) or "Subscribe. Appreciate you." (short) |

---

## Rollback & Fix Process

### When Rob Marks a Job as FAIL

**Step 1: Rob identifies the failure**

- Note which job (LF-1, SF-2, etc.)
- Note which stage failed (Script / HeyGen / Assembly / Thumbnail / Upload / Creative)
- Note the specific issue (e.g., "Bobby G said 'incredible' twice", "intro card missing on game 3", "split-screen top half cut off")

**Step 2: Cline triages**

- Script failures → fix prompt in `server.js` (Gemini system/user prompt)
- HeyGen failures → check segment, re-render that segment only
- Assembly failures → fix FFmpeg filter or overlay positioning
- Thumbnail failures → fix Canvas code or HTML template
- Upload failures → check `UPLOADPOST_API_KEY`, retry via `/publish`
- Creative failures → escalate to Claude Code for design decision

**Step 3: Fix scope**

- **Single-job fix:** Re-run just the failing stage for that job (e.g., re-assemble only)
- **Systemic fix:** If same issue appears in 2+ jobs → fix the root cause in code before re-running all affected jobs
- **Rollback:** If a code fix breaks something else → `git revert <commit>` and re-run

**Step 4: Re-run**

- Re-run only the affected stage (not the full pipeline) when possible
- Re-upload as Private again
- Rob re-reviews

**Step 5: Document**

- Log the failure + fix in `MORNING_BRIEFING.md` or a new `TEST_RESULTS_PHASE6.md`
- Update `STATUS.md` with what was fixed

### Rollback Commands

```bash
# Revert last commit (if a code fix broke something)
git revert HEAD

# Revert specific commit
git revert <commit-hash>

# Check what changed in a commit before reverting
git show <commit-hash> --stat

# Hard reset to last known good state (DESTRUCTIVE — use only if revert fails)
git reset --hard <commit-hash>
```

### Re-run a Single Stage

```bash
# Re-run assembly only (skip script gen + HeyGen)
curl -X POST http://localhost:3000/assemble \
  -H "Content-Type: application/json" \
  -d '{"asmId":"<existing_id>","segments":[...],"contentType":"twitch","formType":"long"}'

# Re-run publish only (skip everything else)
curl -X POST http://localhost:3000/publish \
  -H "Content-Type: application/json" \
  -d '{"driveUrl":"<drive_url>","platforms":["youtube","tiktok","instagram"],"title":"...","privacy":"private"}'

# Check upload status
curl http://localhost:3000/upload-status/<trackingId>
```

---

## Test Execution Order

Run in this order to catch systemic issues early:

1. **LF-1 (Twitch Long)** — most complex, most streamers, most scenes
2. **LF-2 (NBA Long)** — validates NBA intro card + ESPN data
3. **LF-3 (News Long)** — validates news OG image scraper
4. **SF-1 (Twitch Short)** — validates split-screen layout
5. **SF-2 (NBA Short)** — validates short-form NBA
6. **SF-3 (News Short)** — validates short-form news

**Stop and fix before continuing** if LF-1 fails at any stage — systemic issues will affect all jobs.

---

## Test Results Tracker

| Job               | Stage 1 | Stage 2 | Stage 3 | Stage 4 | Stage 5 | Stage 6 (Rob) | Notes |
| ----------------- | ------- | ------- | ------- | ------- | ------- | ------------- | ----- |
| LF-1 Twitch Long  | ⏳      | ⏳      | ⏳      | ⏳      | ⏳      | ⏳            |       |
| LF-2 NBA Long     | ⏳      | ⏳      | ⏳      | ⏳      | ⏳      | ⏳            |       |
| LF-3 News Long    | ⏳      | ⏳      | ⏳      | ⏳      | ⏳      | ⏳            |       |
| SF-1 Twitch Short | ⏳      | ⏳      | ⏳      | ⏳      | ⏳      | ⏳            |       |
| SF-2 NBA Short    | ⏳      | ⏳      | ⏳      | ⏳      | ⏳      | ⏳            |       |
| SF-3 News Short   | ⏳      | ⏳      | ⏳      | ⏳      | ⏳      | ⏳            |       |

**Status key:** ⏳ Pending | ✅ Pass | ❌ Fail | 🔄 Re-running

---

## Definition of Done

Phase 1-6 is considered **production-ready** when:

- All 6 jobs reach Stage 6 (Rob review)
- All 6 jobs receive a Stage 6 PASS from Rob
- All 18 platform uploads (6 jobs × 3 platforms) show as Private in platform dashboards
- No systemic failures remain open
- `data/upload_status.json` has a complete record of all 18 uploads

---

## Relationship to Existing 12-Case Suite

The existing `test_suite_12cases.json` tests **script generation only** (Stage 1 / Gate 1).  
This document tests **all 6 stages** for a representative subset (1 job per content type × 2 form types).

| Suite                          | Scope           | Cases | Gate Coverage          |
| ------------------------------ | --------------- | ----- | ---------------------- |
| `test_suite_12cases.json`      | Script gen only | 12    | Gate 1 only            |
| `PHASE_1_6_ACCEPTANCE_TEST.md` | Full pipeline   | 6     | Gates 1-6 + Rob review |

Run the 12-case suite first to validate script gen, then run this acceptance test for full pipeline validation.
