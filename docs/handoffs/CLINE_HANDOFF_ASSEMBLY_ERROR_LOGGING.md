# CLINE_HANDOFF_ASSEMBLY_ERROR_LOGGING.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-15
**Size:** S — `server.js` only, 4 targeted edits (~2 lines each)
**Problem:** Assembly failures are logged to in-memory `assemblyJobs[asmId].log` only. When the server restarts, the log is gone and there is no record of what went wrong. `logs/errors.jsonl` is completely empty of assembly errors — `logError()` is imported but never called from any assembly failure path.

---

## Evidence

Smoke test 12 assembly failed at `pct: 45` (post-download, pre-normalize). Server restarted sometime after. `assemblyJobs[asmId].log` was wiped. `logs/errors.jsonl` has no entry for it. Zero diagnostic information survives a server restart.

---

## The Fix — add `logError()` at all 4 assembly failure sites

`logError` is already imported at `server.js:94`. It writes to `logs/errors.jsonl` which persists across restarts. Just needs to be called.

### Site 1 — Disk space check failure (server.js:~3537)

```javascript
// Before:
      } catch (diskErr) {
        log(asmId, `❌ ${diskErr.message}`);
        assemblyJobs[asmId].status = 'failed';
        assemblyJobs[asmId].error = diskErr.message;
        return;
      }

// After:
      } catch (diskErr) {
        log(asmId, `❌ ${diskErr.message}`);
        logError('ASSEMBLY_DISK_FAIL', diskErr.message, { asmId, jobId: assemblyJobId });
        assemblyJobs[asmId].status = 'failed';
        assemblyJobs[asmId].error = diskErr.message;
        return;
      }
```

### Site 2 — No segments downloaded (server.js:~3853)

```javascript
// Before:
      if (!localFiles.length) {
        log(asmId, '❌ No segments could be downloaded. Aborting.');
        assemblyJobs[asmId].status = 'failed';
        return;
      }

// After:
      if (!localFiles.length) {
        log(asmId, '❌ No segments could be downloaded. Aborting.');
        logError('ASSEMBLY_NO_SEGMENTS', 'No segments could be downloaded', { asmId, jobId: assemblyJobId, contentType });
        assemblyJobs[asmId].status = 'failed';
        assemblyJobs[asmId].error = 'No segments could be downloaded';
        return;
      }
```

### Site 3 — Pre-flight critical failure (server.js:~4133)

```javascript
// Before:
        log(asmId, `❌ Gate 3 pre-flight failed — ${preFlightCriticals.length} critical issue(s). Aborting before Gemini upload.`);
        assemblyJobs[asmId].status = 'failed';
        assemblyJobs[asmId].error  = preFlightCriticals.map(i => i.detail).join('; ');
        assemblyJobs[asmId].qaOutcome = 'pre_flight_fail';

// After:
        const preFlightMsg = preFlightCriticals.map(i => `[${i.check}] ${i.detail}`).join('; ');
        log(asmId, `❌ Gate 3 pre-flight failed — ${preFlightCriticals.length} critical issue(s). Aborting before Gemini upload.`);
        logError('ASSEMBLY_PREFLIGHT_FAIL', preFlightMsg, { asmId, jobId: assemblyJobId, contentType, issues: preFlightCriticals });
        assemblyJobs[asmId].status = 'failed';
        assemblyJobs[asmId].error  = preFlightMsg;
        assemblyJobs[asmId].qaOutcome = 'pre_flight_fail';
```

### Site 4 — Top-level assembly catch (server.js:~5464) — THE MOST IMPORTANT ONE

This catches any unhandled exception in the entire assembly pipeline — FFmpeg crashes, Puppeteer errors, unexpected nulls, etc.

```javascript
// Before:
    } catch (err) {
      log(asmId, `\n❌ Assembly error: ${err.message}\n${err.stack}`);
      assemblyJobs[asmId].status = 'failed';
      assemblyJobs[asmId].error  = err.message;
    }

// After:
    } catch (err) {
      log(asmId, `\n❌ Assembly error: ${err.message}\n${err.stack}`);
      logError('ASSEMBLY_CRASH', err.message, {
        asmId,
        jobId: assemblyJobId,
        contentType,
        pct: assemblyJobs[asmId]?.pct,
        stack: err.stack
      });
      assemblyJobs[asmId].status = 'failed';
      assemblyJobs[asmId].error  = err.message;
    }
```

---

## What this gives you

After this ships, every assembly failure writes a structured entry to `logs/errors.jsonl`:

```json
{
  "ts": "2026-04-15T03:31:52.000Z",
  "label": "ASSEMBLY_CRASH",
  "message": "Cannot read properties of undefined (reading 'scenes')",
  "context": {
    "asmId": "asm_1776223747401",
    "jobId": "script_news_1776223175780",
    "contentType": "news",
    "pct": 45,
    "stack": "TypeError: Cannot read properties..."
  }
}
```

This survives server restarts and is queryable. The `pct` field tells you exactly which stage it crashed at. The `stack` tells you the exact line.

---

## Files to change

| File | Tier | Edits |
|------|------|-------|
| `server.js` | 1 | 4 catch blocks — add `logError()` call to each |

---

## Commit message

```
fix(assembly): log all failure paths to errors.jsonl — survive server restart

Assembly failures were written to in-memory assemblyJobs[asmId].log only.
Server restart wiped the log with no persistent record. logError() was
imported at line 94 but never called from any assembly failure path.

Added logError() calls at all 4 failure sites:
- ASSEMBLY_DISK_FAIL: disk space check
- ASSEMBLY_NO_SEGMENTS: all downloads failed
- ASSEMBLY_PREFLIGHT_FAIL: Gate 3 pre-flight critical issues
- ASSEMBLY_CRASH: top-level catch — any unhandled exception (most important)

ASSEMBLY_CRASH includes pct (which pipeline stage crashed) and full
stack trace so post-restart diagnosis is possible from logs/errors.jsonl.
```
