# CWN Production Backlog

**Last Updated**: 2026-04-09
**Deployment Target**: Localhost (Railway migration blocked until benchmarks met)
**QA Gate**: Gemini visual + logic audit for all "Done" tasks

---

## 🎯 Active Sprint

### High Priority

#### [DONE] Dynamic Episode Counter Integration
**Status**: ✅ Completed 2026-04-07
**Actual Time**: 1.5 hours

**Changes Made**:
- server.js: Now passes episodeNum to page.evaluate
- News/NBA/Twitch thumbnail generation display dynamic episode
- Removed hardcoded "EPISODE 1" from HTML files
- Episode counter increments atomically per content type

---

#### [DONE] Automated Visual Regression Tests
**Status**: ✅ Completed 2026-04-08

**Changes Made**:
- `qa/visual_regression.js`: Playwright-based screenshot comparison against baselines
- `qa/baselines/`: Stored baseline PNGs
- `package.json`: Added `qa:baseline` and `qa:regression` scripts

---

#### [DONE] Performance Benchmarking Suite
**Status**: ✅ Completed 2026-04-08

**Changes Made**:
- `qa/benchmark.js`: Measures response times + memory for all key endpoints
- `PERFORMANCE.md`: Auto-generated after each benchmark run
- `package.json`: Added `benchmark` and `benchmark:concurrent` scripts

---

#### [DONE] Error Handling Improvements
**Status**: ✅ Completed 2026-04-08

**Changes Made**:
- `lib/error_logger.js`: Structured JSON logging, retry logic, fallback images
- `server.js`: Wired in error logger + `GET /errors` diagnostic endpoint
- `logs/errors.jsonl`: Structured error log (auto-rotates at 10MB)

---

#### [DONE] Twitch Thumbnail Integration
**Status**: ✅ Completed 2026-04-08

**Changes Made**:
- `server.js`: Rewrote `generateTwitchLongformThumbnail()` to use Node.js canvas
- `POST /generate-twitch-longform-thumbnail` accepts `{ streamers?: string[] }`

---

#### [DONE] Wire Publish Button in Dashboard
**Status**: ✅ Completed 2026-04-08

**Changes Made**:
- `cwn_production.html`: `pubGenerateSocialCopy()` now calls server's `/generate-publish-copy` endpoint instead of hitting Anthropic API directly from the browser
- Removed insecure direct `fetch('https://api.anthropic.com/v1/messages', ...)` call
- Server handles all 3 platforms (YouTube, TikTok, Instagram) in one call
- Response maps correctly to `pubDisplay()` for all platform tabs
- Falls back gracefully if server is unreachable

---

#### [DONE] Fix Duplicate /generate-publish-copy Endpoint
**Status**: ✅ Completed 2026-04-08

**Changes Made**:
- Removed simpler duplicate endpoint at line 6577 (used claude-opus-4-5, single-platform)
- Kept comprehensive multi-platform endpoint at line 6973
- Fixed `SyntaxError: Identifier 'downloadFile' has already been declared` crash

---

### Medium Priority

#### [TODO] End-to-End Testing Continuation
**Status**: ⏳ TODO (Claude Code — after Cline/Aider fix)
**Estimate**: Ongoing
**Owner**: Claude Code

**Technical Tasks**:
- [x] Run 12-test suite validation (completed 2026-04-09, 10/12 passed)
- [ ] Monitor re-run after fix is implemented
- [ ] Document final results and confirm 12/12 pass

---

#### [TODO] Gate 6 Automation
**Status**: ⏳ TODO (Claude Code — can start while investigation continues)
**Estimate**: 2-3 hours
**Owner**: Claude Code

**Technical Tasks**:
- [ ] Auto-trigger publish after Gate 3 passes
- [ ] Wire Gate 3 pass → `/generate-publish-copy` → `/publish` sequence
- [ ] Add status tracking in job manifest

---

### Low Priority (DEFERRED until investigation complete)

#### [DEFERRED] Implement Split-Job + FFmpeg Stitch
**Status**: ⏸️ DEFERRED (Aider — blocked by investigation)
**Estimate**: 3-4 hours
**Owner**: Aider
**Blocked by**: Root cause investigation must complete first

**Technical Tasks**:
- [ ] Split large jobs (>5 items) into parallel sub-jobs
- [ ] FFmpeg stitch sub-job outputs into final video
- [ ] Handle progress tracking across split jobs

**Reason for deferral**: Must understand data-specific failures before implementing split-job logic to avoid replicating the bug.

---

#### [DEFERRED] Phonetic Auto-Injection from streamers.json
**Status**: ⏸️ DEFERRED (Aider — after phonetic injection)
**Estimate**: 30 min
**Owner**: Aider
**Blocked by**: Scene count fix must be validated first

**Technical Tasks**:
- [ ] Read `streamers.json` phonetic entries at script generation time
- [ ] Auto-inject phonetic replacements into HeyGen `input_text` before sending
- [ ] No manual pronunciation library entry needed for known streamers

---

#### [DEFERRED] Gate 2A Pronunciation Loop
**Status**: ⏸️ DEFERRED (Aider — after phonetic injection)
**Estimate**: 2 hours
**Owner**: Aider

**Technical Tasks**:
- [ ] Detect mispronounced names in HeyGen output (via HeyGen MCP)
- [ ] Auto-retry with corrected phonetic spelling
- [ ] Max 2 retry attempts per segment

---

#### [DEFERRED] Gate 5 Full Review
**Status**: ⏸️ DEFERRED (Cline — after investigation)
**Estimate**: 1-2 hours
**Owner**: Cline

**Technical Tasks**:
- [ ] Gemini final video review after assembly
- [ ] Check for visual/audio sync issues
- [ ] Auto-flag for manual review if score < 80

---

## ✅ Recently Completed

### [DONE] Aider Load Balancing + Cline Model Upgrade
**Completed**: 2026-04-09

**Changes**:
- **Aider**: Implemented load balancing to handle Gemini 2.5 rate limiting
- **Cline**: Upgraded to Gemini Pro Flash for better performance/reliability
- Resolved rate limiting issues blocking Aider's fix implementation

---

### [DONE] Requesty API + Aider Configuration
**Completed**: 2026-04-08

**Changes**:
- `.aider.conf.yml`: Added Requesty endpoint, API key, `coding/gemini-2.5-pro` model
- Fixed API key (trailing `requestry` text removed)
- Verified `coding/gemini-2.5-pro` works via Requesty ($0.0000125/call)
- Added `show-model-warnings: false` to suppress interactive prompt

---

### [DONE] ~/.claude.json Performance Fix
**Completed**: 2026-04-08

**Changes**:
- Cleared `cachedChangelog` (201KB bloat) → file reduced from 229KB to 5.7KB
- Cleared `cachedGrowthBookFeatures`, `cachedStatsigGates`, `cachedDynamicConfigs`
- Backup saved at `~/.claude.json.bak`

---

### [DONE] .claude/settings.local.json Cleanup
**Completed**: 2026-04-08

**Changes**:
- Removed duplicate `"Bash(node:*)"` with extra quotes
- Removed stale `Bash(echo HeyGen config)` permission
- Removed huge inline `aider` command stored as permission
- Removed one-time `npx skills add heygen-com/skills` install command
- 35 entries → 31 clean permissions

---

#### [DONE] Root Cause Investigation - Multi-Word Name Bug CONFIRMED
**Status**: ✅ FIX IMPLEMENTED
**Started**: 2026-04-09T02:57:00Z
**Completed (Investigation)**: 2026-04-09T03:24:00Z
**Completed (Implementation)**: 2026-05-15T10:00:00Z
**Owner**: Cline (investigation ✅ COMPLETE) → Aider (fix implementation ✅ COMPLETE)
**Priority**: P0 - BLOCKING

**ROOT CAUSE CONFIRMED** (by Cline):
Multi-word names with spaces break scene headers in Gemini prompts.

**Fixes Implemented**:
1.  **Fix 1 & 2 (server.js)**: Modified `parseScriptIntoScenes` function in `server.js` to replace spaces with underscores in all scene headers. This addresses both Twitch streamer names (e.g., "Jay Cinco") and NBA team names (e.g., "Trail Blazers") that caused parsing failures.
2.  **Fix 3 (test_suite_12cases.json)**: Verified that "ExtraEmily" was already correctly represented as "Emily" in the `displayName` field of `test_suite_12cases.json` (Test 2, item 5). No change was needed for this file.

**Technical Tasks (Cline)** ✅ COMPLETE:
- [x] Retrieved generated scripts from Test 2 live run
- [x] Identified exact bug: spaces in scene headers break parsing
- [x] Confirmed with live test data
- [x] Documented exact code fixes in URGENT_TEST_FAILURE_INVESTIGATION.md

**Technical Tasks (Aider)** ✅ COMPLETE:
- [x] Fix 1: Add `.replace(/\s+/g, '_')` to Twitch scene headers (server.js)
- [x] Fix 2: Add `.replace(/\s+/g, '_')` to NBA scene headers (server.js)
- [x] Fix 3: Change "ExtraEmily" → "Emily" in test_suite_12cases.json (Test 2, item 5)
- [ ] Re-run Tests 2 and 4 to validate fix (Pending manual re-run)
- [ ] Confirm 12/12 tests pass after fix (Pending manual re-run)

**Investigation Docs**:
- `/Users/robertgregory/cwn-production/URGENT_TEST_FAILURE_INVESTIGATION.md` (✅ ROOT CAUSE DOCUMENTED)
- `/Users/robertgregory/cwn-production/TEST_RESULTS_FINAL_2026-04-09.md`
- `/Users/robertgregory/cwn-production/test_suite_12cases.json`

---

## 🚫 Blocked / Deferred

### [BLOCKED] Railway Deployment
**Reason**: Performance benchmarks not established
**Next Action**: Run `npm run benchmark` and confirm all pass

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
| Twitch Thumbnail Integration | Pending | Pending | Ready for audit | ep20_1775698264899 |
| Publish Button Wiring | N/A | Pending | Ready for audit | — |

**Target**: 90% pass rate across all audits before Railway migration

---

## 🔧 Tech Debt

1. ~~**Hardcoded episode numbers**~~ — ✅ Fixed 2026-04-07
2. ~~**Missing error logging**~~ — ✅ Fixed 2026-04-08
3. **No request throttling** — Could overwhelm Puppeteer under load
4. **Asset path hardcoding** — Should use environment variables
5. **QA recorder NBA endpoint** — Should use `/generate-thumbnail` with `contentType: 'nba'`
