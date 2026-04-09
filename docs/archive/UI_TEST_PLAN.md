# CWN Production Dashboard - UI Test Plan

**Test Date**: 2026-04-07
**Test Environment**: localhost:8765/cwn_production.html
**Server**: localhost:3000
**Status**: Ready for Railway deployment testing

---

## Navigation & Sidebar (Core)

### Sidebar Buttons
- [ ] **Generate Videos** - Switches to main generation view
- [ ] **Job Queue** - Shows active/completed jobs with status polling
- [ ] **Content Calendar** - Calendar view (if implemented)

### Content Type Sections
- [ ] **NBA Compilation** - NBA game selection and script generation
- [ ] **News Compilation** - News story fetching and video generation
- [ ] **Twitch Compilation** - Twitch clip compilation
- [ ] **Shorts / Reels** - Short-form content (NBA/News/Twitch)

### Publishing & Tools
- [ ] **Publish Prep** - Multi-platform copy generation (YT/TT/IG/Twitch)
- [ ] **Thumbnails** - A/B test thumbnail generation
- [ ] **Settings** - HeyGen config, Twitch streamers, FFmpeg, scheduling

---

## 1. Generate Videos Section

### NBA Compilation
**Elements**:
- Format dropdown (landscape/portrait)
- Hidden game IDs input
- "SELECT GAMES" button → navigates to NBA config
- "GENERATE SCRIPT" button (hidden until games selected)

**Test**:
1. Click "SELECT GAMES" → should navigate to NBA section
2. Select games → "GENERATE SCRIPT" should appear
3. Click "GENERATE SCRIPT" → should call `/generate-full-script`
4. Verify job appears in queue

**Dependencies**: Requires NBA games data

---

### News Compilation
**Elements**:
- Source dropdown (Al Jazeera, BBC, NPR, etc.)
- Story count dropdown (1-5)
- Format dropdown (landscape/portrait)
- "GENERATE NEWS VIDEO" button
- "CONFIGURE" button → navigates to News config

**Test**:
1. Select source, count, format
2. Click "GENERATE NEWS VIDEO"
3. Verify API call to `/generate-full-script` with `type=news`
4. Check job queue for progress

**Expected Behavior**: Should generate script → Gate 1 QA → HeyGen → assembly

---

### Twitch Compilation
**Elements**:
- Format dropdown
- Clips per streamer dropdown (1-3 clips)
- "GENERATE TWITCH VIDEO" button
- "CONFIGURE" button

**Test**:
1. Select format and clips per streamer
2. Click "GENERATE TWITCH VIDEO"
3. Verify job creation
4. Check for proper clip fetching

---

### Script Review Panel
**Elements**:
- Script display area (shows generated script)
- Gate 1 QA results
- "REGENERATE" button
- "SEND TO HEYGEN" button

**Test**:
1. After script generation, verify script appears
2. Check Gate 1 score display
3. Test "REGENERATE" → should retry with Gate 1 coaching feedback
4. Test "SEND TO HEYGEN" → manual HeyGen submission

**Critical**: This is where Gate 1 enhancements should be visible

---

## 2. Job Queue

### Queue Management
**Elements**:
- "REFRESH STATUS" button
- "CLEAR COMPLETED" button
- "CLEAR ALL JOBS" button
- "SHOW ERROR LOG" button

**Test**:
1. **Refresh** → Poll `/full-script-status/:id` for active jobs
2. **Clear Completed** → Remove jobs with status='completed'
3. **Clear All** → Remove all jobs from display
4. **Error Log** → Toggle error log visibility

**Expected Data**:
- Job ID
- Type (twitch/nba/news)
- Status (pending/in_progress/completed/failed)
- Gate 1 score
- Gate 2 score
- HeyGen video IDs
- Assembly progress
- Output file path

**Critical Tests**:
- Verify Gate 1/2 scores appear
- Check retry attempt counters
- Confirm Topaz enhancement flags appear (if triggered)

---

## 3. NBA Configuration

### Game Selection
**Elements**:
- "FETCH YESTERDAY'S GAMES" button
- Date picker input
- "FETCH THIS DATE" button
- Game checkbox list
- "SELECT ALL" / "DESELECT ALL" buttons
- "USE SELECTED GAMES → GENERATE SCRIPT" button

**Test**:
1. Click "FETCH YESTERDAY'S GAMES"
   - Verify API call to NBA endpoint
   - Check game list populates
2. Pick custom date → "FETCH THIS DATE"
   - Verify date-specific games load
3. Select/deselect games
   - Test "SELECT ALL"
   - Test "DESELECT ALL"
4. Click "USE SELECTED" → should return to Generate with games pre-filled

**Expected**: Game IDs stored, script generation triggered with selected games

---

## 4. News Configuration

### Story Selection
**Elements**:
- Source checkboxes (Al Jazeera, BBC, NPR)
- Shorts keywords input
- "FETCH TODAY'S STORIES" button

**Test**:
1. Select sources
2. Enter keywords
3. Click "FETCH STORIES"
4. Verify stories populate for selection

---

## 5. Twitch Configuration

### Streamer & Clip Settings
**Elements**:
- Title filter dropdown
- "FETCH TOP CLIPS NOW" button

**Test**:
1. Select title filter
2. Click "FETCH TOP CLIPS"
3. Verify clips load from Twitch API
4. Check clip metadata (view count, created_at, etc.)

---

## 6. Shorts / Reels

### Short-Form Generation
**Elements**:
- NBA Short: "GENERATE NBA SHORT" button + status indicator
- News Short: "GENERATE NEWS SHORT" button + status indicator
- Twitch Short: "GENERATE TWITCH SHORT" button + status indicator

**Test**:
1. Click each "GENERATE" button
2. Verify status changes: READY → GENERATING → COMPLETE
3. Check output format (portrait 9:16)
4. Verify 45-60 second duration

**Expected**: Uses short-form avatar (ed57439c9c3d4a398f3b247b75714b13)

---

## 7. Publish Prep

### Multi-Platform Copy Generation
**Elements**:
- Job selector dropdown
- Game ID input (hidden)
- Headline input
- "GENERATE ALL COPY" button

**Test**:
1. Select job from dropdown
2. (Optional) Enter custom headline
3. Click "GENERATE ALL COPY"
4. Verify API call to `/generate-publish-copy`
5. Check all platforms populate:
   - YouTube (title, description, comment, chapters)
   - TikTok (caption)
   - Instagram (caption, alt text)
   - Twitch/Kick (title)

---

### Platform Tabs
**Elements**:
- YouTube tab
- TikTok tab
- Instagram tab
- Twitch/Kick tab

**Test Each Platform**:

#### YouTube
- [ ] Title output + COPY button
- [ ] Description output (collapsible) + COPY button
- [ ] Pinned comment + COPY button
- [ ] Chapters (if applicable) + COPY button
- [ ] Caption settings:
  - [ ] Auto-caption checkbox
  - [ ] Burned-in captions checkbox
- [ ] Schedule datetime input
- [ ] "UPLOAD TO YOUTUBE" button
- [ ] "PUBLISH ALL PLATFORMS" button
- [ ] "ADD TO QUEUE" button
- [ ] "CHECK STATUS" button

#### TikTok
- [ ] Caption output + COPY button
- [ ] Auto-caption checkbox
- [ ] Sound settings
- [ ] Privacy settings
- [ ] Schedule datetime
- [ ] "UPLOAD TO TIKTOK" button

#### Instagram
- [ ] Caption output + COPY button
- [ ] Alt text + COPY button
- [ ] Cover image settings
- [ ] Caption sticker checkbox
- [ ] "UPLOAD TO INSTAGRAM" button

#### Twitch/Kick
- [ ] Title output + COPY button
- [ ] Category settings (if applicable)

---

### Copy Functionality Test
**For each COPY button**:
1. Click button
2. Verify clipboard contains correct text
3. Check button feedback (should show "COPIED!" temporarily)

---

## 8. Thumbnails (A/B Testing)

### Thumbnail Generation
**Elements**:
- Job selector dropdown
- Template tabs: NBA HIGHLIGHT, NEWS, TWITCH
- Hook line input ("BEST TWITCH CLIPS")
- Date override input
- "GENERATE THUMBNAIL" button

**Test**:
1. Select job
2. Enter hook line
3. (Optional) Override date
4. Click "GENERATE THUMBNAIL"
5. Verify thumbnail preview appears
6. Check file saved to output directory

**Expected**: Generates CWN-branded thumbnail with game/story/clip visual

---

## 9. Settings

### HeyGen Configuration
**Elements**:
- API Key input (password field)
- Avatar ID - Compilations
- Avatar ID - Shorts/Reels
- Voice ID
- Speaking Speed (0.5-1.5)
- Default BG Color (color picker)

**Test**:
1. Verify default values populated
2. Change avatar ID → save → reload page → verify persistence
3. Test speaking speed slider (0.5 to 1.5)
4. Test color picker

**Critical Values**:
- Compilation Avatar: `19c1d4adf8904694a3cc331c5a9bee4b`
- Shorts Avatar: `ed57439c9c3d4a398f3b247b75714b13`
- Voice ID: `2e598f1a6022448cb6710e5d44665325`
- Speaking Speed: `0.85`

---

### Reference Library
**Elements**:
- "SAVE REFERENCE LIBRARY" button
- "TEACH GEMINI (one-time)" button
- Individual streamer teaching buttons:
  - Maya, Jason, Hasan, Adapt, Ron

**Test**:
1. Click "SAVE REFERENCE LIBRARY"
   - Verify saves to `reference_library.json`
2. Click "TEACH GEMINI"
   - Should analyze style library and train Gemini
   - Check `/analyze-style-library` endpoint
3. Click individual streamer buttons
   - Should teach Gemini that streamer's specific language/style

**Expected**: Gemini learns from successful scripts for future QA

---

### Twitch Streamer Management
**Location**: Settings → TWITCH tab

**Test**:
- Verify streamers.json loads
- Check streamer display names
- Verify phonetic spellings (if present)

---

### FFmpeg Server Config
**Location**: Settings → FFMPEG SERVER tab

**Test**:
- Verify FFmpeg path displayed
- Check tmp directory path
- Check output directory path

---

### Schedule Config
**Location**: Settings → SCHEDULE tab

**Test**:
- Verify publishing schedule display (if implemented)
- Check timezone settings

---

## API Endpoint Tests

### Critical Endpoints
Run these curl commands to verify API functionality:

```bash
# 1. Health check
curl http://localhost:3000/

# 2. Generate script (basic test)
curl -X POST http://localhost:3000/generate-full-script \
  -H "Content-Type: application/json" \
  -d '{"type":"twitch","streamers":["kai_cenat","speed"],"format":"landscape"}'

# 3. Check script status
curl http://localhost:3000/full-script-status/twitch_20260407_001

# 4. Generate publish copy
curl -X POST http://localhost:3000/generate-publish-copy \
  -H "Content-Type: application/json" \
  -d '{"jobType":"twitch","platforms":["youtube","tiktok"]}'

# 5. Analyze style library
curl -X POST http://localhost:3000/analyze-style-library \
  -H "Content-Type: application/json" \
  -d @reference_library.json
```

---

## Integration Tests

### End-to-End Workflow: Twitch Compilation

1. **Generate Script**
   - Navigate to Generate Videos
   - Select Twitch
   - Configure format + clips per streamer
   - Click "GENERATE TWITCH VIDEO"

2. **Monitor Gate 1**
   - Wait for script generation
   - Verify Gate 1 QA runs automatically
   - Check score (should be ≥85 to pass)
   - If fail, verify retry with enhanced coaching feedback

3. **HeyGen Submission**
   - After Gate 1 pass, verify auto-send to HeyGen
   - Check script metadata stored (`sceneTextMap`, `fullScript`)
   - Monitor HeyGen job status

4. **Monitor Gate 2**
   - Wait for HeyGen segments to complete
   - Verify Gate 2 segment QA runs
   - If fail, check Topaz enhancement triggers
   - Verify retry logic (max 3 attempts)

5. **Assembly**
   - After Gate 2 pass, verify FFmpeg assembly starts
   - Check crossfade transitions
   - Verify intro/outro added

6. **Gate 3 (Future)**
   - Final video QA
   - Output validation

7. **Output**
   - Check `output/` directory for final MP4
   - Verify file size reasonable
   - Test playback

---

## Railway Deployment Checklist

### Environment Variables
- [ ] `ANTHROPIC_API_KEY` set
- [ ] `GEMINI_API_KEY` set
- [ ] `HEYGEN_API_KEY` set
- [ ] `TWITCH_CLIENT_ID` set
- [ ] `TWITCH_TOKEN` set
- [ ] `PORT` set (default 3000)
- [ ] `DASHBOARD_PORT` set (default 8765)

### File Paths
- [ ] `tmp/` directory writable
- [ ] `output/` directory writable
- [ ] `output/qa_failures/` exists
- [ ] Font file accessible at `tmp/cwn_font.ttf`

### External Dependencies
- [ ] FFmpeg available in PATH
- [ ] Internet access for:
  - Anthropic API
  - Gemini API
  - HeyGen API
  - Twitch API
  - NBA data source
  - News RSS feeds

---

## Known Issues & Edge Cases

### Gate 1 Retries
- **Issue**: If Claude fails 3 times, job stops
- **Test**: Verify enhanced coaching feedback improves retry success
- **Monitor**: Gate 1 retry attempt counter

### Gate 2 Topaz Enhancement
- **Issue**: Topaz API has 500MB file size limit
- **Test**: Verify segments >500MB skip Topaz
- **Monitor**: Topaz skip reason logs

### HeyGen Re-rendering
- **Status**: Infrastructure in place, logic not fully implemented
- **Test**: Verify script metadata available in assembly route
- **Monitor**: `heygenReRenderAvailable` flag in job metadata

### Beat/Pause Pacing
- **Recent Fix**: Added `[beat]` after "Follow [name]. Link in description."
- **Test**: Verify Bobby G doesn't rush between streamer sections
- **Monitor**: Listen to HeyGen output for proper pacing

---

## Success Criteria

### Must Pass Before Railway Deployment

1. **Script Generation**: All 3 content types generate successfully
2. **Gate 1 QA**: Runs automatically, shows score, retries work
3. **HeyGen**: Successfully submits and retrieves videos
4. **Gate 2 QA**: Runs on segments, shows pass/fail
5. **Assembly**: Creates final video with transitions
6. **Job Queue**: Updates in real-time, shows all metadata
7. **Publish Prep**: Generates copy for all platforms
8. **Settings**: Persist correctly

### Performance Benchmarks

- Script generation: < 30 seconds
- Gate 1 QA: < 15 seconds
- HeyGen total (5 scenes): < 30 minutes
- Gate 2 QA: < 2 minutes per segment
- FFmpeg assembly: < 5 minutes for 5min video

---

## Test Results Log

**Tester**: ___________
**Date**: ___________

| Feature | Status | Notes |
|---------|--------|-------|
| NBA Generation | ⬜ Pass ⬜ Fail | |
| News Generation | ⬜ Pass ⬜ Fail | |
| Twitch Generation | ⬜ Pass ⬜ Fail | |
| Gate 1 Auto-Retry | ⬜ Pass ⬜ Fail | |
| Gate 2 Topaz Enhancement | ⬜ Pass ⬜ Fail | |
| Script Metadata Storage | ⬜ Pass ⬜ Fail | |
| Job Queue Polling | ⬜ Pass ⬜ Fail | |
| Publish Prep (YT) | ⬜ Pass ⬜ Fail | |
| Publish Prep (TT) | ⬜ Pass ⬜ Fail | |
| Publish Prep (IG) | ⬜ Pass ⬜ Fail | |
| Thumbnail Generation | ⬜ Pass ⬜ Fail | |
| Settings Persistence | ⬜ Pass ⬜ Fail | |

---

**Notes**: This test plan covers all interactive elements identified in the dashboard HTML. Focus testing on the new Gate enhancements (1, 2, script storage) before Railway deployment.
