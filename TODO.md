# CWN Production Backlog

**Last Updated**: 2026-04-07
**Deployment Target**: Localhost (Railway migration blocked until benchmarks met)
**QA Gate**: Gemini visual + logic audit for all "Done" tasks

---

## 🎯 Active Sprint

### High Priority

#### [DONE] Dynamic Episode Counter Integration
**Status**: ✅ Completed 2026-04-07
**Actual Time**: 1.5 hours
**Owner**: Claude (Solo Agile Lead)

**Technical Tasks**:
- [x] Read existing episode counter implementation
- [x] Update `server.js` to pass episodeNum to page.evaluate
- [x] Update news thumbnail generation to display dynamic episode
- [x] Update NBA thumbnail generation to display dynamic episode
- [x] Update Twitch thumbnail generation to display dynamic episode
- [x] Remove hardcoded "EPISODE 1" from HTML files
- [x] Test episode increment across thumbnail generations
- [x] QA Handoff: Screenshots captured in qa_sessions/

**Changes Made**:
- server.js:6374: Now passes episodeNum and constructs episode text dynamically
- server.js:6470: Twitch subtitle includes episode number
- cwn_news_tool.html: Removed hardcoded "EPISODE 1"
- nba_thumbnail_generator.html: Restored original "NBA - LIVE COVERAGE" label

**Test Results**:
- News episode counter: 9 → 10 (incremented successfully)
- Thumbnail generated: `thumbnail_news_ep9_1775565332301.png`
- Episode persists across server restarts

**Gemini Audit Focus**:
- Visual: Episode number renders clearly in thumbnails
- Logic: Counter increments atomically per content type

---

#### [PENDING] Twitch Thumbnail Integration
**Status**: 🔴 Blocked - waiting on `twitchsoup_thumbnail.jpeg`
**Estimate**: 1 hour (once asset received)
**Owner**: Claude (Solo Agile Lead)

**Technical Tasks**:
- [ ] Receive `twitchsoup_thumbnail.jpeg` from user
- [ ] Verify transparency/quality of asset
- [ ] Update Twitch thumbnail generator to use base image
- [ ] Position streamer circles around Bobby G correctly
- [ ] Test with 2-5 streamers
- [ ] QA Handoff: Record video of thumbnail generation with animation

**Gemini Audit Focus**:
- Visual: Streamer circles positioned correctly, no overlap
- Visual: Bobby G image clarity and transparency
- Logic: Handles variable streamer count (1-10)

---

### Medium Priority

#### [TODO] Add Automated Visual Regression Tests
**Status**: ⚪ Not started
**Estimate**: 4 hours
**Owner**: Claude (Solo Agile Lead)

**Technical Tasks**:
- [ ] Set up Playwright visual comparison baseline
- [ ] Create baseline screenshots for all thumbnail types
- [ ] Add diff threshold configuration (e.g., 0.1% tolerance)
- [ ] Integrate into CI/CD pipeline (localhost only for now)
- [ ] Document baseline update process

**Gemini Audit Focus**:
- Logic: Visual diffs correctly identify regressions
- Logic: Baseline management process is documented

---

#### [TODO] Performance Benchmarking Suite
**Status**: ⚪ Not started
**Estimate**: 3 hours
**Owner**: Claude (Solo Agile Lead)

**Technical Tasks**:
- [ ] Define performance targets (e.g., thumbnail gen < 2s)
- [ ] Create benchmark script for all endpoints
- [ ] Measure memory usage during Puppeteer operations
- [ ] Identify bottlenecks (FFmpeg, image processing, etc.)
- [ ] Document results in `PERFORMANCE.md`

**Railway Migration Blocker**:
This must be complete before Railway deployment. Target benchmarks:
- Thumbnail generation: < 3s per thumbnail
- Memory usage: < 512MB peak
- Concurrent requests: Handle 10 simultaneous thumbnail generations

---

### Low Priority

#### [TODO] Error Handling Improvements
**Status**: ⚪ Not started
**Estimate**: 2 hours
**Owner**: Claude (Solo Agile Lead)

**Technical Tasks**:
- [ ] Add retry logic for ESPN API failures
- [ ] Improve error messages for missing assets
- [ ] Add fallback images for broken story images
- [ ] Log errors to structured file (not just console)
- [ ] Add error rate monitoring

---

## ✅ Recently Completed

### [DONE] Dynamic Episode Counter Integration
**Completed**: 2026-04-07
**QA Status**: ✅ Ready for Gemini audit
**Artifacts**: `output/qa_sessions/session_1775565876183.webm`

**Changes**:
- Removed hardcoded "EPISODE 1" from all thumbnail generators
- Server now dynamically passes episode number to Puppeteer
- Episode counter increments atomically per content type
- Tested: News ep 9→10, counter persists across restarts

**Files Modified**: server.js:6374, server.js:6470, cwn_news_tool.html, nba_thumbnail_generator.html

---

### [DONE] Newscast Overlay Redesign
**Completed**: 2026-04-07
**QA Status**: ✅ Ready for Gemini audit

**Changes**:
- Story list increased to 420px width
- Font sizes increased (13px → 16px)
- Breaking flag moved to top left
- Top ticker removed completely
- Bottom ticker retained

**Artifacts**: `qa/record_session.js` captures screenshots

---

### [DONE] News Thumbnail Visual Updates
**Completed**: 2026-04-07
**QA Status**: ✅ Ready for Gemini audit

**Changes**:
- Background lightening (brightness 0.25 → 0.45)
- Source badges removed (ESPN/Al Jazeera)
- Category text updated to "CLIPZWORLD NEWS - EPISODE 1"
- Font size increased (14px → 20px)

**Known Issue**: Episode number hardcoded (see Active Sprint)

---

### [DONE] NBA Thumbnail Background System
**Completed**: 2026-04-07
**QA Status**: ✅ Ready for Gemini audit

**Changes**:
- Added `nba_long_form thumbnail.jpg` as constant background
- Lightened background (brightness 0.4)
- Reduced team color overlay opacity
- Updated label to "CLIPZWORLD NBA - EPISODE 1"

**Known Issue**: Episode number hardcoded (see Active Sprint)

---

### [DONE] QA Automation Infrastructure
**Completed**: 2026-04-07
**QA Status**: ✅ Self-documenting

**Changes**:
- Installed Playwright
- Created `qa/record_session.js` automated recorder
- Generates video, screenshots, error logs
- Generates QA Handoff markdown per session

---

## 🚫 Blocked / Deferred

### [BLOCKED] Railway Deployment
**Reason**: Performance benchmarks not established
**Next Action**: Complete "Performance Benchmarking Suite" task

### [DEFERRED] Multi-language Support
**Reason**: Not in scope for MVP
**Estimate**: 8 hours

---

## 📊 Gemini QA Scorecard

| Feature | Visual Score | Logic Score | Status | QA Session |
|---------|--------------|-------------|--------|------------|
| Dynamic Episode Counter | Pending | Pending | Ready for audit | session_1775565876183 |
| Newscast Overlay | Pending | Pending | Ready for audit | session_1775565876183 |
| News Thumbnails | Pending | Pending | Ready for audit | session_1775565876183 |
| NBA Thumbnails | Pending | Pending | Ready for audit | session_1775565876183 |
| QA Recorder | N/A | Pending | Self-audit | session_1775565876183 |

**Target**: 90% pass rate across all audits before Railway migration

**Latest QA Session**: session_1775565876183
- Video: 130KB webm recording
- Screenshots: health, newscast_overlay, news_tool, nba_generator
- Errors: 3 console (non-critical), 0 page errors
- Artifacts: `/output/qa_sessions/`

---

## 🔧 Tech Debt

1. ~~**Hardcoded episode numbers**~~ - ✅ Fixed 2026-04-07 (Dynamic counter implemented)
2. **Missing error logging** - Console only, no structured logs
3. **No request throttling** - Could overwhelm Puppeteer under load
4. **Asset path hardcoding** - Should use environment variables
5. **QA recorder NBA endpoint** - Currently tests non-existent /generate-nba-thumbnail (should use /generate-thumbnail with contentType: 'nba')

---

## 📝 Notes

- All "Done" tasks include QA Handoff documentation
- Gemini audit focuses on visual + logic correctness
- Localhost deployment only until benchmarks met
- Twitch thumbnail blocked on user-provided asset
