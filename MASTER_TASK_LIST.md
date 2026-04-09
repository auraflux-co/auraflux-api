# CWN Master Task List

**Last Updated**: 2026-04-09
**Status**: Active — Phase 2 + Phase 4 COMPLETE
**Model Note**: Aider updated to Claude Sonnet ✅ (upgraded for better code quality)

---

## 🗂️ Agent Assignments

| Agent | Role | Best For |
|-------|------|----------|
| **Claude Code** | Creative Director + Architect | HTML template design, brand decisions, spec writing |
| **Cline** | Implementation Lead | server.js edits, API integration, pipeline wiring |
| **Aider** | Surgical Coder | Text generation logic, prompt engineering, keyword detection |

---

## ✅ Phase 1: Long-Form Thumbnail Updates
**Owner**: Claude Code  
**Estimate**: 2-3 hours  
**Status**: 🟡 READY TO START

### Files to Update
- `nba_thumbnail_generator.html` — NBA long-form thumbnail template
- `cwn_news_tool.html` — News long-form thumbnail template  
- `server.js` — Twitch longform thumbnail generation (currently uses Canvas, needs template refactor)

### Tasks

#### 1.1 News Thumbnail — Text + Visual Updates
- [ ] Change tagline: `"CLIPZWORLD NEWS"` → `"BECAUSE THE LIGHT WAS ON"`
- [ ] Lighten headline text (currently too dark) — add 40-60% black overlay behind text for contrast
- [ ] Apply 5-10px Gaussian blur to background images (CSS: `filter: blur(8px)`)
- [ ] Test render: open in browser, screenshot, verify readability

#### 1.2 NBA Thumbnail — Text + Visual Updates
- [ ] Change tagline: `"CLIPZWORLD NEWS"` → `"BECAUSE THE LIGHT WAS ON"`
- [ ] Apply same 40-60% black overlay + Gaussian blur treatment
- [ ] Verify team names, scores, and logos still render correctly after changes
- [ ] Test render: open in browser, screenshot

#### 1.3 Twitch Longform — Refactor to Use Template
- [ ] Current: Canvas-based rendering in `server.js` (hardcoded)
- [ ] Target: Use `assets/twitchsoup_thumbnail.jpeg` as base template (already exists)
- [ ] Apply same tagline + overlay + blur treatment to match News/NBA style
- [ ] Ensure episode counter and date still auto-populate
- [ ] Test: `curl -X POST http://localhost:3000/generate-twitch-longform-thumbnail`

#### 1.4 Validation
- [ ] All 3 thumbnail types render without errors
- [ ] Text is readable at 1280×720 (YouTube thumbnail size)
- [ ] "BECAUSE THE LIGHT WAS ON" appears on all 3 types
- [ ] Background blur applied consistently

---

## ✅ Phase 2: Short-Form Infrastructure
**Owner**: Cline  
**Status**: ✅ COMPLETE — commit `88e20eb`

#### 2.1 CapCut/VectCut Split-Screen Assembly
- [x] VISUAL_DESIGN_SPEC.md created (1080×1920, split zones, logo pos, safety zones)
- [x] CapCut routes exist: `/capcut/init`, `/capcut/add-segment`, `/capcut/ticker`, `/capcut/logo`, `/capcut/finalize`
- [x] Dashboard: `sendToCapCut(jobId)` — 5-step flow wired in cwn_production.html
- [x] Dashboard: `✂️ CAPCUT DRAFT` button on all portrait/short jobs

#### 2.2 Portrait Thumbnail Frame Extraction
- [x] `POST /thumbnail-short` — ffprobe I-frame detection near 40% mark
- [x] FFmpeg drawtext: "BECAUSE THE LIGHT WAS ON" tagline + EP badge
- [x] Increments `episode_counters.json` per content type
- [x] Dashboard: `generateShortThumbnail(jobId)` + `📸 SHORT THUMB` button

#### 2.3 TikTok/Reels Safety Zone Validation
- [x] `POST /safety-zone-check` — AABB+circle overlap for TikTok (880,1520,200×400) and Reels (0,1770,1080×150)
- [x] `POST /capcut/thumbnail` — frame extraction + CapCut cover image
- [x] `GET /short-form-status/:jobId` — status polling endpoint

---

## ✅ Phase 3: Caption & Prioritization Logic
**Owner**: Aider  
**Estimate**: 1-2 hours  
**Status**: 🟡 READY TO START (no creative decision needed for logic)

### Tasks

#### 3.1 Gemini Short-Form Caption Generator
- [ ] Add new function `generateShortFormCaption(script, contentType)` in server.js
- [ ] Gemini prompt:
  - Input: assembled short-form script text + content type
  - Output: caption ≤70 chars, platform-optimized
  - Rules: keyword highlighting (bold key terms), hook in first 5 words
  - Analyze video + audio transcript if available
- [ ] Return: `{ caption, hashtags[], altText }`
- [ ] Wire into `/generate-publish-copy` response for short-form

#### 3.2 News Story Prioritization Logic
- [ ] Add `prioritizeNewsStories(stories[])` function
- [ ] Priority keywords (auto-bump to top): Trump, Iran, war, breaking, crisis, election
- [ ] Logic:
  1. Detect priority keywords in headline/summary
  2. Bump matching stories to top of order
  3. Weighted randomization for remaining stories (recency + engagement score)
- [ ] Return: reordered `stories[]` array
- [ ] Wire into `/generate-full-script` for news content type (before Gemini prompt)

---

## ✅ Phase 4: Operations Fixes
**Owner**: Cline  
**Status**: ✅ COMPLETE — commit `9fa9340`

#### 4.1 NBA Intro Prompt Fix
- [x] NBA system prompt strengthened — "Witness the NBA" forbidden, "Other Side of the Pillow" enforced

#### 4.2 Human Approval Checkpoint (Dashboard)
- [x] Gate 3 PASS shown after Gate 5 score ≥85
- [x] "✅ APPROVE & UPLOAD →" button triggers `/publish`
- [x] "❌ REJECT — BACK TO EDIT" button keeps job in manual review

#### 4.3 Gate 6 Auto-Publish
- [x] `approveAndUpload(jobId)` calls `/publish` with all metadata
- [x] Upload job_id displayed in dashboard
- [x] `pollPublishStatus(jobId)` polls `/publish/status` every 15s

#### 4.4 Upload-Post Status Polling
- [x] Live progress shown per platform (YouTube/TikTok/Instagram)
- [x] On success: platform links shown, job marked posted
- [x] On failure: error displayed in gate3-upload-status div

---

## 🔴 Phase 5: Creative Layer (BLOCKED — Needs VISUAL_DESIGN_SPEC.md)
**Owner**: Claude Code (spec) → Cline/Aider (build)  
**Status**: ❌ DO NOT START — awaiting Rob + Claude creative alignment session

See `CREATIVE_VS_OPERATIONS.md` for the 7 creative decisions needed.

- [ ] Short-form split-screen (exact layout, safe zones, intro/outro)
- [ ] NBA intro card design (content, timing, border)
- [ ] News intro card design (fallback, headline, attribution)
- [ ] Gold border brand rules (scope, shadow spec, no-go zones)
- [ ] Gate 3 visual retention rules (7-second rule vs CWN style)
- [ ] Thumbnail strategy (3-option battle vs auto)
- [ ] Bobby G voice standard (style guide accuracy)

---

## 📊 Progress Tracker

| Phase | Owner | Status | Commit |
|-------|-------|--------|--------|
| Phase 1: Thumbnail Updates | Claude Code | 🟡 Ready to start | — |
| Phase 2: Short-Form Infrastructure | Cline | ✅ COMPLETE | `88e20eb` |
| Phase 3: Caption & Prioritization | Aider | 🟡 Ready to start | — |
| Phase 4: Operations Fixes | Cline | ✅ COMPLETE | `9fa9340` |
| Phase 5: Creative Layer | Claude→Cline | 🔴 Blocked (creative decisions) | — |

---

## 🔑 Key Files Reference

| File | Purpose | Phase |
|------|---------|-------|
| `nba_thumbnail_generator.html` | NBA thumbnail template | Phase 1 |
| `cwn_news_tool.html` | News thumbnail template | Phase 1 |
| `assets/twitchsoup_thumbnail.jpeg` | Twitch thumbnail base | Phase 1 |
| `server.js:6354-6432` | Twitch thumbnail Canvas code | Phase 1 |
| `server.js:/assemble` | Assembly route | Phase 2 |
| `assets/bobbyg_short_form.png` | Bobby G short-form avatar | Phase 2 |
| `server.js:geminiScriptGeneration` | Script gen + caption | Phase 3 |
| `cwn_production.html` | Dashboard UI | Phase 4 |
| `CREATIVE_VS_OPERATIONS.md` | Creative decisions needed | Phase 5 |

---

## 📝 Notes

- **Aider model**: Updated to Claude Sonnet ✅ (was Gemini Flash 2.5 via OpenRouter)
- **Phase 1** — Claude Code: open HTML files, make text/CSS changes, test in browser
- **Phase 3** — Aider: write caption generator + prioritization logic in server.js (no creative decisions needed)
- **Phase 2** — ✅ DONE: VISUAL_DESIGN_SPEC.md exists, all endpoints + dashboard wired
- **Phase 4** — ✅ DONE: Gate 3/6 approval flow, polling, NBA prompt fix all shipped
- **Phase 5** — still blocked on 7 creative decisions (see CREATIVE_VS_OPERATIONS.md)
