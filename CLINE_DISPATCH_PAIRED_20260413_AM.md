# CLINE_DISPATCH_PAIRED_20260413_AM.md

**Author:** Claude Code (dispatched 2026-04-13 AM, post-smoke-test-6 diagnosis)
**For:** Cline — paired dispatch, two handoffs, ship as sequential atomic commits
**Purpose:** Unblock News smoke test #7 by shipping the two urgent fixes surfaced during smoke test #6.

---

## Ship order

1. **`CLINE_HANDOFF_GAP_51_STAGE_DIRECTION_LEAK.md`** (ship first — defensive one-liner)
2. **`CLINE_HANDOFF_NEWS_FIX_9B_HLS_DOWNLOAD.md`** (ship second — ~40-line refactor)

Independent files, can commit in either order, but ship #1 first because it's smaller surface area. Both unblock News smoke test #7.

---

## Handoff 1 — GAP 51: Stage direction leak

**Problem:** Gemini is writing `[3-second pause — hold on source clip]` into STORY#_REACTION scene text. The News Gemini prompt at `server.js:7081, 7091, 7093` instructs it to. That bracket text is supposed to be stripped by `cleanAvatarText()` at `cwn_production.html:3241` before it reaches HeyGen, but isn't — HeyGen rendered it as literal on-screen burned-in text during a 3-second frozen avatar with no audio. Gate 3 failed smoke test #6 three retries in a row reading that string off the screen.

**Evidence — Gemini Gate 3 LATE sample output from smoke test #6 (`asm_1776055054525`):**

> Retry 1 (83/100): *"1. VIDEO FREEZE: FAIL — The video freezes for approximately 3 seconds from 0:15 to 0:18, as indicated by the static avatar and the on-screen text overlay."*
>
> Retry 2 (83/100): *"1. VIDEO FREEZE: FAIL — The video freezes for approximately 3 seconds from 0:15 to 0:18, as indicated by the on-screen text '3 second pause, hold on source clip.'"*

**Fix:** Defensive `cleanAvatarText` wrapper at `cwn_production.html:1261` (HeyGen send path). Make sure every avatar text string that flows to HeyGen's `input_text` field passes through `cleanAvatarText()` first. The regex at line 3251 (`\[[^\]]*\]`) already handles bracket stripping — just ensure it's actually being called on the REACTION scene path.

**Investigation follow-up:** Grep all `cleanAvatarText` call sites, confirm `parseSegments_v2` (active, `USE_PARSE_SEGMENTS_V2 = true`) hits it at `cwn_production.html:3442`, and trace why REACTION scene text bypassed it. If root cause is found, ship a second commit removing the bracket text from the Gemini prompt itself at `server.js:7081/7091/7093`.

**Scope guardrails:** Do not rewrite Fix 6 Gemini prompt content rules. Do not touch NBA/Twitch/short-form. Single commit for the defensive fix.

**Full spec:** `CLINE_HANDOFF_GAP_51_STAGE_DIRECTION_LEAK.md`

---

## Handoff 2 — Fix 9B: Brightcove HLS download

**Problem:** Fix 9's `scrapeArticleVideo()` is returning real Brightcove HLS manifest URLs (e.g. `https://manifest.prod.boltdns.net/manifest/v1/hls/v3/clear/...`), but `downloadFile()` at `server.js:966-992` blocks them with `"URL blocked: not from trusted domain"`. Smoke test #6 logged this on segments 4 and 9. Zero News clips actually played despite Fix 9 succeeding end-to-end at the scraper layer.

**Evidence — nodemon log from smoke test #6:**

```
[asm_1776055054525] ❌ Failed segment 4 (source_clip): URL blocked: not from trusted domain.
  URL: https://manifest.prod.boltdns.net/manifest/v1/hls/v3/clear/665003303001/7e8f7aa5-dd29-4309-8739-740e
[asm_1776055054525] ❌ Failed segment 9 (source_clip): URL blocked: not from trusted domain.
  URL: https://manifest.prod.boltdns.net/manifest/v1/hls/v3/clear/665003303001/4ef59d86-763a-4a1b-8f78-fcfc
```

**Two sub-fixes in one commit:**

1. **Whitelist Brightcove CDN** — add `boltdns.net`, `brightcove.net`, `manifest.prod.boltdns.net` to the `trustedDomains` array at `server.js:968-978`.

2. **HLS `.m3u8` detection** — current `downloadFile()` uses naive axios streaming at `server.js:985-991` which can't resolve an HLS manifest (it's a playlist pointing at `.ts` segments, not a single file). Detect URLs ending in `.m3u8` OR containing `/hls/` path segment, and shell out to FFmpeg instead of axios:

   ```
   ffmpeg -i <manifest_url> -c copy -bsf:a aac_adtstoasc <destPath>
   ```

   Keep the axios path for everything else (HeyGen segments, Twitch CDN, Drive, etc). FFmpeg handles the manifest resolution, segment fetching, and concat natively.

**Scope guardrails:** Don't touch Fix 9's `scrapeArticleVideo()` at `server.js:6222` (it's working). Don't touch Fix 7 chrome burn or Fix 8B TV card burn. Don't touch NBA/Twitch code paths. ~40 lines total.

**Full spec:** `CLINE_HANDOFF_NEWS_FIX_9B_HLS_DOWNLOAD.md`

---

## Commit hygiene for both

- Re-read `COMMIT_CHECKLIST.md` before each commit
- Atomic staging (`git add <files> && git commit -m "..."`, never split, never `git add -A`)
- Update `STATUS.md` → 🤖 Last Agent Action table (pre-commit hook blocks skips)
- Update `LONGFORM_FIX_ROTATION.md` → move items from 🔴 To Fix to ✅ Shipped with commit hash
- `node -c server.js` exit 0 before commit
- Conventional commit format with `file:line` references
- Push to `origin/main` after both commits land
- nodemon auto-restarts server on `server.js` changes; Python dashboard server needs manual restart on `cwn_production.html` changes

## After both ship

Rob runs News long-form smoke test #7. Expected:

- Zero stage-direction leaks in rendered HeyGen segments (no `[3-second pause...]` burned-in text)
- Brightcove HLS clips actually download and play (non-zero `M_clips` in filename, real video content between avatar segments)
- Gate 3 LATE sample passes cleanly (no video freeze + audio fail)

If smoke test #7 runs cleanly, we unlock the 3-fix chrome polish handoff (`CLINE_HANDOFF_NEWS_SMOKE_TEST_6_THREE_FIXES.md`) as the next dispatch:

- Fix 1: LIVE indicator `margin-right:80px` (2-min CSS)
- Fix 2: sidebar vs flag+TV-card mutually exclusive + 0.75s transition gap (3-state FFmpeg burn)
- Fix 3: `orderedClipUrls` story-index alignment + silence placeholder skip on failed downloads

## Not in scope for this dispatch

- NBA long-form (Wave 1+2 shipped last night as `c742c16`; NBA voiceover assembly branch is a separate architectural lift — `CLINE_HANDOFF_NBA_VECTCUT_VOICEOVER.md` / `CLINE_HANDOFF_NBA_VOICEOVER_FFMPEG_V2.md` / `CLINE_HANDOFF_VECTCUT_LONGFORM_FOUNDATION.md`)
- Twitch long-form polish (tracked in `POST_PUBLISH_TASKS.md`)
- Short-form anything
- Module split Phase 2 (Aider overnight work)
