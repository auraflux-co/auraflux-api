# CLINE_HANDOFF_NEWS_LONGFORM_FIXES_BATCH2.md

**Author:** Claude Code (dispatched 2026-04-12, post-smoke-test feedback)
**For:** Cline (implementation)
**Scope:** News long-form — one-line fix for the `/newscast-overlay` route HTTP 500 that silently broke the News TV card for a full day
**Ship order:** Single fix, single commit
**Do NOT touch:** NBA, Twitch, short-form, News Gemini prompt (Road A/B decision is parked separately)
**Before committing:** Re-read `COMMIT_CHECKLIST.md` — atomic staging, STATUS.md update, `.md` doc sync.

---

## Context — why this fix exists

Today's News long-form smoke test produced a 42-avatar-segment video where the newscast TV card overlay was **not visible** in the final MP4, even though the assembly log showed `📰 NEWS newscast overlay burned [1/10]` through `[10/10]` as if the burn loop succeeded. Gate 3's Gemini sample correctly flagged `TV CARD: FAIL — A TV-shaped overlay card is not visible in the top-right corner of the video` with a -10 deduction on the EARLY sample.

Root cause, verified via `curl`:

```bash
$ curl -s -o /tmp/x -w "HTTP:%{http_code}\n" http://localhost:3000/newscast-overlay
HTTP:500
$ cat /tmp/x
{"ok":false,"error":"Internal server error","label":"EXPRESS_UNHANDLED"}
```

The route handler at `server.js:1299-1301`:

```js
app.get('/newscast-overlay', (req, res) => {
  res.sendFile(path.join(__dirname, 'clipzworld_newscast.html'));
});
```

`clipzworld_newscast.html` no longer exists at the repo root. It was moved to `tools/clipzworld_newscast.html` in commit `b31533f refactor: reorganize root into folders` on 2026-04-11 00:30 ET. `res.sendFile` on a non-existent path throws ENOENT, Express catches it as an unhandled error, returns HTTP 500.

Downstream chain from that failure:

1. `generateNewscastOverlay()` at `server.js:10328` launches Puppeteer, calls `page.goto('http://localhost:3000/newscast-overlay')`
2. Puppeteer loads the HTTP 500 error response — most likely a transparent/blank viewport
3. `page.screenshot({ path: outputPath, fullPage: false })` at line 10383 writes a blank PNG to disk
4. `console.log('[newscast-overlay] ✅ Generated overlay ...')` at line 10384 logs success because no exception fired
5. FFmpeg blend filter at `server.js:3866` (`[0:v][1:v]blend=all_mode=normal:all_opacity=1:enable='lte(t,${introDur})'[out]`) blends the blank PNG onto Bobby G for 10 seconds of each intro segment — visually a no-op
6. Downstream code at `server.js:3888` sees the burned output file exists with size > 10000, updates `inputForTS = burnedPath`, logs `📰 NEWS newscast overlay burned [N/N]` as if it worked

**Same class of bug as the ticker path bug fixed in commit `0d13fb0` on 2026-04-11** — commit `b31533f` moved multiple HTML files into `tools/` and `0d13fb0` fixed the stale `TICKER_MAP` paths but missed this companion stale path in the `/newscast-overlay` route handler. Every News long-form run since Apr 11 has been silently producing invisible newscast overlays.

---

## Fix 5 — Update newscast overlay route to point at `tools/`

**File:** `server.js`
**Line:** 1300
**Effort:** XS (one line change + one verification curl)

### The change

**From:**
```js
app.get('/newscast-overlay', (req, res) => {
  res.sendFile(path.join(__dirname, 'clipzworld_newscast.html'));
});
```

**To:**
```js
app.get('/newscast-overlay', (req, res) => {
  res.sendFile(path.join(__dirname, 'tools/clipzworld_newscast.html'));
});
```

That's it. No other code changes required for Fix 5.

### Verification (must run before commit)

After saving `server.js`, nodemon will auto-restart. Then:

```bash
curl -s -o /tmp/newscast-check.html -w "HTTP:%{http_code} SIZE:%{size_download}\n" http://localhost:3000/newscast-overlay
```

**Expected:** `HTTP:200 SIZE:<large number, should be several KB of HTML>`

**If still 500:** the file path is still wrong or `tools/clipzworld_newscast.html` doesn't exist in the working tree. Run `ls tools/clipzworld_newscast.html` to confirm. Do NOT commit until the curl returns HTTP 200.

### Why we're not also adding a defensive sanity check on the Puppeteer screenshot

The `generateNewscastOverlay()` function at `server.js:10328` could be hardened to detect a blank/transparent screenshot (e.g., check image histogram for any non-alpha pixels before returning success) and throw instead of silently returning a useless file. **Do not add that check in this commit.** It's a real follow-up and belongs in a separate fix so this commit stays one line and reverts cleanly if anything unexpected happens. Note the follow-up in STATUS.md so it doesn't get lost.

---

## Commit strategy

**Single commit:**

```
fix(news): /newscast-overlay route path — tools/ prefix missing (server.js:1300)

Commit b31533f moved clipzworld_newscast.html into tools/ but the route handler
at server.js:1300 kept pointing at the repo-root path. res.sendFile threw ENOENT,
Express returned HTTP 500, Puppeteer screenshotted the error page as a blank
transparent PNG, FFmpeg blended the blank PNG over Bobby G, final video had no
visible newscast overlay. Same class of bug as the ticker path fix in 0d13fb0 —
that commit fixed TICKER_MAP paths but missed this companion stale path.

Changes:
- server.js:1300 — path.join(__dirname, 'clipzworld_newscast.html')
                 → path.join(__dirname, 'tools/clipzworld_newscast.html')

Verifies: curl http://localhost:3000/newscast-overlay returns HTTP 200 with HTML body
Impact: every News long-form run since 2026-04-11 00:30 ET has been producing
        invisible newscast overlays (burn loop logs success, visual output is
        Bobby G unchanged)

References: LONGFORM_FIX_ROTATION.md News batch 2 postmortem, commit b31533f, commit 0d13fb0
```

Then per `COMMIT_CHECKLIST.md`:

1. **Atomic staging** — `git add server.js STATUS.md && git commit -m "..." && git push` in a single chained command. Do NOT split `git add` and `git commit` into separate tool calls — concurrent commit incidents have happened before.
2. **Update `STATUS.md` 🤖 Last Agent Action table** — new row with agent=Cline, this task, file=server.js, commit hash, timestamp. Pre-commit hook will block if skipped.
3. **Update `LONGFORM_FIX_ROTATION.md`** — move the Fix 5 item from `📤 Dispatched to Cline` → `✅ Shipped` section with the commit hash. Add a new row to the rotation log.
4. **Do not update any other docs** — no CLAUDE.md update, no SERVER_SPLIT_PLAN.md, no POST_PUBLISH_TASKS.md. This fix is a hot fix, not a feature.

---

## Testing checklist

Before Rob runs the next News smoke test:

- [ ] `git log --oneline -1` shows the new commit on `main`
- [ ] `git show HEAD --stat` shows only `server.js` + `STATUS.md` + `LONGFORM_FIX_ROTATION.md` changed (3 files)
- [ ] Nodemon auto-restarted cleanly — no error on boot
- [ ] `curl http://localhost:3000/newscast-overlay` returns HTTP 200 with HTML body (not a 500)
- [ ] The HTML body contains `<div class="lt-headline">` or similar (confirms the file served is `clipzworld_newscast.html`, not an unrelated file)

Rob will then re-run the News long-form smoke test from the dashboard. Expected visual change: first ~10 seconds of each `STORY#_INTRO` segment show a full-screen newscast graphics layer (lower third with headline, category tag, date, story list sidebar, breaking news banner) covering Bobby G — not a small top-right TV card. This is the intended News visual design per `clipzworld_newscast.html` template.

---

## What this fix does NOT solve

1. **News still has no source video clips.** `orderedClipUrls` will still be filtered to an empty array because News items don't carry `videoUrl` fields. The `STORY#_SETUP` and `STORY#_CLIP_REACTION` scenes will still render avatar-only with phantom `[CLIP PLAYS HERE]` beats. The script will still say "check this out" to a clip that doesn't play.
2. **Road A vs Road B decision is parked.** This fix only makes the newscast overlay visible so Rob can actually judge whether News is watchable as an all-avatar anchor-narration format. If after this run News still feels broken, the next batch will be the Gemini prompt rewrite (Road B) or the YouTube video source wiring (Road A).
3. **Gate 3 `clipsExpectedButMissing` guard still allows 0-clip News to auto-proceed.** The guard condition is `clipCount > 0`, which is false for News because the filter emptied the array. Adding a `contentType === 'news'` override or tracking `clipsExpectedByScript` based on `[CLIP PLAYS HERE]` marker count in the script is a separate fix that depends on the Road A/B decision — don't do it here.

---

## Rollback plan

If the commit causes any regression on Twitch or NBA:

```bash
git revert HEAD && git push
```

Zero rollback risk in practice — the change is a path string, affects only the `/newscast-overlay` route, only News long-form uses that route, Twitch and NBA use completely different intro card burn paths (`generateIntroCardPNG` for Twitch, `generateGameStoryCardPNG` for NBA).

---

## Why this works (teaching section)

The bug is a **stale path reference after a file move**. It's the same pattern as the ticker path bug from the same underlying commit (`b31533f`). The lesson for future refactors: when moving files to a new folder, `grep` the entire repo for the old filename *and* the old path construction pattern before committing. The ticker fix in `0d13fb0` did exactly that for `TICKER_MAP` but the grep missed `clipzworld_newscast.html` because its stale reference was in a route handler that used `path.join(__dirname, ...)` construction instead of a lookup table.

The deeper lesson is that **log lines are not verification.** `📰 NEWS newscast overlay burned [N/N]` has been appearing in logs for a full day while producing invisible overlays. The burn loop was correctly catching the Puppeteer success return value, correctly writing a file with size > 10000 bytes (a blank PNG is still several KB), and correctly logging success — all while the actual visual output was broken. Real verification needs either (a) a visible pixel check on the screenshot output, or (b) a downstream visual QA step that actually looks at the frame. Gate 3's Gemini sampling is the closest thing we have to (b), and it correctly caught this — but the deduction was only -10 and auto-proceed kicked in at 90/100. The `contentType === 'news'` hard-fail on missing TV card is a separate follow-up fix; noted in the rotation doc's Postmortem section.
