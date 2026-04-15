# CLINE_HANDOFF_SEQUENCE_APR14.md

**Author:** Claude Code, 2026-04-14  
**For:** Cline (fresh session — Gemini 2.5 Flash, Act mode)  
**Purpose:** Ordered queue of handoffs for today's session. Paste one at a time. Do not skip ahead.

---

## Reading order for fresh session start

Read these 3 files first, in order, before accepting any task:
1. `CLAUDE.md`
2. `STATUS.md`
3. `CLINE_HANDOFF_NEWS_CHROME_FIX.md`

Then proceed with the tasks below in sequence.

---

## TASK 1 — News chrome fixes 2-6 (SHIP FIRST — blocks News lock)

**Source:** `CLINE_HANDOFF_NEWS_CHROME_FIX.md` fixes 2-6  
**Files to open:** `server.js`, `tools/clipzworld_newscast.html`  
**Do NOT open:** `cwn_production.html`, `lib/`, anything else

### Fix 2 — `server.js:8127-8129` — upgrade sidecar catch to console.error

Find this block:
```js
} catch(sidecarErr) {
  console.warn(`[generate-full-script] ⚠️  Failed to write directive sidecar: ${sidecarErr.message} — continuing with extracted spoken text`);
}
```

Replace with:
```js
} catch(sidecarErr) {
  console.error(`[generate-full-script] ❌ DIRECTIVE SIDECAR WRITE FAILED: ${sidecarErr.message}`);
  console.error('[generate-full-script] Chrome elements (TV card, flag, sidebar) will NOT render in assembly.');
  console.error('[generate-full-script] Fix: ensure Gemini News prompt emits all required Zod fields (scriptVersion, clientId, brandConfig.episodeNumber as integer, per-scene estimatedDurationSec as positive number, storyList as array of objects).');
}
```

### Fix 3 — `server.js` — verify Gemini News prompt emits all required Zod fields

Search for `scriptVersion` in `server.js` to find the News Gemini prompt template. Verify the JSON example in the prompt includes ALL of these fields with correct types:

| Field | Required type |
|---|---|
| `scriptVersion` | integer `1` (not string `"1"`) |
| `contentType` | string `"news"` |
| `clientId` | string `"cwn"` |
| `brandConfig.episodeNumber` | integer (not string) |
| `estimatedTotalDurationSec` | positive number at top level |
| `storyList` | array of `{index: number, title: string, source: string}` objects (not strings) |
| per avatar scene: `estimatedDurationSec` | positive number (most commonly missing) |
| per source_clip scene: NO `spokenText` field | source_clip scenes must not have spokenText |

If any field is missing from the prompt example or has wrong type, fix the prompt. If all fields are present and correct, no change needed — just confirm in the commit message.

### Fix 4 — `tools/clipzworld_newscast.html` — clear DOM placeholder text

Find the line containing `Global Markets React to Federal Reserve Rate Decision` (approximately line 422). It will be inside a `<div class="lt-headline">` tag.

Change it to:
```html
<div class="lt-headline"></div>
```

### Fix 5 — `server.js` — replace 500ms setTimeout with document.fonts.ready

Inside `generateNewscastOverlay()`, find:
```js
await new Promise(resolve => setTimeout(resolve, 500));
```

Replace with:
```js
await page.evaluate(() => document.fonts.ready);
await new Promise(resolve => setTimeout(resolve, 100));
```

### Fix 6 — `server.js` — make page.evaluate async, await TV card image load

Inside `generateNewscastOverlay()`, find the `page.evaluate` call. Change the callback from:
```js
await page.evaluate((data, activeIndex, opts) => {
```
to:
```js
await page.evaluate(async (data, activeIndex, opts) => {
```

Then inside that callback, find where `tvCardImg.src` is set. After the line that sets `tvCardImg.src = opts.tvCard.imageUrl` (or similar), add:
```js
if (tvCardImg && opts && opts.tvCard && opts.tvCard.imageUrl) {
  await new Promise(resolve => {
    if (tvCardImg.complete && tvCardImg.naturalWidth > 0) { resolve(); return; }
    tvCardImg.onload = resolve;
    tvCardImg.onerror = resolve;
    setTimeout(resolve, 3000);
  });
}
```

### Verification
```bash
node --check server.js
```

### Commit message
```
fix(news): chrome pipeline fixes 2-6 — Zod error visibility, font/image race conditions

- server.js: upgrade directive sidecar catch from console.warn to console.error
  so Zod validation failures are impossible to miss in logs
- server.js: verify/fix Gemini News prompt emits all required Zod fields
  (scriptVersion, estimatedDurationSec per scene, storyList as objects)
- tools/clipzworld_newscast.html: clear lt-headline DOM default placeholder text
- server.js: replace 500ms setTimeout with document.fonts.ready for
  deterministic font render before Puppeteer screenshot
- server.js: make page.evaluate async, await TV card image load with 3s timeout
  so og:image is fully loaded before screenshot fires

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## TASK 2 — Wave 0 cleanup batch (non-blocking, do after Task 1)

**Source:** `CLINE_HANDOFF_WAVE_0_CLEANUP.md`  
**Files to open:** `server.js` only (open once, do all server.js items, then commit)  
**Do NOT open:** `cwn_production.html` unless a specific item requires it

Work through these items in order. One commit per item (or bundle #15+#33 as one commit — they're the same pattern applied to News and NBA).

**Order:**
1. Gap #5 — remove dead `/news/generate-intro-card` endpoint
2. Gap #15 + #33 — humanize News + NBA chapter labels (one commit)
3. Gap #17 — Upload-Post cross-platform confirmation logging
4. Gap #44 — intro card duration per content type
5. Gap #45 — outro freeze-hold via FFmpeg filter
6. Gap #10 + #40 — Gate 3 LATE-sample outro false positive
7. Gap #24 — NBA defensive guard for empty clipUrl
8. Gap #19 — NBA SELECT GAMES UX hardening
9. Gap #20 — NBA ESPN video selection quality filter
10. Gap #34 — NBA `/generate-publish-copy` quality
11. Gap #13 — News `/generate-publish-copy` quality
12. Gap #39 — white strips diagnostic (diagnostic only, no fix unless obvious)
13. Gap #42 — Gate 3 TV card check wording (only if HANDOFF_7 is shipped)

Stop after any item that requires more than 15 minutes. Flag it in STATUS.md and move to the next item.

---

## TASK 3 — NBA long-form (only after News smoke test passes)

**Source:** `CLINE_HANDOFF_NBA_VOICEOVER_FFMPEG_V2.md`  
**Gate:** Do NOT start this until a News long-form smoke test shows TV card + lower-third flag + sidebar all rendering correctly.  
**Rob will confirm** when News is locked and NBA can start.

---

## Notes for Cline

- Run `node --check server.js` after every server.js edit before committing
- Update `STATUS.md` → `🤖 Last Agent Action` table in every commit
- If Flash hits a wall on any item, stop and tell Rob — do not switch models mid-session
- Do not open files not listed in the task. Flash stays fast when context is lean.
