# CLINE_HANDOFF_THUMBNAIL_WIRE.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-14  
**Size:** S (2 files, ≤10 lines total)  
**Problem:** YouTube thumbnail is never sent to Upload-Post when Gate 3 is `manual_review` and Rob clicks APPROVE & UPLOAD. Auto-publish path (Gate 3 auto-pass) correctly sends the thumbnail, but the manual approval path silently sends `thumbnailUrl: ''`.  
**1 commit, ships both files together.**

---

## Root Cause

`assemblyJobs[asmId].thumbDriveUrl` is set at `server.js:5186` after the thumbnail frame is uploaded to Drive. This is in-memory only — never written to `persistedJobs[assemblyJobId]` (the record that survives server restarts and is read by the dashboard).

The dashboard's `approveAndUpload()` builds the publish payload at `cwn_production.html:5199–5210`. It reads `thumbnailUrl: prep.thumbnailUrl || job.thumbnailUrl || ''`. Neither field is ever set on the job card. Result: every manual approval sends a blank `thumbnailUrl` to Upload-Post.

---

## Fix — Two changes, one commit

### Change 1 — `server.js` (persist thumbDriveUrl to job card)

**Location:** `server.js:5186` — immediately after the `assemblyJobs[asmId].thumbDriveUrl = thumbDriveUrl;` line.

**Current:**
```javascript
                  if (thumbDriveUrl) {
                    assemblyJobs[asmId].thumbDriveUrl = thumbDriveUrl;
                    log(asmId, `  🖼  Thumbnail uploaded to Drive: ${thumbDriveUrl}`);
                  } else {
```

**Target:**
```javascript
                  if (thumbDriveUrl) {
                    assemblyJobs[asmId].thumbDriveUrl = thumbDriveUrl;
                    log(asmId, `  🖼  Thumbnail uploaded to Drive: ${thumbDriveUrl}`);
                    // Persist thumbDriveUrl to job card so manual approval path can use it
                    if (assemblyJobId && persistedJobs[assemblyJobId]) {
                      saveJobCard(assemblyJobId, { ...persistedJobs[assemblyJobId], thumbDriveUrl });
                    }
                  } else {
```

---

### Change 2 — `cwn_production.html` (use thumbDriveUrl + canvaUrl in approval payload)

**Location:** `cwn_production.html:5207`

**Current:**
```javascript
    thumbnailUrl:  prep.thumbnailUrl || job.thumbnailUrl || '',
```

**Target:**
```javascript
    thumbnailUrl:  prep.thumbnailUrl || job.canvaUrl || job.thumbDriveUrl || job.thumbnailUrl || '',
```

**Priority order explained:**
- `prep.thumbnailUrl` — if operator manually set one in publish copy UI
- `job.canvaUrl` — the Canva-designed thumbnail (highest quality, preferred)
- `job.thumbDriveUrl` — auto-extracted 15s frame uploaded to Drive (fallback)
- `job.thumbnailUrl` — legacy field (currently never set, kept for safety)
- `''` — no thumbnail, YouTube auto-generates

---

## Verification

```bash
grep -n "thumbDriveUrl\|saveJobCard.*assemblyJobId" server.js
grep -n "thumbDriveUrl\|canvaUrl" cwn_production.html
node -c server.js
```

Expected results:
- `server.js`: `thumbDriveUrl` appears at 5186 + 5187 (existing) + 5188 (new saveJobCard call) + 5316 (auto-publish path, unchanged)
- `cwn_production.html`: `thumbDriveUrl` appears in `approveAndUpload` payload line

---

## Commit message

```
fix(publish): persist thumbDriveUrl to job card and wire into manual approval payload

YouTube thumbnail was never sent when Gate 3 = manual_review and Rob clicked
APPROVE & UPLOAD. Auto-publish path correctly used assemblyJobs[asmId].thumbDriveUrl
(in-memory), but manual path read job.thumbnailUrl from the persisted card — a field
never set.

server.js: after thumbDriveUrl Drive upload succeeds, call saveJobCard() to merge
it into persistedJobs[assemblyJobId] so it survives server restarts and is available
to the dashboard.

cwn_production.html: approveAndUpload() thumbnailUrl fallback chain now checks
prep.thumbnailUrl → job.canvaUrl → job.thumbDriveUrl → job.thumbnailUrl → ''.
canvaUrl takes priority over auto-frame when a Canva thumbnail has been designed.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## Ship Order

```
Commit → node -c server.js → git add server.js cwn_production.html STATUS.md && git commit → push
```
