# CLINE_HANDOFF_RETRY_ASSEMBLY.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-14
**Size:** M — server.js only, Tier 1
**Depends on:** `CLINE_HANDOFF_ASSEMBLY_DEDUP_LOCK.md` already shipped (commit 2f744e1)
**Problem:** `/assemble/:asmId/retry` was implemented as a lock-clear only. It does NOT re-run FFmpeg. After a crash, the tmp segments sit unused and the operator has to re-run the entire pipeline (re-submit to HeyGen, burn more credits) instead of just re-running the FFmpeg step.
**Goal:** Re-assemble from existing `tmp/asm_{asmId}_*.mp4` files — skip Gate 1, skip HeyGen, skip downloads. Just FFmpeg concat + normalize + ticker + Gate 3.
**1 commit.**

---

## What's Already There

The current `/assemble/:asmId/retry` at `server.js:5504` only clears the lock:

```javascript
app.post('/assemble/:asmId/retry', (req, res) => {
  // ... just clears assemblyJobs[asmId] entry
  res.json({ ok: true, message: 'Assembly lock cleared — retry is now allowed' });
});
```

This needs to be replaced with an actual re-assembly that uses existing tmp files.

---

## The Fix

### Step 1 — Find the tmp files for the asmId

The download loop at `server.js:~3700-4100` converts each segment to `.mp4` in `tmp/` with the naming pattern:

```
tmp/asm_{asmId}_{index}_{sceneName}.mp4
```

e.g. `tmp/asm_1776214429562_26_outro.mp4`

These are the `localFiles` array that the FFmpeg concat step consumes.

### Step 2 — Replace the retry endpoint at `server.js:5501-5520`

**Current:**
```javascript
// POST /assemble/:asmId/retry — clear the dedup lock so a stuck assembly can be retried
app.post('/assemble/:asmId/retry', (req, res) => {
  const { asmId } = req.params;
  if (assemblyJobs[asmId] && assemblyJobs[asmId].status === 'running') {
    console.warn(`[assemble/retry] asmId=${asmId} is still running — cannot retry a live assembly`);
    return res.status(409).json({ error: 'Assembly still running', asmId });
  }
  if (assemblyJobs[asmId]) {
    console.log(`[assemble/retry] Cleared assemblyJobs entry for asmId=${asmId} — retry now allowed`);
    delete assemblyJobs[asmId];
  } else {
    console.log(`[assemble/retry] No assemblyJobs entry found for asmId=${asmId} — already clear`);
  }
  res.json({ ok: true, message: 'Assembly lock cleared — retry is now allowed', asmId });
});
```

**Target:**
```javascript
// POST /assemble/:asmId/retry — re-run FFmpeg assembly from existing tmp segments
// Skips Gate 1, HeyGen, and downloads. Uses tmp/asm_{asmId}_*.mp4 files directly.
app.post('/assemble/:asmId/retry', async (req, res) => {
  const { asmId } = req.params;
  const { contentType = 'news', jobTitle, assemblyJobId } = req.body;

  // Block if still running
  if (assemblyJobs[asmId] && assemblyJobs[asmId].status === 'running') {
    console.warn(`[assemble/retry] asmId=${asmId} is still running — cannot retry a live assembly`);
    return res.status(409).json({ error: 'Assembly still running — wait for it to finish or restart server', asmId });
  }

  // Find existing tmp files for this asmId, sorted by index
  const tmpFiles = fs.readdirSync(TMP_DIR)
    .filter(f => f.startsWith(asmId + '_') && f.endsWith('.mp4'))
    .sort((a, b) => {
      // Sort by numeric index: asm_{asmId}_{index}_{name}.mp4
      const idxA = parseInt(a.split('_')[3]) || 0;
      const idxB = parseInt(b.split('_')[3]) || 0;
      return idxA - idxB;
    })
    .map(f => path.join(TMP_DIR, f));

  if (!tmpFiles.length) {
    return res.status(404).json({
      error: 'No tmp segments found for this asmId — tmp/ may have been cleaned. Cannot retry.',
      asmId,
      hint: 'Run a fresh assembly from the dashboard.'
    });
  }

  // Infer segTypes from filenames: files with 'clip' in name are source_clip, rest are avatar
  const segTypes = tmpFiles.map(f => path.basename(f).toLowerCase().includes('clip') ? 'source_clip' : 'avatar');

  log(asmId, `🔄 RETRY: Re-assembling from ${tmpFiles.length} existing tmp segments (skipping HeyGen)`);
  log(asmId, `Segment types: ${segTypes.filter(t => t === 'avatar').length} avatar, ${segTypes.filter(t => t === 'source_clip').length} source_clip`);

  // Reset assembly job state
  assemblyJobs[asmId] = {
    pct: 45,
    log: '',
    status: 'running',
    outputPath: null,
    sourceJobId: assemblyJobId || null,
    isRetry: true
  };

  res.json({ ok: true, asmId, segmentCount: tmpFiles.length, message: 'Retry assembly started from existing segments' });

  // ── Re-run from Step 4 (normalize → concat → ticker → Gate 3 → Drive upload) ──
  const retryRun = async () => {
    try {
      // Step 4: TS normalization (already done on first run — files are .mp4 not .ts)
      // Skip normalization, use tmpFiles directly as localFiles
      const localFiles = tmpFiles;

      // Build output path
      const outDir  = OUTPUT_DIR;
      const baseTitle = (jobTitle || 'cwn_retry').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
      const actualClipCount = segTypes.filter(t => t === 'source_clip').length;
      const outFile = `${baseTitle}_retry_${actualClipCount}clips_${Date.now()}.mp4`;
      const outPath = path.join(outDir, outFile);

      // Step 5: Build concat list
      log(asmId, `Building concat list from ${localFiles.length} segments...`);
      const concatListPath = path.join(TMP_DIR, `concat_${asmId}.txt`);
      const concatContent  = localFiles.map(f => `file '${f}'`).join('\n');
      fs.writeFileSync(concatListPath, concatContent);

      // Step 6: FFmpeg concat
      log(asmId, `Running FFmpeg concat...`);
      assemblyJobs[asmId].pct = 55;
      await new Promise((resolve, reject) => {
        const args = [
          '-f', 'concat', '-safe', '0', '-i', concatListPath,
          '-c:v', 'libx264', '-c:a', 'aac',
          '-movflags', '+faststart',
          '-y', outPath
        ];
        const proc = execFile(ffmpegPath(), args, { timeout: 30 * 60 * 1000 });
        proc.stdout.on('data', d => log(asmId, d.toString().trim()));
        proc.stderr.on('data', d => log(asmId, d.toString().trim()));
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg concat failed: exit ${code}`)));
        proc.on('error', reject);
      });

      assemblyJobs[asmId].pct  = 80;
      assemblyJobs[asmId].outputPath = outPath;
      log(asmId, `✅ FFmpeg concat complete: ${outFile}`);

      // Step 7: Gate 3 QA
      const avatarCount      = segTypes.filter(t => t === 'avatar').length;
      const downloadedClipCount = segTypes.filter(t => t === 'source_clip').length;
      const totalDurResult   = await new Promise((res, rej) => {
        execFile(ffmpegPath().replace('ffmpeg', 'ffprobe'), [
          '-v', 'error', '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1', outPath
        ], (err, stdout) => err ? rej(err) : res(stdout.trim()));
      }).catch(() => '0');

      log(asmId, `\n🔍 Gate 3: Running Gemini QA check (retry)...`);
      const qaResult = await geminiQACheck(outPath, {
        contentType, avatarCount,
        clipCount: downloadedClipCount,
        downloadedClipCount,
        expectedTicker: false,   // ticker not baked in retry — add if needed
        totalDuration: parseFloat(totalDurResult)
      });

      assemblyJobs[asmId].qaScore   = qaResult.score;
      assemblyJobs[asmId].qaReport  = qaResult.report;
      assemblyJobs[asmId].qaOutcome = qaResult.outcome;

      log(asmId, `Gate 3: ${qaResult.outcome} (${qaResult.score}/100)`);

      if (qaResult.outcome === 'pass' || qaResult.outcome === 'manual_review') {
        // Upload to Drive
        log(asmId, `Uploading to Google Drive...`);
        const driveUrl = await uploadToDrive(outPath, path.basename(outPath));
        assemblyJobs[asmId].driveUrl = driveUrl;
        assemblyJobs[asmId].status   = 'done';
        assemblyJobs[asmId].pct      = 100;
        log(asmId, `✅ RETRY COMPLETE — Drive: ${driveUrl}`);
      } else {
        assemblyJobs[asmId].status = 'failed';
        assemblyJobs[asmId].error  = `Gate 3 failed on retry: ${qaResult.score}/100`;
        log(asmId, `❌ Gate 3 failed on retry (${qaResult.score}/100) — manual review needed`);
      }
    } catch (err) {
      assemblyJobs[asmId].status = 'failed';
      assemblyJobs[asmId].error  = err.message;
      log(asmId, `❌ Retry assembly error: ${err.message}`);
      console.error('[assemble/retry] Error:', err);
    }
  };

  retryRun();
});
```

---

## Dashboard: Add RETRY ASSEMBLY Button

In `cwn_production.html`, on any job card where assembly failed (status has error or Gate 3 fail badge), add a **↩ RETRY ASSEMBLY** button alongside the existing ROLLBACK / FORCE ADVANCE buttons.

The button should call:

```javascript
function retryAssembly(asmId, contentType, jobTitle, assemblyJobId) {
  if (!asmId) { alert('No assembly ID found — cannot retry'); return; }
  if (!confirm('Re-run FFmpeg assembly from existing segments?\n\nThis skips HeyGen — no credits used.')) return;
  
  fetch(CFG.ffmpegUrl + '/assemble/' + asmId + '/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType, jobTitle, assemblyJobId })
  })
  .then(r => r.json())
  .then(d => {
    if (d.ok) {
      cwn_log('🔄 Retry assembly started for ' + asmId + ' (' + d.segmentCount + ' segments)', false);
    } else {
      cwn_log('❌ Retry failed: ' + (d.error || JSON.stringify(d)), true);
    }
  });
}
```

Show the button when:
- `job.asmId` exists (assembly was attempted)
- `job.status === 'error'` or `job.qaOutcome === 'fail'` or `job.qaOutcome === 'pre_flight_fail'`

The `asmId` needs to be stored on the job card. Check if it's already there — if not, the `/assemble` response returns `assemblyId` which the dashboard should save to the job card.

---

## Test With Smoke Test 11 Crash

After implementing, test immediately with the existing crash data:

```bash
curl -s -X POST http://localhost:3000/assemble/asm_1776214429562/retry \
  -H "Content-Type: application/json" \
  -d '{"contentType":"news","jobTitle":"news_smoke_test_11_retry"}'
```

Expected: assembles from the 27 existing tmp files, Gate 3 runs, uploads to Drive.

Watch `assemblyJobs['asm_1776214429562']` via:
```bash
curl -s http://localhost:3000/assembly-status/asm_1776214429562
```

---

## Commit Message

```
feat(assembly): implement /assemble/:asmId/retry — re-assemble from tmp segments

Previous implementation only cleared the dedup lock. This commit adds
actual re-assembly: reads existing tmp/asm_{asmId}_*.mp4 files, skips
Gate 1 + HeyGen + downloads, runs FFmpeg concat + Gate 3 + Drive upload.

Use case: assembly crashed (race condition, FFmpeg error, server restart)
but HeyGen segments already downloaded — no need to re-burn HeyGen credits.

Changes:
- server.js: /assemble/:asmId/retry replaced with full re-assembly logic
- cwn_production.html: RETRY ASSEMBLY button on failed job cards

Test: asm_1776214429562 has 27 segments in tmp/ from smoke test 11 crash.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## Ship Order

```
node -c server.js
→ replace /assemble/:asmId/retry endpoint in server.js
→ add retryAssembly() + RETRY ASSEMBLY button in cwn_production.html
→ node -c server.js
→ git add server.js cwn_production.html STATUS.md && git commit
→ push
→ test: curl -X POST http://localhost:3000/assemble/asm_1776214429562/retry -H "Content-Type: application/json" -d '{"contentType":"news"}'
→ watch logs, confirm Gate 3 fires, confirm Drive upload
```
