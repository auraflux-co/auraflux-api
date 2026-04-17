# CWN Pipeline Recovery Playbook

**Author:** Claude Code  
**Date:** 2026-04-17  
**Status:** 🟢 AUTHORITATIVE — all pipeline recovery is done via code, API calls, or `data/jobs.json` edits. The dashboard is never the source of truth.  
**Commit:** `afdb7c8` — graceful shutdown + startup resume  
**Related:** `ROLLBACK_FORCE_ADVANCE_SPEC.md` (manual escape hatches), `GATED_PIPELINE_ARCHITECTURE.md` (gate design), `ROLLBACK_FORCE_ADVANCE_SPEC.md` (stage machine)

---

## Core Principle

**Rob never drives recovery from the dashboard.** Every stuck or failed pipeline state has a code-level resolution path. The dashboard buttons (RESTORE JOBS, ROLLBACK, FORCE ADVANCE) exist as a visual readout — they are not the mechanism. The mechanism is always `server.js` + `data/jobs.json` + the API.

---

## Stage Machine

```
script_ready → all_sent → assembling → assembled → published
```

Every job card in `data/jobs.json` has a `stage` field. If missing (legacy cards), `inferJobStage()` derives it from card fields (`server.js`).

---

## Automatic Recovery (No Human Action Required)

### Server Restart Kills Active HeyGen Pollers

**Symptom:** nodemon restarted (file change, `rs` command, crash). HeyGen segments are rendering but the poller died. Dashboard shows nothing or stale state.

**Automatic fix (shipped `afdb7c8`):**

On every server boot, `setImmediate()` runs the startup resume scan:
1. Reads all jobs from `persistedJobs` (loaded from `data/jobs.json` at startup)
2. Finds any job with `stage = 'all_sent'` that isn't dismissed
3. If all HeyGen segments are already `completed` in the card → emits `heygen:all_complete` directly (2s delay, bus listener picks up Gate 2 → assembly)
4. If segments are still pending in the card → restarts the HeyGen poller; poller polls HeyGen API, discovers completed segments, emits `heygen:all_complete`

**No human action needed.** Just restart the server — both paths resolve automatically within 30–60 seconds.

**Log lines to confirm it worked:**
```
[jobs] Loaded 3 persisted jobs from disk
[startup-resume:script_twitch_xxx] Resuming HeyGen poller (32 segments)
[startup-resume:script_news_xxx] All segments already completed — emitting heygen:all_complete
[startup-resume] Resumed 2 in-flight job(s)
[heygen-poller:script_twitch_xxx] Poll 1: 32/32 completed, 0 pending, 0 failed
[heygen-poller:script_twitch_xxx] 📡 heygen:all_complete emitted
```

---

### nodemon Kills Poller Mid-Cycle

**Symptom:** A `lib/` or `server.js` file was saved/committed while a poller was between polls. nodemon sent SIGTERM. The in-progress HTTP requests were abandoned mid-flight.

**Automatic fix (shipped `afdb7c8`):**

`gracefulShutdown()` intercepts SIGTERM/SIGINT and waits up to 35 seconds for all active pollers (tracked in `activePollers` Map) to finish their current poll iteration before `process.exit(0)`. The job card is written to disk before exit. On the next boot, startup resume picks up the job as described above.

`nodemon.json` is configured with `"signal": "SIGTERM"` and `"killSignal": "SIGTERM"` so nodemon always uses the graceful path, never SIGKILL.

**What gets saved before shutdown:**
- Current segment statuses (which segments completed before the restart)
- The `stage: 'all_sent'` field on the card

**What gets re-resolved on next boot:**
- Any segments that completed in HeyGen during the downtime (startup resume polls their IDs)
- `heygen:all_complete` event and everything downstream (Gate 2, assembly, Gate 3, Drive upload)

---

### Legacy Jobs with No `stage` Field

**Symptom:** `/jobs` returns `count: 0` even though `data/jobs.json` has active jobs. This happens with jobs created before `afdb7c8`.

**Automatic fix (shipped `afdb7c8`):**

`inferJobStage(job)` derives stage from card fields:
```javascript
if (job.finalUrl || job.assembly?.url)          → 'assembled'
if (videoJobs.some(vj => vj.video_id))          → 'all_sent'
if (job.script)                                  → 'script_ready'
```

`/jobs` filter calls `inferJobStage()` when `card.stage` is missing. Startup resume also uses it to find jobs to re-poll.

**One-time patch for existing jobs** (already applied 2026-04-17):
```bash
python3 -c "
import json
with open('data/jobs.json') as f: jobs = json.load(f)
for jid, job in jobs.items():
    if not job.get('stage'):
        vj = job.get('heygen', {}).get('videoJobs', [])
        job['stage'] = 'all_sent' if vj else ('script_ready' if job.get('script') else '')
with open('data/jobs.json', 'w') as f: json.dump(jobs, f, indent=2)
"
```

---

## Manual Recovery via API (No Dashboard Required)

Use these `curl` commands when a job needs intervention. All commands hit the server API directly — the dashboard is not involved.

### Inspect a Stuck Job

```bash
# See all in-flight jobs
curl -s http://localhost:3000/jobs | python3 -m json.tool

# See a specific job card
python3 -c "
import json
with open('data/jobs.json') as f: jobs = json.load(f)
job = jobs.get('YOUR_JOB_ID', {})
print('stage:', job.get('stage'))
print('heygen segments:', len(job.get('heygen', {}).get('videoJobs', [])))
vj = job.get('heygen', {}).get('videoJobs', [])
done = sum(1 for v in vj if v.get('status') == 'completed' and v.get('video_url'))
print('completed segments:', done)
"
```

### Check HeyGen Segment Status Directly

```bash
HEYGEN_API_KEY=$(grep HEYGEN_API_KEY .env | cut -d= -f2 | tr -d ' \r')
VIDEO_ID=your_video_id_here
curl -s "https://api.heygen.com/v1/video_status.get?video_id=$VIDEO_ID" \
  -H "X-Api-Key: $HEYGEN_API_KEY" | python3 -m json.tool
```

### Rollback a Job One Stage

```bash
# Roll back assembled → all_sent (re-assemble)
curl -X POST http://localhost:3000/job/YOUR_JOB_ID/rollback

# Roll back all_sent → script_ready (re-send to HeyGen)
curl -X POST http://localhost:3000/job/YOUR_JOB_ID/rollback

# Roll back published → assembled (re-approve/re-publish)
curl -X POST http://localhost:3000/job/YOUR_JOB_ID/rollback
```

Response shows `before` and `after` stages and what was cleared.

### Force-Advance Past a Stuck Gate

```bash
# Force-pass whatever gate the job is currently stuck at
curl -X POST http://localhost:3000/job/YOUR_JOB_ID/advance
```

**When to use:** Gate is hung (HeyGen timeout, Gemini unavailable, Assembly error on non-critical job) and you want to proceed anyway. The next stage will still fail loudly if the underlying data isn't ready — this only unlocks the action, it does not fabricate results.

### Manually Trigger Assembly After HeyGen Complete

If startup resume didn't fire (e.g., job was in an unknown state), trigger assembly directly:

```bash
# 1. Get segment URLs from HeyGen for all video IDs in the job
python3 - <<'EOF'
import json, subprocess, os

HEYGEN_API_KEY = open('.env').read()
HEYGEN_API_KEY = [l.split('=',1)[1].strip() for l in HEYGEN_API_KEY.split('\n') if l.startswith('HEYGEN_API_KEY=')][0]

with open('data/jobs.json') as f:
    jobs = json.load(f)

job_id = 'YOUR_JOB_ID'
job = jobs[job_id]
vj = job.get('heygen', {}).get('videoJobs', [])

import urllib.request, json as _json
for seg in vj:
    vid = seg.get('video_id')
    if not vid: continue
    req = urllib.request.Request(
        f'https://api.heygen.com/v1/video_status.get?video_id={vid}',
        headers={'X-Api-Key': HEYGEN_API_KEY}
    )
    data = _json.loads(urllib.request.urlopen(req).read())['data']
    seg['status'] = data.get('status')
    seg['video_url'] = data.get('video_url')
    print(f"{seg['sceneName']}: {seg['status']}")

with open('data/jobs.json', 'w') as f:
    _json.dump(jobs, f, indent=2)
print('Updated jobs.json — restart server to trigger startup resume')
EOF
```

Then restart the server. Startup resume will find all segments completed and emit `heygen:all_complete`.

### Dismiss a Dead Job

```bash
curl -X POST http://localhost:3000/job/YOUR_JOB_ID/dismiss
# or DELETE to fully remove:
curl -X DELETE http://localhost:3000/job/YOUR_JOB_ID
```

---

## Recovery by Failure Mode

| Failure | Stage | Automatic? | Resolution |
|---|---|---|---|
| Server restarted, poller died, segments still rendering | `all_sent` | ✅ Yes | Restart server → startup resume re-polls HeyGen |
| Server restarted, poller died, segments already done in HeyGen | `all_sent` | ✅ Yes | Restart server → startup resume emits `heygen:all_complete` directly |
| Legacy job has no `stage` field, not showing in `/jobs` | any | ✅ Yes | `inferJobStage()` derives stage automatically; patch `data/jobs.json` if needed |
| Gate 2 hard fail (segment quality below threshold) | `gate2_failed` | ❌ No | `POST /job/:id/rollback` → back to `all_sent`, then `POST /job/:id/advance` to skip Gate 2 and re-assemble |
| Assembly error (FFmpeg crash, disk full, network timeout) | `assembling` | ❌ No | Fix root cause (free disk, fix FFmpeg args), then `POST /job/:id/rollback` → `all_sent`, restart poller or trigger assembly manually |
| Gate 3 fail (assembled video below quality threshold) | `assembled` | ❌ No | Review gate log in `output/qa_failures/`, fix issue, `POST /job/:id/rollback` → `all_sent`, re-assemble |
| HeyGen segment failed to render | `all_sent` | ❌ No | Check HeyGen dashboard for error, `POST /job/:id/rollback` → `script_ready`, re-send failed scenes manually or re-generate script |
| HeyGen poller timed out (60min) | `all_sent` | ❌ No | Check HeyGen API for segment status, update `data/jobs.json` directly with completed URLs, restart server |
| Drive upload failed | `assembled` | ❌ No | `POST /job/:id/advance` (Gate 5 force-pass) to unlock publish, or fix Drive token and re-assemble |

---

## Preventing Future Poller Kills

### Use `rs` in nodemon terminal for manual restarts

Instead of `Ctrl+C` + restart, type `rs` in the nodemon terminal. nodemon sends SIGTERM, graceful shutdown waits for pollers to checkpoint, then exits cleanly. Startup resume re-attaches on the next boot.

### Never save `lib/` files during an active HeyGen render

The HeyGen render window is typically 5–10 minutes after Gate 1 passes. If you're editing `lib/` or `server.js` during that window, use `rs` instead of saving a file. Or wait until the job reaches `assembled` before committing.

### `data/jobs.json` is never committed, never wiped

`data/jobs.json` is gitignored. It is the job state on disk. Never `rm data/jobs.json`. Never recreate it from scratch. If it gets corrupted, use `git stash` logic — copy the broken file aside and start from `{}`.

---

## What the Dashboard Buttons Actually Do

For reference — these buttons exist but are never the required path for recovery:

| Button | API call | When actually needed |
|---|---|---|
| ↩ RESTORE JOBS | `GET /jobs` | Visual only — startup resume handles this in code |
| ↩ ROLLBACK | `POST /job/:id/rollback` | Same as `curl` command above |
| ⏭ FORCE ADVANCE | `POST /job/:id/advance` | Same as `curl` command above |
| 🔄 REFRESH IDs | `GET /heygen-status/:id` per segment | Handled by startup resume after restart |
| ⚙ ASSEMBLE | `POST /assemble` | Handled by pipeline bus after `heygen:all_complete` |

The dashboard shows job state. The pipeline drives job state. These are different things.

---

## Files Involved

```
server.js               activePollers Map, registerPoller(), unregisterPoller(),
                        gracefulShutdown(), startHeyGenPoller(), inferJobStage(),
                        startup resume (setImmediate block), /jobs endpoint,
                        pipelineBus heygen:all_complete listener
data/jobs.json          Runtime job state. Loaded at startup. Never committed.
nodemon.json            signal + killSignal = SIGTERM (graceful path)
lib/script_gen.js       jobCard.stage = 'all_sent' set at first persist
```
