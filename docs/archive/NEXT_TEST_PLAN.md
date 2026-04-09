# CWN Next Test Plan — Phase 2: Full Pipeline Validation

**Created**: 2026-04-09  
**Author**: Cline (based on 12-test suite analysis)  
**Status**: Ready for Rob review  
**Prerequisite**: 12-test script generation suite complete ✅

---

## 🔍 What the 12-Test Suite Actually Validated (Phase 1)

The completed 12-test suite (`test_suite_12cases.json`) only tested **script generation** — NOT the full pipeline.

| Gate | What It Checked | Status |
|------|----------------|--------|
| Gate 1 | Script structure (scene count, clip markers, outro) | ✅ Automated |
| Gate 2 | HeyGen segment completion tracking | ✅ Automated (waits for segments) |
| Gate 3 | Assembly QA | ⏭️ **SKIPPED** — tests stop before assembly |
| Gate 4 | Thumbnail generation (file size check only) | ✅ Automated |
| Gate 5 | Publish metadata (title generation) | ✅ Automated |
| Gate 6 | Pass/fail summary | ✅ Automated |

### ❌ What Was NOT Tested (The Red X Items)

1. **No actual video assembly** — FFmpeg concat never ran in the 12-test suite
2. **No visual/creative review** — Bobby G avatar quality, lip sync, pacing not checked
3. **No human approval workflow** — no checkpoint for Rob to review before upload
4. **No platform upload** — tests stopped at Gate 6 summary, never hit Upload-Post API
5. **No end-to-end timing** — total pipeline time (script → HeyGen → assembly → upload) not measured
6. **No short-form split-screen** — 9:16 layout not tested at all
7. **No NBA/News intro cards** — VectCut overlay cards not tested

---

## 📍 Where Creative Output Lives

After a successful `/generate-full-script` call, output is saved to:

```
output/
├── run_metrics_script_{type}_{timestamp}.json   ← timing + Gate 1 score
├── thumbnail_news_ep{N}_{timestamp}.png          ← auto-generated thumbnail
└── qa_failures/
    ├── gate1_script_{outcome}_{timestamp}.txt    ← Claude's script review
    └── gate2_segments_{outcome}_{timestamp}.txt  ← Gemini's segment review
```

After `/assemble`:
```
output/
├── {contentType}_{formType}_{timestamp}.mp4      ← final assembled video
├── run_metrics_{asmId}.json                      ← full pipeline metrics
└── qa_failures/
    └── gate3_assembly_{outcome}_{timestamp}.txt  ← Gemini's assembly review
```

**Human review happens at**: Dashboard → `http://localhost:8765/cwn_production.html`  
Rob watches the assembled MP4, reviews Gate 3 report, then manually approves to trigger upload.

---

## 🎯 Phase 2: Full Pipeline Tests (The Real Tests)

These tests run the **complete pipeline**: Script → HeyGen → Assembly → Gate 3 → Upload.

### Test Group A: Twitch Long-Form (Full Pipeline)

#### Test A1: Twitch Long-Form — Real Clips, Full Assembly
**Goal**: Prove end-to-end works with real Twitch clips  
**Input**: 5 streamers × 3 real clips each (15 total)  
**Expected**: Gate 1 ≥90, Gate 2 ≥85, Gate 3 ≥70, MP4 in output/  

**Steps**:
1. [ ] Run `/generate-full-script` with real clip URLs
2. [ ] Gate 1 passes (≥90) → auto-sends to HeyGen
3. [ ] Wait for all HeyGen segments to complete (~30-60 min)
4. [ ] Run `/assemble` with segment URLs + clip URLs
5. [ ] Gate 2 QA runs (Gemini samples 3 segments)
6. [ ] Gate 3 QA runs (Gemini watches assembled video)
7. [ ] **Rob reviews**: Watch MP4 in output/, check Gate 3 report
8. [ ] If approved: Run `/publish` → YouTube Private
9. [ ] Confirm upload job_id returned

**Pass Criteria**:
- Gate 1: ≥90/100
- Gate 2: ≥85/100  
- Gate 3: ≥70/100
- MP4 exists in output/ (>100MB)
- YouTube upload returns job_id

---

#### Test A2: Twitch Short-Form — 9:16 Split-Screen
**Goal**: Prove short-form split-screen layout works  
**Input**: 3 streamers × 1 clip each  
**Expected**: 9:16 MP4 with Bobby G bottom, clip top  

**Status**: ❌ **BLOCKED** — split-screen assembly not implemented  
**Blocker**: `server.js` short-form assembly uses placeholder, not actual split-screen FFmpeg  
**Owner**: Aider  

---

### Test Group B: NBA Long-Form (Full Pipeline)

#### Test B1: NBA Long-Form — Real Highlights, Full Assembly
**Goal**: Prove NBA pipeline works with real highlight clips  
**Input**: 5 games with real ESPN/highlight URLs  
**Expected**: Gate 1 ≥90, intro cards display correctly  

**Steps**:
1. [ ] Run `/generate-full-script` with real NBA game data
2. [ ] Verify NBA intro line uses "Other Side of the Pillow" (not "Witness the NBA")
3. [ ] Gate 1 passes (≥90) → auto-sends to HeyGen
4. [ ] Wait for HeyGen segments
5. [ ] Run `/assemble`
6. [ ] **Rob reviews**: Check intro cards display at each game section
7. [ ] If approved: Upload to YouTube Private

**Known Issue**: Gemini sometimes uses wrong NBA intro line → -15 deduction → 85 instead of 90  
**Fix needed**: Strengthen NBA intro prompt to enforce "Other Side of the Pillow"  

---

### Test Group C: News Long-Form (Full Pipeline)

#### Test C1: News Long-Form — Real Stories, Full Assembly
**Goal**: Prove news pipeline works end-to-end  
**Input**: 5 real news stories with article URLs  
**Expected**: Open Graph images scraped, used as intro cards  

**Status**: ❌ **BLOCKED** — News intro card scraping not implemented  
**Blocker**: `axios`/`cheerio` scraper for Open Graph images not built  
**Owner**: Aider  

---

## 🔴 Red X Items — What Needs to Be Built

### Priority 1: Blocks Full Pipeline Tests

| Item | Description | Owner | Effort |
|------|-------------|-------|--------|
| NBA intro prompt fix | Enforce "Other Side of the Pillow" intro line | Aider | Small |
| Gate 1 score to ≥90 | With real clips, clip match check passes → score goes from 85→90+ | N/A | Needs real clips |
| Human approval checkpoint | Dashboard button: "Approve → Upload" after Rob reviews MP4 | Aider | Medium |

### Priority 2: Short-Form & Cards

| Item | Description | Owner | Effort |
|------|-------------|-------|--------|
| Short-form split-screen | 9:16 FFmpeg layout (clip top 50%, Bobby G bottom 50%) | Aider | Large |
| NBA intro cards | VectCut overlay at each GAME#_INTRO scene | Aider | Medium |
| News intro card scraper | axios/cheerio Open Graph image scraper | Aider | Medium |

### Priority 3: Upload Automation

| Item | Description | Owner | Effort |
|------|-------------|-------|--------|
| Gate 6 automation | Auto-trigger `/publish` after Gate 3 pass + Rob approval | Aider | Medium |
| Upload-Post status polling | Frontend polls `/publish/status` until confirmed | Aider | Small |
| Private upload verification | Confirm video appears as Private on YouTube/TikTok/IG | Manual | N/A |

---

## ✅ Green Items — Already Working

| Item | Status | Notes |
|------|--------|-------|
| Script generation (Twitch) | ✅ | Gate 1 85/100 with empty clips, ≥90 expected with real clips |
| Script generation (NBA) | ✅ | Gate 1 85/100, -15 for wrong intro line |
| Script generation (News) | ✅ | Gate 1 working |
| Scene header normalization | ✅ | commit 93aa22f — Jay Cinco, Trail Blazers fixed |
| HeyGen segment splitting | ✅ | Each `=== HEADER ===` → separate HeyGen video |
| Gate 2 segment QA | ✅ | Gemini samples first/middle/last |
| Assembly (long-form) | ✅ | Gate 3 has passed multiple times (output/qa_failures/gate3_assembly_pass_*) |
| Gate 3 assembly QA | ✅ | Gemini watches assembled video |
| Google Drive upload | ✅ | Auto-uploads after Gate 3 pass |
| Thumbnail generation | ✅ | Puppeteer renders PNG |
| Publish metadata | ✅ | `/generate-publish-copy` works |
| Upload-Post API | ✅ | `/publish` endpoint implemented |
| Audio normalization | ✅ | -14 LUFS on all segments |

---

## 📋 Recommended Next Steps for Rob

### Immediate (This Week)
1. **Run Test A1** — Twitch long-form with real clips to get Gate 1 ≥90 and full assembly
2. **Fix NBA intro line** — Aider task: strengthen prompt to enforce "Other Side of the Pillow"
3. **Add human approval button** — Dashboard: after Gate 3 pass, show "Approve & Upload" button

### Short-Term (Next 2 Weeks)
4. **Build short-form split-screen** — Aider task: FFmpeg 9:16 layout
5. **Build NBA intro cards** — Aider task: VectCut overlay at GAME#_INTRO scenes
6. **Build News scraper** — Aider task: axios/cheerio Open Graph image fetch

### Medium-Term (Month)
7. **Gate 6 automation** — Auto-publish after Rob approves Gate 3
8. **Upload-Post status polling** — Frontend confirms upload success
9. **Private upload verification** — Manual spot-check on all 3 platforms

---

## 🗂️ Test Result Tracking

Create results in `qa/results/` as each test completes:

```
qa/results/
├── A1_twitch_longform_YYYY-MM-DD.md
├── A2_twitch_shortform_YYYY-MM-DD.md
├── B1_nba_longform_YYYY-MM-DD.md
└── C1_news_longform_YYYY-MM-DD.md
```

Each file uses the scorecard template from `QA_GATES.md`.

---

## 📝 Key Insight for Claude

When discussing next steps, Claude should know:

- **Phase 1 (done)**: Script generation validated — all 12 content types generate correct scene structure
- **Phase 2 (now)**: Full pipeline — real clips → HeyGen → assembly → Rob review → upload
- **The gap**: Assembly works (Gate 3 has passed before), but it's never been triggered from the 12-test suite. The test suite stops at script gen.
- **Rob's role**: Review assembled MP4 before upload. This is intentional — not a bug. Rob is the final creative gate.
- **Score of 85 vs 90**: 85 = no real clips (expected). 90+ = real clips provided (clip match verified). Don't chase 90 with empty test payloads.
