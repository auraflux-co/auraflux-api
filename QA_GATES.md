# CWN Production QA Gates & Checklists

**Last Updated**: 2026-04-07
**Status**: Pre-Production Validation Phase
**Deployment**: Localhost → Railway (after all 12 tests pass)

---

## 🎯 Definition of Done

**Production readiness requires**:
- ✅ All 12 test cases pass with 100% QA score
- ✅ Gemini visual + logic audit scores ≥90%
- ✅ Private publishing validates on all platforms
- ✅ HeyGen script generation verified
- ✅ Thumbnail generation < 3s per thumbnail
- ✅ Full automation runs without manual intervention

---

## 📋 The 12 Test Cases

### Test Group 1: Twitch Content
| Test # | Content Type | Format | Platform | Duration | Publish As |
|--------|--------------|--------|----------|----------|------------|
| Test 1 | Twitch | Long Form | YouTube | 8-12 min | Private |
| Test 2 | Twitch | Short Form | YouTube | 60s | Private |
| Test 3 | Twitch | Short Form | TikTok | 60s | Only Me |
| Test 4 | Twitch | Short Form | Instagram | 60s | Private Account |

### Test Group 2: NBA Content
| Test # | Content Type | Format | Platform | Duration | Publish As |
|--------|--------------|--------|----------|----------|------------|
| Test 5 | NBA | Long Form | YouTube | 8-12 min | Private |
| Test 6 | NBA | Short Form | YouTube | 60s | Private |
| Test 7 | NBA | Short Form | TikTok | 60s | Only Me |
| Test 8 | NBA | Short Form | Instagram | 60s | Private Account |

### Test Group 3: News Content
| Test # | Content Type | Format | Platform | Duration | Publish As |
|--------|--------------|--------|----------|----------|------------|
| Test 9 | News | Long Form | YouTube | 8-12 min | Private |
| Test 10 | News | Short Form | YouTube | 60s | Private |
| Test 11 | News | Short Form | TikTok | 60s | Only Me |
| Test 12 | News | Short Form | Instagram | 60s | Private Account |

---

## 🔍 QA Gate 1: Content Generation

**Trigger**: POST to `/generate-publish-copy`

**Checklist**:
- [ ] **Thumbnail Generated** - PNG file created at 1280x720
  - [ ] Episode number displays correctly
  - [ ] Background image loaded and lightened
  - [ ] Text readable and properly positioned
  - [ ] No visual artifacts or clipping

- [ ] **Title Generated** - SEO-optimized, platform-specific
  - [ ] YouTube: ≤100 chars, keywords front-loaded
  - [ ] TikTok: ≤100 chars, trending format
  - [ ] Instagram: ≤125 chars, emoji appropriate
  - [ ] Both team names in NBA titles
  - [ ] Source attribution in News titles

- [ ] **Description Generated** - Rich metadata
  - [ ] First 2 lines keyword-dense (shown before "show more")
  - [ ] Timestamps included (long form only)
  - [ ] 8-20 hashtags included
  - [ ] Subscribe CTA present
  - [ ] Length: 300-500 chars minimum

- [ ] **HeyGen Script Generated** - Scene-by-scene directions
  - [ ] Shot titles match content type
  - [ ] Scene descriptions are actionable
  - [ ] Duration allocations sum to target length
  - [ ] Bobby G directions clear and specific

**Pass Criteria**: All checkboxes ✅, no errors in console

**Failure Actions**:
- Log error to structured log file
- Capture screenshot of failure state
- Do not proceed to QA Gate 2

---

## 🔍 QA Gate 2: HeyGen Segment Rendering

**Trigger**: Script passes Gate 1, sent to HeyGen API

**Checklist**:
- [ ] **Script Format Valid** - JSON structure correct
  - [ ] All required fields present (sceneTitle, duration, directions)
  - [ ] Durations are numeric and positive
  - [ ] Scene count matches content type requirements

- [ ] **HeyGen API Response** - Video generation started
  - [ ] API returns 200 OK
  - [ ] Video ID returned
  - [ ] Estimated completion time provided

- [ ] **Segment Technical QA** (Gemini samples 3 segments: first, middle, last)
  - [ ] Bobby G avatar appears correctly
  - [ ] Basic lip sync present (not garbled)
  - [ ] Scene transitions smooth
  - [ ] Audio levels consistent
  - [ ] No visual glitches or freezing

**Pass Criteria**: Segment QA score ≥65, no critical failures (lip sync broken, audio missing, wrong avatar)

**Failure Actions**:
- Score <65 OR critical failure → Re-render HeyGen segments (max 3 retries)
- Log HeyGen API response for debugging

**Code Reference**: server.js:1251-1370

---

## 🔍 QA Gate 2A: Pronunciation & Speech Clarity (NEW - NOT YET IMPLEMENTED)

**Trigger**: HeyGen segments pass Gate 2 technical checks

**Purpose**: Ensure Bobby G pronounces all names/terms correctly and speaks naturally

**Checklist**:
- [ ] **Name Pronunciation** - Streamer/player names pronounced correctly
  - [ ] Check against `phonetic` field in streamers.json (e.g., "Yonna" → "Yawn-uh")
  - [ ] Team names pronounced clearly (Lakers, Celtics, etc.)
  - [ ] News source names correct (ESPN, Al Jazeera, etc.)

- [ ] **Term Clarity** - Gaming/NBA/news jargon pronounced clearly
  - [ ] No mid-word stutters or glitches
  - [ ] Abbreviations handled correctly (NBA, GTA RP, etc.)
  - [ ] Numbers spoken naturally ("three-pointer" not "3-pointer")

- [ ] **Natural Flow** - Speech sounds conversational, not robotic
  - [ ] Pauses feel natural (not too long/short)
  - [ ] `[beat]` markers respected (1-2 second pauses)
  - [ ] No awkward word spacing or rushed sections

- [ ] **Audio Glitches** - No technical speech issues
  - [ ] No repeated words/syllables
  - [ ] No audio dropouts mid-sentence
  - [ ] Volume consistent across all segments

**Gemini Scoring**:
- **100 pts**: Perfect pronunciation, natural flow
- **-15 pts**: Per mispronounced name (critical)
- **-10 pts**: Per unclear term/jargon
- **-5 pts**: Per awkward pause (non-beat)
- **-20 pts**: Per audio glitch (stutter, dropout)

**Pass Criteria**: ≥85 pts (no critical name failures)

**Failure Actions**:
1. **Score 85-100**: Pass → Proceed to Gate 3
2. **Score 70-84**: Minor issues detected
   - Gemini generates pronunciation feedback report
   - Feedback sent to Claude + HeyGen MCP
   - Claude revises script with phonetic spelling corrections
   - HeyGen re-renders ONLY affected segments
   - Gate 2A re-runs (max 3 iterations)
3. **Score <70**: Hard fail
   - Manual review required
   - Flag specific mispronunciations
   - Update `phonetic` fields in streamers.json if needed
   - Regenerate entire script with pronunciation guidance

**HeyGen Iteration Loop**:
```
Gate 2A Fail (pronunciation issue)
  ↓
Gemini: "Bobby G said 'Yo-na' instead of 'Yawn-uh' at 0:42"
  ↓
Claude (with HeyGen MCP context): Revise script segment
  OLD: "Next up is Yonna from Brevard"
  NEW: "Next up is Yonna (Yawn-uh) from Brevard"
  ↓
HeyGen MCP: Re-render segment with updated script
  ↓
Gate 2A re-check → If pass, proceed
```

**Current Status**: 🔴 **NOT IMPLEMENTED**
- ❌ HeyGen MCP server doesn't exist
- ❌ Pronunciation feedback loop not automated
- ❌ Claude doesn't auto-inject phonetic spellings from streamers.json
- ✅ Phonetic field exists in streamers.json (e.g., Yonna: "Yawn-uh")
- ✅ Gate 2 checks lip sync technically but not pronunciation accuracy

**Implementation Required**:
1. Create HeyGen MCP server for API integration
2. Add Gate 2A to assembly workflow (after Gate 2, before Gate 3)
3. Update Claude script generation to auto-inject phonetics
4. Build pronunciation iteration loop (Gemini → Claude → HeyGen MCP)

---

---

## 🔍 QA Gate 3: Platform Upload Validation

**Trigger**: Video file ready for upload

**Checklist - YouTube**:
- [ ] **Video File** - MP4, H.264, 1080p minimum
  - [ ] File size < 128GB
  - [ ] Duration matches expected (±5s tolerance)
  - [ ] Aspect ratio correct (16:9 long, 9:16 short)

- [ ] **Metadata Upload**
  - [ ] Title uploaded correctly
  - [ ] Description uploaded correctly
  - [ ] Thumbnail uploaded (custom)
  - [ ] Privacy set to "Private"
  - [ ] Category set correctly
  - [ ] Tags applied (from hashtags)

- [ ] **Post-Upload Validation**
  - [ ] Video processes without errors
  - [ ] Thumbnail displays in video manager
  - [ ] Title/description visible in edit view
  - [ ] Video playable at all resolutions

**Checklist - TikTok**:
- [ ] **Video File** - MP4, 9:16 vertical
  - [ ] Duration 5-60s (short form)
  - [ ] File size < 287.6MB
  - [ ] Resolution 1080x1920 recommended

- [ ] **Metadata Upload**
  - [ ] Caption uploaded (title + hashtags)
  - [ ] Privacy set to "Only Me"
  - [ ] Cover image selected
  - [ ] Sounds/music detected correctly

- [ ] **Post-Upload Validation**
  - [ ] Video appears in drafts/private
  - [ ] Caption fully visible
  - [ ] No copyright flags
  - [ ] Playable without buffering

**Checklist - Instagram**:
- [ ] **Video File** - MP4, 9:16 vertical (Reels)
  - [ ] Duration 5-60s (short form)
  - [ ] File size < 4GB
  - [ ] Frame rate 23-60 FPS

- [ ] **Metadata Upload**
  - [ ] Caption uploaded (title + hashtags)
  - [ ] Account set to Private
  - [ ] Cover frame selected
  - [ ] Location tagged (optional)

- [ ] **Post-Upload Validation**
  - [ ] Reel appears in profile
  - [ ] Caption fully visible
  - [ ] Hashtags clickable
  - [ ] Video quality preserved

**Pass Criteria**: Video uploaded successfully to platform, metadata intact, privacy settings correct

**Failure Actions**:
- Check platform API status
- Verify video encoding parameters
- Retry upload with exponential backoff
- If 3 retries fail, log as critical error

---

## 🔍 QA Gate 4: Gemini Visual Audit

**Trigger**: All 12 test videos uploaded privately

**Gemini Receives**:
- Screenshots of each video thumbnail
- First frame of video
- Platform upload confirmation screenshot
- Generated title/description text

**Audit Focus**:

### Visual Quality (40 points)
- [ ] Thumbnail text legible (10 pts)
- [ ] No visual artifacts or compression issues (10 pts)
- [ ] Color scheme consistent with brand (10 pts)
- [ ] Layout matches design specs (10 pts)

### Content Accuracy (40 points)
- [ ] Title matches content (10 pts)
- [ ] Description relevant and complete (10 pts)
- [ ] Episode number correct (10 pts)
- [ ] Platform formatting appropriate (10 pts)

### Technical Compliance (20 points)
- [ ] Aspect ratio correct for platform (10 pts)
- [ ] File uploaded without errors (10 pts)

**Pass Criteria**: ≥90% score (36/40 points minimum)

**Failure Actions**:
- Review failed items with Gemini feedback
- Regenerate content if score <80%
- Fix and retest before proceeding

---

## 🔍 QA Gate 5: Gemini Final Video Review

**Trigger**: Video assembly completes, final MP4 generated

**Purpose**: Full visual QA of the assembled video before platform upload

**Checklist**:
- [ ] **Video Playback** - MP4 plays without errors
  - [ ] File size reasonable (not corrupted)
  - [ ] Duration matches expected length (±5s tolerance)
  - [ ] No black screens or freezing

- [ ] **Avatar Segments** - Bobby G appears correctly throughout
  - [ ] Lip sync maintained in final assembly
  - [ ] Audio levels consistent (avatar + clips)
  - [ ] No glitches introduced during assembly

- [ ] **Clip Integration** - Source clips inserted correctly
  - [ ] `[CLIP PLAYS HERE]` markers replaced with actual clips
  - [ ] Clips play at correct timestamps
  - [ ] Transitions smooth (avatar → clip → avatar)

- [ ] **Overall Quality** - Broadcast-ready assessment
  - [ ] Visual quality maintained (no compression artifacts)
  - [ ] Audio quality clear (no distortion)
  - [ ] Pacing feels natural (not rushed/dragging)
  - [ ] Final video matches script structure

**Gemini Scoring**:
- **Visual Quality**: 30 pts (clarity, no artifacts)
- **Audio Quality**: 30 pts (clear, balanced levels)
- **Integration**: 30 pts (clips + avatar seamless)
- **Pacing**: 10 pts (natural flow)

**Pass Criteria**: ≥85 pts (no critical failures)

**Failure Actions**:
- Score <85: Re-assemble with adjusted parameters
- Critical failures: Escalate to manual review
- Log assembly settings for debugging

---

## 🔍 QA Gate 6: Final MP4 Delivery & Upload Preparation

**Trigger**: Gate 5 passes (final video approved)

**Purpose**: Deliver final MP4 and prepare for platform upload

**Checklist**:
- [ ] **File Delivery** - MP4 sent to output directory
  - [ ] File copied to `/output/final_videos/`
  - [ ] Filename format: `{contentType}_{format}_{episodeNum}_{timestamp}.mp4`
  - [ ] File permissions correct (readable by upload scripts)

- [ ] **Metadata Package** - All upload assets ready
  - [ ] Thumbnail PNG generated and saved
  - [ ] Title text file created
  - [ ] Description text file created
  - [ ] Hashtags list file created
  - [ ] Platform-specific metadata (YouTube category, TikTok caption, IG caption)

- [ ] **Upload Readiness** - Platform-specific validation
  - [ ] File size within platform limits (YouTube: <128GB, TikTok: <287MB, IG: <4GB)
  - [ ] Duration within platform limits (TikTok: 5-60s, IG Reels: 5-60s)
  - [ ] Aspect ratio correct (16:9 long, 9:16 short)
  - [ ] Resolution acceptable (1080p minimum)

- [ ] **QA Handoff** - Send to Gemini for final sign-off
  - [ ] Final MP4 uploaded to temp URL for Gemini review
  - [ ] Thumbnail + metadata sent for visual audit
  - [ ] Gemini confirms video + metadata ready for publish
  - [ ] Gate 6 score logged

**Gemini Final Sign-Off Scoring**:
- **Video Matches Metadata**: 50 pts (thumbnail/title/description accurate)
- **Platform Compliance**: 30 pts (size/duration/aspect ratio correct)
- **Ready for Publish**: 20 pts (no last-minute issues spotted)

**Pass Criteria**: ≥90 pts (strict before platform upload)

**Success Actions**:
1. Move MP4 to upload queue
2. Trigger platform upload via Upload-Post API
3. Log upload job ID for tracking
4. Send final package to Gemini for post-publish monitoring

**Failure Actions**:
- Score <90: Hold video, manual review required
- Missing metadata: Regenerate via `/generate-publish-copy`
- Platform non-compliance: Re-encode video with correct settings

**Current Status**: 🔴 **NOT AUTOMATED**
- ✅ MP4 delivery happens (assembly saves to output/)
- ❌ No automated metadata packaging
- ❌ No Gate 6 Gemini final sign-off
- ❌ Upload-Post API not integrated with QA gates

---

## 🔍 QA Gate 7: Logic Audit (Automated)

**Trigger**: All previous gates pass

**Automated Checks**:

### Data Integrity (20 checks)
- [ ] Episode counter incremented correctly
- [ ] Thumbnail file exists on disk
- [ ] Video file exists and is playable
- [ ] Title length within platform limits
- [ ] Description length within platform limits
- [ ] Hashtag count 8-20
- [ ] Timestamps present (long form only)
- [ ] CTA present in description
- [ ] Metadata saved to database/log
- [ ] Upload confirmation received
- [ ] Privacy settings verified
- [ ] File paths correct in output directory
- [ ] JSON response structure valid
- [ ] No duplicate content IDs
- [ ] HeyGen script saved to disk
- [ ] Thumbnail matches expected dimensions
- [ ] Video duration within tolerance
- [ ] Platform API returned success
- [ ] No console errors during generation
- [ ] Episode counter file atomic write

**Pass Criteria**: 20/20 checks pass (100%)

**Failure Actions**:
- Log failed checks to error log
- Do not proceed to full automation
- Review code for logic errors

---

## 📊 Test Results Tracking

### Test Scorecard Template

```markdown
## Test #X: [Content Type] [Format] [Platform]

**Date**: YYYY-MM-DD
**Episode**: #X
**Duration**: XXs/XXm

### QA Gate 1: Content Generation
- [ ] Thumbnail: PASS/FAIL
- [ ] Title: PASS/FAIL
- [ ] Description: PASS/FAIL
- [ ] HeyGen Script: PASS/FAIL

### QA Gate 2: Video Assembly
- [ ] HeyGen API: PASS/FAIL
- [ ] Video Quality: PASS/FAIL

### QA Gate 3: Platform Upload
- [ ] Video File: PASS/FAIL
- [ ] Metadata: PASS/FAIL
- [ ] Post-Upload: PASS/FAIL

### QA Gate 4: Gemini Visual Audit
- Visual Quality: XX/40
- Content Accuracy: XX/40
- Technical Compliance: XX/20
- **Total**: XX/100

### QA Gate 5: Logic Audit
- Checks Passed: XX/20

**OVERALL RESULT**: PASS/FAIL
**Notes**: [Any observations, issues, or improvements]
```

---

## 🚀 Graduation Criteria

**To move from localhost to Railway**:
1. All 12 tests PASS with ≥90% Gemini score
2. All 12 tests PASS with 100% logic audit
3. No critical errors in any test run
4. Performance benchmarks met:
   - Thumbnail generation: <3s
   - Content generation: <10s
   - Upload (excluding HeyGen): <30s
5. Manual review confirms video quality
6. Privacy settings verified on all platforms

**Graduation Actions**:
1. Update TODO.md status to "Production Ready"
2. Tag git commit as `v1.0.0-production`
3. Deploy to Railway with environment variables
4. Enable full automation
5. Monitor first 10 live publishes closely

---

## ⏱️ Production Timelines & Buffers

### Production Time Per Video Type

**Long Form (8-12 min videos)**:
- Script generation (Claude): 5-10 min
- Script QA validation (Gemini): 2-3 min
- HeyGen avatar rendering: 30-60 min (per scene, parallel processing possible)
- Video assembly (FFmpeg): 3-5 min
- Thumbnail generation: <3s (automated)
- **Total: 50-100 minutes per long form video**

**Short Form (60s videos)**:
- Script generation (Claude): 3-5 min
- Script QA validation (Gemini): 1-2 min
- HeyGen avatar rendering: 10-20 min (fewer scenes)
- Video assembly (FFmpeg): 1-2 min
- CapCut platform optimization: 5-10 min (3 variants)
- **Total: 25-50 minutes per short form video**

### Platform Upload & Processing Buffers

**YouTube**:
- Upload time: 2-10 min (depends on file size)
- Processing time: 10-30 min (HD processing)
- **Buffer required: 1-2 hours before scheduled publish**

**TikTok**:
- Upload time: 1-3 min
- Processing time: 5-15 min
- **Buffer required: 30-60 min before scheduled publish**

**Instagram Reels**:
- Upload time: 1-3 min
- Processing time: 5-15 min
- **Buffer required: 30-60 min before scheduled publish**

### Daily Production Windows

**For 2pm YouTube Long Form Publish**:
- Start production: 11am (3-hour buffer)
- Latest start: 12pm (2-hour minimum buffer)

**For 12pm Instagram Shorts Publish**:
- Start production: 10am (2-hour buffer)
- Latest start: 11am (1-hour minimum buffer)

**For 4pm/6pm Publishes**:
- Start production: Morning (full day buffer recommended)
- Latest start: 2-4 hours before publish time

---

## 📅 12-Test Execution Framework

### Test Execution Schedule (Accelerated - 1-3 Days)

**Key Update**: Since all test uploads are **private/only-me**, we can run tests back-to-back on the same day instead of spreading over 9 days. Only delay if a test fails and needs debugging.

**Testing Strategy**:
- ✅ **Same-day testing**: Run multiple tests sequentially if passing
- ⚠️ **Delay on failure**: If test fails, pause to debug before continuing
- ✅ **Parallel platform tests**: TikTok + Instagram can run simultaneously (different platforms)
- ❌ **No parallel YouTube tests**: YouTube processing can bottleneck, run sequentially

---

### Accelerated Timeline (All Tests Pass Scenario)

**Day 1: Twitch Content (Tests 1-4) - 6-8 hours**

**Day 1: Twitch Content (Tests 1-4) - Complete in 6-8 hours if all pass**

**9:00am - Test 1: Twitch Long Form YouTube**
- 9:00am: Generate script + Gate 1 QA validation
- 9:30am: Render HeyGen segments (30-60 min)
- 10:30am: Gate 2 segment QA (Gemini samples 3)
- 10:45am: *(If Gate 2A existed: Pronunciation check)*
- 11:00am: Assemble video + generate thumbnail
- 11:15am: Gate 5 final video review (Gemini)
- 11:30am: Upload to YouTube as Private
- 12:00pm: Gate 6 final MP4 delivery + metadata package
- 12:15pm: Gate 7 logic audit (automated)
- **12:30pm: Test 1 COMPLETE** ✅

**12:30pm - Test 2: Twitch Short Form YouTube**
- 12:30pm: Generate script + Gate 1 QA
- 1:00pm: Render HeyGen (10-20 min, fewer scenes)
- 1:20pm: Gate 2 segment QA
- 1:30pm: Assemble + CapCut optimization (9:16)
- 1:45pm: Gate 5 final video review
- 2:00pm: Upload to YouTube Shorts as Private
- 2:15pm: Gate 6 + Gate 7
- **2:30pm: Test 2 COMPLETE** ✅

**2:30pm - Tests 3-4: Twitch TikTok + Instagram (Parallel)**
- 2:30pm: Generate 2 scripts + Gate 1 QA (parallel)
- 3:00pm: Render both HeyGen videos (parallel)
- 3:20pm: Gate 2 segment QA (both)
- 3:30pm: Assemble + CapCut (2 platform variants each)
- 3:45pm: Gate 5 final video review (both)
- 4:00pm: **Parallel uploads**:
  - Test 3 → TikTok (Only Me)
  - Test 4 → Instagram Reels (Private Account)
- 4:30pm: Gate 6 + Gate 7 (both)
- **5:00pm: Tests 3-4 COMPLETE** ✅

**Day 1 Result**: If all 4 pass → Proceed to Day 2 (NBA). If any fail → Debug, fix, retest before continuing.

**Failure Handling**:
- If Test 1 fails: Fix before starting Test 2 (sequential dependency)
- If Test 2 fails: Can still run Tests 3-4 (different formats)
- If Test 3 or 4 fails: Debug platform-specific issue (CapCut, upload settings)

---

**Day 2: NBA Content (Tests 5-8) - Complete in 6-8 hours if all pass**

**9:00am - Test 5: NBA Long Form YouTube**
- 9:00am: Generate script (NBA game highlights)
- 9:30am: Render HeyGen segments
- 10:30am: Gate 2 segment QA
- 11:00am: Assemble + NBA-specific thumbnail (team colors, game info)
- 11:30am: Gate 5 final video review
- 11:45am: Upload to YouTube as Private
- 12:15pm: Gate 6 + Gate 7
- **12:30pm: Test 5 COMPLETE** ✅
- **Focus**: NBA metadata accuracy, team names pronounced correctly

**12:30pm - Test 6: NBA Short Form YouTube**
- 12:30pm: Generate script (fast-paced highlight clip)
- 1:00pm: Render HeyGen
- 1:20pm: Gate 2 segment QA
- 1:30pm: Assemble + CapCut optimization
- 1:45pm: Gate 5 final video review
- 2:00pm: Upload to YouTube Shorts as Private
- 2:30pm: Gate 6 + Gate 7
- **2:45pm: Test 6 COMPLETE** ✅
- **Focus**: Pacing appropriate for 60s format, energy level

**2:45pm - Tests 7-8: NBA TikTok + Instagram (Parallel)**
- 2:45pm: Generate 2 scripts (platform-optimized)
- 3:15pm: Render both HeyGen videos
- 3:35pm: Gate 2 segment QA (both)
- 3:45pm: Assemble + CapCut (engagement hooks, captions)
- 4:00pm: Gate 5 final video review (both)
- 4:15pm: **Parallel uploads**:
  - Test 7 → TikTok (Only Me)
  - Test 8 → Instagram Reels (Private Account)
- 4:45pm: Gate 6 + Gate 7 (both)
- **5:15pm: Tests 7-8 COMPLETE** ✅
- **Focus**: Platform-specific engagement hooks, NBA jargon clarity

**Day 2 Result**: If all 4 pass → Proceed to Day 3 (News). If any fail → Debug and retest.

---

**Day 3: News Content (Tests 9-12) - Complete in 6-8 hours if all pass**

**9:00am - Test 9: News Long Form YouTube**
- 9:00am: Generate script (news story breakdown)
- 9:30am: Render HeyGen segments
- 10:30am: Gate 2 segment QA
- 11:00am: Assemble + news-specific thumbnail (source attribution)
- 11:30am: Gate 5 final video review
- 11:45am: Upload to YouTube as Private
- 12:15pm: Gate 6 + Gate 7
- **12:30pm: Test 9 COMPLETE** ✅
- **Focus**: Journalistic integrity, source names pronounced correctly

**12:30pm - Test 10: News Short Form YouTube**
- 12:30pm: Generate script (news hook + context in 60s)
- 1:00pm: Render HeyGen
- 1:20pm: Gate 2 segment QA
- 1:30pm: Assemble + CapCut optimization
- 1:45pm: Gate 5 final video review
- 2:00pm: Upload to YouTube Shorts as Private
- 2:30pm: Gate 6 + Gate 7
- **2:45pm: Test 10 COMPLETE** ✅
- **Focus**: Info density appropriate, context clear in 60s

**2:45pm - Tests 11-12: News TikTok + Instagram (Parallel)**
- 2:45pm: Generate 2 scripts (social-optimized news)
- 3:15pm: Render both HeyGen videos
- 3:35pm: Gate 2 segment QA (both)
- 3:45pm: Assemble + CapCut (accessibility for casual viewers)
- 4:00pm: Gate 5 final video review (both)
- 4:15pm: **Parallel uploads**:
  - Test 11 → TikTok (Only Me)
  - Test 12 → Instagram Reels (Private Account)
- 4:45pm: Gate 6 + Gate 7 (both)
- **5:15pm: Tests 11-12 COMPLETE** ✅
- **Focus**: News accessible to non-news audiences, not sensationalized

**Day 3 Result**: If all 4 pass → **ALL 12 TESTS COMPLETE!** 🎉

---

### Fastest Possible Timeline

**If all 12 tests pass without failures**:
- **Day 1**: Tests 1-4 (Twitch) → 6-8 hours
- **Day 2**: Tests 5-8 (NBA) → 6-8 hours
- **Day 3**: Tests 9-12 (News) → 6-8 hours

**Total**: 3 days (18-24 hours of active testing)

**Realistic Timeline (with minor issues)**:
- **Days 1-3**: Initial run (expect 1-2 failures per day)
- **Day 4**: Retest failed tests after fixes
- **Total**: 4 days

**Worst Case (multiple failures)**:
- **Days 1-5**: Initial testing + debugging
- **Days 6-7**: Retesting with fixes
- **Total**: 7 days (still better than original 9-day spread)

---

### Post-Test Actions

**If All 12 Tests Pass (100% Success Rate)**:
1. Update TODO.md → "Production Ready" status
2. Tag git commit as `v1.0.0-production-validated`
3. Enable full automation on localhost
4. Begin Railway migration in parallel
5. Monitor first 10 live publishes with manual spot-checks
6. Transition to fully autonomous operation

**If 1-3 Tests Fail (75-92% Success Rate)**:
1. Analyze failure patterns by QA gate
2. Fix identified issues
3. Retest failed tests only
4. If retests pass → Proceed with caution
5. Increase monitoring during first 20 live publishes

**If 4+ Tests Fail (<67% Success Rate)**:
1. STOP all testing
2. Conduct full system audit
3. Review QA gates for gaps
4. Fix critical issues
5. Restart 12-test framework from Phase 1

---

### Test Result Tracking Template

Create individual markdown files for each test:

**File**: `qa_results/test_01_twitch_long_youtube.md`
**File**: `qa_results/test_02_twitch_short_youtube.md`
... (etc for all 12 tests)

**Template Structure** (see Test Scorecard Template in previous section)

---

## 📝 Notes

### Current Implementation Status

**✅ Implemented (Working Now)**:
- Gate 1: Script QA (Gemini reviews Claude's script) - server.js:1077
- Gate 2: HeyGen Segment QA (Gemini samples 3 segments for tech issues) - server.js:1251
- Gate 3: Platform Upload Validation (manual)
- Gate 4: Gemini Visual Audit (manual)
- Phonetic field exists in streamers.json (e.g., Yonna: "Yawn-uh") - streamers.json:70

**🔴 NOT Implemented (Critical Gaps)**:
- **Gate 2A: Pronunciation & Clarity Check** - Detects mispronunciations, feeds back to Claude
- **Gate 5: Gemini Final Video Review** - Full assembled video QA before upload
- **Gate 6: Final MP4 Delivery** - Automated metadata packaging + upload prep
- **Gate 7: Logic Audit** - Partially implemented, not comprehensive
- **HeyGen MCP Server** - CRITICAL for pronunciation iteration loop
- **Claude phonetic auto-injection** - Claude doesn't use `phonetic` field from streamers.json
- **Upload-Post API integration** - Not connected to QA gate workflow

### Testing Strategy

- **Privacy First**: All test uploads are private/only-me to prevent public visibility during testing.
- **Accelerated Testing**: Complete all 12 tests in 3 days (6-8 hours per day) if all passing
- **Same-Day Retesting**: Since private uploads, can retest immediately after fixes
- **Parallel Platform Tests**: TikTok + Instagram can run simultaneously (different platforms)
- **Sequential YouTube Tests**: Avoid YouTube processing bottlenecks by running sequentially
- **Rollback Plan**: If any phase fails repeatedly, rollback to previous stable version and debug.
- **Buffer Times**: Always allow 1-3 hours between production completion and scheduled publish time for platform processing.

### Key Implementation Needs

**Priority 1 (Blocks 12-test framework)**:
1. Implement HeyGen MCP server for API integration
2. Add Gate 6 (Final MP4 Delivery + metadata packaging)
3. Integrate Upload-Post API with QA gates

**Priority 2 (Quality improvements)**:
1. Add Gate 2A (Pronunciation iteration loop)
2. Update Claude to auto-inject phonetics from streamers.json
3. Implement Gate 5 (Gemini final video review)

**Priority 3 (Nice to have)**:
1. Automate Gate 3 platform validation
2. Enhance Gate 7 logic audit (currently 20 checks, expand to 30+)
