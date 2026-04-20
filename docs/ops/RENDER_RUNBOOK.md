# CWN Production Render Runbook

**Version:** 1.0 — 2026-04-17
**Author:** Aider (overnight docs)
**Purpose:** Step-by-step guide for executing a production render for any CWN content type.
**Audience:** Rob (primary operator), future operators.

---

## 1. Pre-Render Checklist

Complete every item before starting a render. A missed step will cost HeyGen credits.

### Servers

- [ ] **Node API server running on port 3000**
  ```bash
  cd ~/cwn-production && nodemon server.js 2>&1 | tee -a logs/server.log
  ```
  Verify: `curl http://localhost:3000/health` → `{ "status": "ok" }`

- [ ] **Static file server running on port 8765** (dashboard)
  ```bash
  cd ~/cwn-production && python3 -m http.server 8765
  ```
  Verify: open `http://localhost:8765/cwn_production.html`

- [ ] **VectCut API running on port 9001** (NBA and News only — optional for Twitch)
  ```bash
  cd ~/cwn-production/VectCutAPI && ./venv-capcut/bin/python3 capcut_server.py
  ```
  Verify: `curl http://localhost:3000/capcut/health` → `{ "ok": true, "capcut": "online" }`

### Environment

- [ ] **`.env` has all required keys** — check each one is set:
  - `ANTHROPIC_API_KEY` — Claude QA
  - `GEMINI_API_KEY` — Script gen + all QA gates
  - `HEYGEN_API_KEY` — Avatar rendering (HeyGen credits charged per segment)
  - `DRIVE_FOLDER_ID` — Google Drive upload destination
  - `UPLOADPOST_API_KEY` — Multi-platform publish (YouTube / TikTok / Instagram)

  Quick check:
  ```bash
  grep -E "ANTHROPIC_API_KEY|GEMINI_API_KEY|HEYGEN_API_KEY|DRIVE_FOLDER_ID|UPLOADPOST_API_KEY" .env | grep -v "^#"
  ```
  All 5 lines must appear with non-empty values.

- [ ] **`GATE_TEST_MODE` is NOT set to `true`** — if it is, the pipeline stops after Gate 1 and HeyGen will never fire.
  ```bash
  grep GATE_TEST_MODE .env
  ```
  Must return empty or `GATE_TEST_MODE=false`.

### Disk Space

- [ ] **At least 10 GB free** before starting assembly:
  ```bash
  curl http://localhost:3000/disk-usage
  ```
  Response: `{ "freeGB": X.X, ... }` — need `freeGB >= 10`.

  If low, clean up old renders:
  ```bash
  curl -X POST http://localhost:3000/cleanup \
    -H "Content-Type: application/json" \
    -d '{"keepCount":2,"cleanTmp":true,"cleanQaLogs":false}'
  ```

### Synth Test — Run First (No HeyGen Credits Spent)

- [ ] **Synth test passes for the target content type before spending credits:**
  ```bash
  node test/synth_assembly_test.js news    # for a news render
  node test/synth_assembly_test.js twitch  # for a twitch render
  node test/synth_assembly_test.js nba     # for an NBA render
  node test/synth_assembly_test.js short   # for a short-form render
  ```
  Script exits 0 = PASS. Script exits non-zero = fix the chrome/set-design issue first.

  **Do not proceed to a real render if the synth test fails.** The chrome overlay that failed in synth will fail in the real render too — you will waste HeyGen credits.

---

## 2. Gate Sequence — What Fires and When

| Gate | Trigger | What It Checks | Pass Threshold | On Fail |
|------|---------|----------------|----------------|---------|
| **Gate 0** | `/generate-full-script` called | Scraper finds clips (AJ/ESPN/Twitch CDN) | ≥1 clip per story/game/streamer | Hard fail — fix scraper or try different topic |
| **Gate 1** | Script generated | Claude QA: placeholders, name errors, scene count, structure | ≥90 auto-proceed; 70-89 manual review; <70 hard fail | Rob reviews script; uses Force Advance if acceptable |
| **Gate 2** | All HeyGen segments completed | Gemini samples 3 segments: lip sync, audio, rendering quality | ≥85 auto-proceed; 65-84 manual review; <65 hard fail | Check HeyGen dashboard for failed renders; retry segments |
| **Gate 3** | Assembly complete | Gemini watches full video: pacing, freeze, transitions, clips present | ≥70 auto-proceed; 60-69 hold for Rob; <60 hard fail | Use Rollback to re-assemble; max 3 auto-retries |
| **Gate 4** | Drive upload complete | Upload-Post `job_id` returned | `job_id` present = pass | Check Upload-Post dashboard; retry publish |

### Automatic vs Manual Actions Per Gate Score

| Gate | Score | Pipeline Action |
|------|-------|----------------|
| Gate 1 | ≥90 | Auto-proceeds to HeyGen render — no action needed |
| Gate 1 | 70-89 | Manual review required — read script, click Force Advance if acceptable |
| Gate 1 | <70 | Hard fail — pipeline stops; review QA report; fix issues; retry |
| Gate 2 | ≥85 | Auto-proceeds to Assembly |
| Gate 2 | 65-84 | Manual review — check segment quality, click Force Advance if acceptable |
| Gate 2 | <65 | Hard fail — check HeyGen dashboard for rendering errors; retry failed segments |
| Gate 3 | ≥70 | Auto-uploads to Drive and publishes |
| Gate 3 | 60-69 | Rob reviews assembled video, clicks Force Advance if "ship it" |
| Gate 3 | <60 | Hard fail — rollback to re-assemble; check `output/qa_failures/` for report |

---

## 3. Per-Content-Type Render Notes

### News

- **Clips:** Al Jazeera portrait clips (9:16). Expect 4-6 stories per episode.
- **Script gen timing:** ~90 seconds (Gemini video analysis of AJ clips).
- **HeyGen render timing:** ~8-10 minutes (35-45 segments typical).
- **Assembly timing:** ~4 minutes.
- **Common issues:**
  - AJ scraper occasionally returns landscape clips — Gate 0 will flag this. Re-run scraper.
  - Story-to-clip matching may miss on unusual topics — check Gate 1 QA report for `STORY_NOT_MATCHED` warnings.
- **Chrome skin:** News red (`--red` CSS var), "WORLD NEWS" category label, no override needed.

### Twitch

- **Clips:** Twitch CDN URLs — **EXPIRE IN ~1 HOUR.** Start the render within 1 hour of script approval. If you walk away and come back after an hour, re-resolve the clip URLs before assembly.
- **Script gen timing:** ~120 seconds (Gemini analyzes each clip).
- **HeyGen render timing:** ~10-14 minutes (55-72 segments for 8-12 streamers).
- **Assembly timing:** ~5 minutes.
- **Common issues:**
  - Maya/Emily clips expire fastest — use early download cache (`tmp/early_clips/`). The pipeline handles this automatically.
  - CDN URL expiry during long HeyGen render: assembly will auto-re-resolve URLs at assembly time.
- **Chrome skin:** Purple (`#6441A5`), show name "Twitch Soup".

### NBA

- **Clips:** ESPN Game Highlights reels (typically 40-115 seconds each). 3-5 games per episode.
- **Script style:** Bobby G narrates LIVE OVER the clip (not setup/reaction). He is talking while the clip plays.
- **Script gen timing:** ~90 seconds.
- **HeyGen render timing:** ~6-8 minutes.
- **Assembly timing:** ~4 minutes.
- **Common issues:**
  - ESPN sometimes shows press-conference clips instead of game highlights — Gate 0 tries to filter these but may miss. Check the clip URLs in the script before proceeding.
  - Game Highlights reels may have ESPN pre-roll ads (~15 seconds). Assembly trims these via `CONFIG.NBA.AD_TRIM_SECONDS`.
- **Chrome skin:** Blue (`#17408B`), show name "Other Side of the Pillow".

### Shorts (Any Content Type)

- **Format:** 9:16 portrait (1080x1920), single clip + INTRO/OUTRO only.
- **Layout:** Split-screen — avatar (Bobby G) on top half, source clip on bottom half.
- **Script gen timing:** ~45 seconds.
- **HeyGen render timing:** ~3 minutes (typically 4-6 segments).
- **Assembly timing:** ~1 minute.
- **Common issues:**
  - Short-form buttons on dashboard must be used — do not use the long-form generate buttons.
  - Caption text must be present in the script (`CAPTION:` marker) for it to burn into the video.
- **Logo:** 80px CWN logo, bottom-right of avatar zone.

---

## 4. Recovery Procedures

### Server Crashed Mid-Render

1. Restart the Node server: `nodemon server.js 2>&1 | tee -a logs/server.log`
2. Open dashboard: `http://localhost:8765/cwn_production.html`
3. Click **↩ RESTORE JOBS** in the queue header
4. Jobs appear with segments in `rendering` state
5. Click **🔄 REFRESH IDs** on the job card to re-check HeyGen segment status
6. If segments show as completed: **⚙ ASSEMBLE** button appears — click to continue

### HeyGen Segment Stuck (Not Completing After 15+ Minutes)

1. Click **🔄 REFRESH IDs** — waits for HeyGen API response
2. If still stuck after 5 minutes: check the HeyGen dashboard for errors on that video ID
3. If segment is genuinely failed in HeyGen: use **⏭ FORCE ADVANCE** on Gate 2 to skip the failed segment and proceed to assembly
4. Note: Force Advance at Gate 2 means that segment will be missing from the final video — check the assembled output carefully

### Assembly Failed Gate 3 (Score <60)

1. Check `output/qa_failures/gate3_fail_*.txt` for the specific failure report
2. Common causes: freeze frame detected, missing clips, audio dropout in a segment
3. If pacing/freeze issue: click **↩ ROLLBACK** → fix the underlying issue → click **⚙ ASSEMBLE** to re-assemble
4. If score is 60-69 (borderline): Rob reviews the assembled video manually → click **⏭ FORCE ADVANCE** if "ship it"
5. Maximum 3 auto-retries — after that, use manual rollback + re-assemble

### Drive Upload Failed (Gate 4)

1. Check `logs/errors.jsonl` for upload error details
2. Verify `DRIVE_FOLDER_ID` is correct in `.env`
3. Re-run Google Drive auth if token expired: `node cwn-auth.js`
4. Use **⏭ FORCE ADVANCE** on Gate 4 → re-trigger publish manually from dashboard
5. If Upload-Post is down: check `https://upload-post.com` status page; retry after recovery

### Wrong Script / Bad Script Approved Through Gate 1

1. Click **↩ ROLLBACK** on the job card to step back to `script_ready` stage
2. This clears the video_id assignments on segments
3. Re-generate script or edit manually
4. Re-submit to HeyGen

---

## 5. Expected Timings (End-to-End)

| Content Type | Script Gen | HeyGen Render | Assembly | **Total** |
|---|---|---|---|---|
| News (5 stories) | ~90s | ~10 min | ~4 min | **~16 min** |
| Twitch (10 streamers) | ~120s | ~14 min | ~5 min | **~21 min** |
| NBA (4 games) | ~90s | ~8 min | ~4 min | **~14 min** |
| Short (any) | ~45s | ~3 min | ~1 min | **~5 min** |

These timings assume all gates auto-pass. Manual review at Gate 1 or Gate 3 adds however long Rob takes to review.

HeyGen render time scales roughly linearly with segment count:
- Twitch long-form: 55-72 segments × ~12 seconds/segment = 11-14 minutes
- News long-form: 35-45 segments × ~12 seconds/segment = 7-9 minutes
- NBA long-form: 30-40 segments × ~12 seconds/segment = 6-8 minutes

---

## 6. Post-Render Checklist

After Gate 4 passes, verify all artifacts are in place:

- [ ] **Gate 3 score logged:** `output/run_metrics_{jobId}.json` exists and has a `gate3` entry
- [ ] **Video on Google Drive:** check the `DRIVE_FOLDER_ID` folder — file should be there within 2 minutes of Gate 3 pass
- [ ] **Thumbnail generated:** `output/{jobId}_thumb.jpg` or similar — if missing, use `/generate-thumbnail` endpoint
- [ ] **Published to platforms:** check YouTube Studio + TikTok Creator Portal + Instagram for the upload
- [ ] **Episode counter incremented:** `data/episode_counters.json` should show the new count for the content type
- [ ] **Job card shows `published` state** in dashboard
- [ ] **Disk cleanup (optional):** if disk space is below 20 GB, run cleanup:
  ```bash
  curl -X POST http://localhost:3000/cleanup \
    -H "Content-Type: application/json" \
    -d '{"keepCount":2,"cleanTmp":true,"cleanQaLogs":false}'
  ```

---

## 7. Quick Reference — Dashboard Buttons

| Button | Stage | What It Does |
|--------|-------|-------------|
| **⚙ ASSEMBLE** | After all segments completed | Triggers assembly pipeline (Gates 2+3+4) |
| **🔄 REFRESH IDs** | Rendering state | Re-polls HeyGen for segment completion status |
| **↩ ROLLBACK** | Any stage | Steps back one stage; clears current-stage data |
| **⏭ FORCE ADVANCE** | Any stage | Force-passes current gate; unlocks next action |
| **↩ RESTORE JOBS** | On page load / after crash | Re-hydrates job cards from server-side state |
| **× DISMISS** | Any stage | Removes job from queue (does not delete files) |

---

## 8. Gate QA Reports Location

All gate failure logs are written to `output/qa_failures/` and are never uploaded to Drive:

```
output/qa_failures/gate1_fail_{timestamp}.txt       — Script QA failures
output/qa_failures/gate1_pass_{timestamp}.txt       — Script QA passes (for review)
output/qa_failures/gate2_fail_{timestamp}.txt       — HeyGen segment QA failures
output/qa_failures/gate3_fail_{timestamp}.txt       — Assembly QA failures
```

Use these reports to diagnose why a gate failed and what the QA system flagged.

---

## 9. Metrics

Each job produces a metrics file at `output/run_metrics_{jobId}.json` with per-stage wall time:

```json
{
  "jobId": "script_twitch_1744891200000",
  "stages": {
    "scriptGen": { "durationMs": 92000, "gate1Score": 95 },
    "heygenRender": { "durationMs": 840000, "segmentCount": 58 },
    "assembly": { "durationMs": 290000, "gate3Score": 82 },
    "publish": { "durationMs": 15000, "platforms": ["youtube", "tiktok"] }
  },
  "totalDurationMs": 1237000
}
```

Use these to identify bottlenecks. Target: total < 12 minutes (excluding HeyGen wait time).

---

*Runbook created 2026-04-17. Update this doc when the pipeline changes.*
