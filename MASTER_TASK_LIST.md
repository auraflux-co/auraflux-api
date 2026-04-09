# CWN Master Task List

**Last Updated**: 2026-04-09  
**Status**: Active — Phase 1 ready to start  
**Model Note**: Aider stays on Gemini Flash 2.5 via OpenRouter ✅ (fast, cheap, perfect for text/logic tasks)

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
**Estimate**: 3-4 hours  
**Status**: 🔴 BLOCKED — needs `VISUAL_DESIGN_SPEC.md` from Claude first  
**Blocker**: Split ratio, safe zones, and intro/outro behavior not yet locked (see `CREATIVE_VS_OPERATIONS.md`)

### Tasks (pending creative spec)

#### 2.1 CapCut/VectCut Split-Screen Assembly
- [ ] Implement `assembleShortForm(clipPath, avatarPath, jobId)` in server.js
- [ ] Canvas: 1080×1920 portrait
- [ ] Top layer: Source video clip (1080×960, y=0)
- [ ] Bottom layer: Bobby G short avatar (`bobbyg_short_form.png` / short HeyGen segment) (1080×960, y=960)
- [ ] Logo: `assets/cwn_logo.png` at 80px, top-right (W-w-15:15), 85% opacity
- [ ] Wire into `/assemble` route: when `formType === 'short'`, use split-screen path

#### 2.2 Portrait Thumbnail Frame Extraction
- [ ] Use `ffprobe` to find highest-motion frame in assembled short-form video
- [ ] Extract frame at 1080×1920 (portrait)
- [ ] Apply "BECAUSE THE LIGHT WAS ON" tagline + episode number overlay
- [ ] Save to `output/thumbnail_short_{type}_ep{N}_{timestamp}.png`

#### 2.3 TikTok/Reels Safety Zone Validation
- [ ] Define safe zones in CONFIG:
  - TikTok: avoid bottom-right 200×400px (like/share buttons)
  - Reels: avoid bottom 150px (caption area)
- [ ] Validate Bobby G avatar face position doesn't overlap UI buttons
- [ ] Log warning if overlap detected (don't auto-fix yet — flag for Rob)

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

## ✅ Phase 4: Operations Fixes (No Creative Decision Needed)
**Owner**: Cline  
**Estimate**: 3-4 hours  
**Status**: 🟡 READY TO START

#### 4.1 NBA Intro Prompt Fix
- [ ] Find NBA system prompt in server.js (search: "Other Side of the Pillow" or "Witness the NBA")
- [ ] Strengthen prompt: explicitly forbid "Witness the NBA" intro, enforce "Other Side of the Pillow"
- [ ] Test: run NBA script gen, verify Gate 1 score improves from 85→90+

#### 4.2 Human Approval Checkpoint (Dashboard)
- [ ] After Gate 3 passes, show "✅ Gate 3 PASS — Ready for Upload" in dashboard
- [ ] Add "Approve & Upload" button that triggers `/publish` with current job metadata
- [ ] Add "Reject — Back to Edit" button that keeps job in manual review state
- [ ] Wire to existing `/publish` endpoint

#### 4.3 Gate 6 Auto-Publish
- [ ] After Rob clicks "Approve & Upload", auto-call `/generate-publish-copy` → `/publish`
- [ ] Pass: `{ driveUrl, platforms, title, description, contentType, scheduledAt: null }`
- [ ] Display upload job_id in dashboard
- [ ] Poll `/publish/status?request_id=X` every 10s until confirmed

#### 4.4 Upload-Post Status Polling
- [ ] Add frontend polling loop in `cwn_production.html`
- [ ] Show progress: "Uploading to YouTube... TikTok... Instagram..."
- [ ] On success: show platform links + "Published ✅"
- [ ] On failure: show error + "Retry" button

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

| Phase | Owner | Status | ETA |
|-------|-------|--------|-----|
| Phase 1: Thumbnail Updates | Claude Code | 🟡 Ready | Today |
| Phase 2: Short-Form Infrastructure | Cline | 🔴 Blocked | After creative spec |
| Phase 3: Caption & Prioritization | Aider | 🟡 Ready | Today |
| Phase 4: Operations Fixes | Cline | 🟡 Ready | Today |
| Phase 5: Creative Layer | Claude→Cline | 🔴 Blocked | After creative spec |

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

- **Aider model**: Keep on `openai/google/gemini-2.5-flash` via OpenRouter — fast and cheap for text/logic tasks ✅
- **Phase 1 can start immediately** — Claude Code opens the HTML files, makes the text/CSS changes, tests in browser
- **Phase 3 can start immediately** — Aider writes the caption generator and prioritization logic
- **Phase 2 and 5 are blocked** — don't start until `VISUAL_DESIGN_SPEC.md` exists
- **Phase 4 can start immediately** — pure operations, no creative decisions needed
