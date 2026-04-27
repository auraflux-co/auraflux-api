# Render Smoke Test Plan

**Trigger:** After first successful Render deploy — `api.auraflux.co` shows green in Render dashboard.  
**Owner:** Cursor monitors; Rob confirms pass/fail.  
**Time estimate:** 10 minutes.

---

## Step 1 — Health check

```bash
curl https://api.auraflux.co/health
```

**Expected:**
```json
{ "status": "ok", "version": "...", "gitHash": "..." }
```

**Pass bar:** HTTP 200, `status: "ok"`.

---

## Step 2 — Env var confirmation

```bash
curl https://api.auraflux.co/health | python3 -m json.tool
```

Confirm `version` matches the latest commit hash (confirms the right build deployed).

Then verify key env vars are set (no values revealed, just presence check):

```bash
curl https://api.auraflux.co/debug/env-check
```

Expected: all required keys show `set: true` (endpoint added in server.js during deploy). If endpoint not yet added, verify manually in Render dashboard Environment panel.

---

## Step 3 — Disk usage check

```bash
curl https://api.auraflux.co/disk-usage
```

**Expected:** `freeGB` > 5 (10GB persistent disk with room to work).

---

## Step 4 — Gate 1 synthetic (no HeyGen spend)

```bash
curl -X POST https://api.auraflux.co/generate-full-script \
  -H "Content-Type: application/json" \
  -d '{"contentType":"news","isShort":false,"GATE_TEST_MODE":true}'
```

**Expected:** HTTP 200, `scriptJobId` returned, Gate 1 fires without errors.  
**Purpose:** Confirms Anthropic + Gemini API keys are wired and Gate 1 runs on Render.

---

## Step 5 — SQLite persistence check

After completing Step 4, confirm the job persisted to disk:

```bash
curl https://api.auraflux.co/jobs
```

**Expected:** The job from Step 4 appears in the list.  
**Purpose:** Confirms persistent disk mount at `/app/data` is working.

---

## Pass / Fail criteria

| Check | Pass | Fail |
|-------|------|------|
| `/health` | HTTP 200, `ok` | Any other status |
| `/disk-usage` | freeGB > 5 | freeGB < 1 |
| Gate 1 synthetic | 200 + jobId | 5xx or API key error |
| Job persistence | Job appears in `/jobs` | Empty list or 5xx |

---

## Failure paths

| Failure | Likely cause | Fix |
|---------|-------------|-----|
| `/health` returns 503 | Server not started or port mismatch | Check Render logs; confirm `PORT=10000` env var |
| API key error | Secret not set in Render env panel | Add missing key in Render Dashboard → Environment |
| `/disk-usage` 5xx | Persistent disk not mounted | Verify disk config in Render Dashboard → Disks |
| Gate 1 synthetic fails | Gemini/Anthropic quota or key mismatch | Check Render logs for specific API error |
