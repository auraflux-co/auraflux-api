# CLINE_HANDOFF_NEWS_FIX_9B_HLS_DOWNLOAD.md

**Author:** Claude Code (dispatched 2026-04-13 during News smoke test #6)
**For:** Cline (immediate implementation — blocks News smoke test #6 success)
**Scope:** Fix `downloadFile()` at `server.js:966-992` to (a) allow Brightcove CDN domains through the SSRF whitelist, and (b) detect HLS `.m3u8` manifest URLs and resolve them via FFmpeg instead of naive axios streaming. This unblocks Fix 9's end-to-end success.
**Ship order:** Single atomic commit. Small change (~40 lines). URGENT — blocks News smoke test #6 verification.
**Do NOT touch:** Fix 9's `scrapeArticleVideo()` at `server.js:6222` (working correctly, returning real Brightcove HLS URLs), Fix 7 chrome burn, Fix 8B TV card burn, NBA/Twitch code paths.
**Before committing:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging. STATUS.md update. LONGFORM_FIX_ROTATION.md update.

---

## Context — real-time failure during News smoke test #6

News smoke test #6 fired at 2026-04-13 ~early-AM with all recent fixes shipped (Fix 5 through Fix 9). Fix 9's `scrapeArticleVideo()` worked correctly — yt-dlp returned real Brightcove HLS manifest URLs for 2+ stories. Example:

```
https://manifest.prod.boltdns.net/manifest/v1/hls/v3/clear/665003303001/7e8f7aa5-dd29-4309-8739-740e...
```

But the assembly pipeline failed to download the clips:

```
[asm_1776055054525] ❌ Failed segment 4 (source_clip): URL blocked: not from trusted domain.
  URL: https://manifest.prod.boltdns.net/manifest/v1/hls/v3/clear/665003303001/7e8f7aa5-dd29-4309-8739-740e
[asm_1776055054525] ❌ Failed segment 9 (source_clip): URL blocked: not from trusted domain.
  URL: https://manifest.prod.boltdns.net/manifest/v1/hls/v3/clear/665003303001/4ef59d86-763a-4a1b-8f78-fcfc
```

**Two problems surfaced in `downloadFile()` at `server.js:966-992`:**

### Problem 1 — SSRF whitelist doesn't include Brightcove CDN

Current whitelist at `server.js:968-978`:
```javascript
const trustedDomains = [
  'clips-media-assets',
  'clips-media-assets2',
  'production-assets',
  'cloudfront.net',
  'resource.heygencdn.com',
  'files2.heygen.ai',
  'heygen.ai',
  'storage.googleapis.com',
  'drive.google.com'
];
```

None of these match `boltdns.net`, `brightcove.net`, or `manifest.prod.boltdns.net`. News never had real Brightcove URLs before Fix 9 shipped tonight, so no one thought to whitelist Brightcove's CDN.

### Problem 2 — `downloadFile()` uses naive axios streaming, which can't resolve HLS

Current download logic at `server.js:985-991`:
```javascript
const writer = fs.createWriteStream(destPath);
const resp   = await axios({ url, method: 'GET', responseType: 'stream', timeout: 120000 });
resp.data.pipe(writer);
return new Promise((res, rej) => {
  writer.on('finish', res);
  writer.on('error', rej);
});
```

For standard MP4 URLs (Twitch CDN, HeyGen CDN, etc.) this works fine — `axios.get` streams the MP4 bytes to disk. For HLS `.m3u8` manifests it does NOT work — axios would download the ~2KB TEXT manifest file (a playlist of segment URLs), not the actual video segments. The resulting "MP4" on disk would be a broken text file that FFmpeg can't read.

**HLS requires FFmpeg to resolve** because FFmpeg natively supports the HLS protocol — given an `.m3u8` URL, `ffmpeg -i {url} -c copy output.mp4` downloads all the segments listed in the manifest, stitches them together, and produces a playable MP4.

Fix 9's `scrapeArticleVideo()` at `server.js:6222-6298` returns whatever `yt-dlp --dump-json` reports as the `url` field. For Brightcove, that's always an HLS manifest URL (Brightcove delivers on-demand videos as HLS, not direct MP4 download). So every Fix 9 URL will be `.m3u8` — and `downloadFile()` needs to handle that.

---

## The fix — two changes to `downloadFile()`

### Change 1 — Expand the trusted domains whitelist

Add 6 Brightcove / Al Jazeera entries:

```javascript
const trustedDomains = [
  'clips-media-assets',           // Twitch CDN
  'clips-media-assets2',          // Twitch CDN
  'production-assets',            // Twitch
  'cloudfront.net',               // AWS CloudFront (Twitch authenticated clips)
  'resource.heygencdn.com',       // HeyGen CDN
  'files2.heygen.ai',             // HeyGen temporary files
  'heygen.ai',                    // HeyGen (catch-all for subdomains)
  'storage.googleapis.com',       // Google Cloud Storage
  'drive.google.com',             // Google Drive
  // ── Fix 9b: Brightcove CDN for Al Jazeera News video scraping ──
  'boltdns.net',                  // Brightcove Bolt CDN (primary — substring matches manifest.prod.boltdns.net)
  'brightcove.net',               // Brightcove alternate CDN
  'brightcove.com',               // Brightcove primary domain (Playback API, etc.)
  'edge.api.brightcove.com',      // Brightcove Playback API (for future direct API calls)
  'aljazeera.com',                // Al Jazeera direct (defensive for edge cases)
  'aljazeera.net'                 // Al Jazeera alternate
];
```

**Whitelist matching is substring-based** (line 980: `trustedDomains.some(domain => url.includes(domain))`). `boltdns.net` will match any URL containing `boltdns.net`, including `manifest.prod.boltdns.net`, `origin.boltdns.net`, `cdn.boltdns.net`, etc. One substring entry covers all Brightcove Bolt CDN subdomains.

### Change 2 — Detect HLS URLs and handle them via FFmpeg

Add an HLS detection branch BEFORE the existing axios streaming logic:

```javascript
async function downloadFile(url, destPath) {
  // SSRF Protection: Validate URL is from trusted domains
  const trustedDomains = [
    // ... the expanded list from Change 1 ...
  ];

  const isTrusted = trustedDomains.some(domain => url.includes(domain));
  if (!isTrusted) {
    throw new Error(`URL blocked: not from trusted domain. URL: ${url.slice(0, 100)}`);
  }

  // ── Fix 9b: HLS manifest detection ──
  // Brightcove / Al Jazeera return .m3u8 manifest URLs that can't be
  // downloaded via naive axios streaming — the manifest is a ~2KB text
  // playlist referencing segment URLs. FFmpeg natively supports HLS
  // protocol and will resolve the manifest + download all segments +
  // stitch them into a playable MP4.
  const isHls = /\.m3u8(\?|$)/i.test(url) || /\/hls\//i.test(url);

  if (isHls) {
    console.log(`[downloadFile] HLS detected, using FFmpeg: ${url.slice(0, 80)}`);

    // Ensure destination has .mp4 extension (caller may have passed .ts or something else)
    const mp4Path = destPath.endsWith('.mp4') ? destPath : destPath.replace(/\.[^.]+$/, '.mp4');

    await new Promise((resolve, reject) => {
      const args = [
        '-i', url,                     // HLS manifest URL
        '-c', 'copy',                  // copy streams (no re-encode — fast)
        '-bsf:a', 'aac_adtstoasc',     // fix AAC bitstream for MP4 container
        '-movflags', '+faststart',
        '-y', mp4Path
      ];
      const proc = execFile(ffmpegPath(), args, {
        maxBuffer: 50 * 1024 * 1024,
        timeout: 180000     // 3 min max for HLS download
      });
      let stderr = '';
      proc.stderr && proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code === 0) {
          console.log(`[downloadFile] HLS → MP4 complete: ${path.basename(mp4Path)}`);
          resolve();
        } else {
          const reason = stderr.slice(-500).replace(/\n/g, ' ').trim();
          reject(new Error(`HLS download failed (FFmpeg exit ${code}): ${reason}`));
        }
      });
      proc.on('error', reject);
    });

    // Verify the output file exists and has non-trivial size
    if (!fs.existsSync(mp4Path) || fs.statSync(mp4Path).size < 10000) {
      throw new Error(`HLS output file invalid or too small: ${mp4Path}`);
    }

    // If caller asked for a different extension, copy the .mp4 to their requested path
    if (mp4Path !== destPath) {
      fs.copyFileSync(mp4Path, destPath);
    }

    return;
  }

  // ── Non-HLS: existing axios streaming path ──
  const writer = fs.createWriteStream(destPath);
  const resp   = await axios({ url, method: 'GET', responseType: 'stream', timeout: 120000 });
  resp.data.pipe(writer);
  return new Promise((res, rej) => {
    writer.on('finish', res);
    writer.on('error', rej);
  });
}
```

---

## Why this is backward compatible

**Non-HLS URLs are unchanged.** Twitch, HeyGen, Google Drive, and any other existing URLs that don't contain `.m3u8` or `/hls/` will hit the existing `axios` streaming path. The HLS branch only activates on Brightcove-style manifest URLs.

**The whitelist only adds entries** — existing trusted domains remain trusted. No existing functionality regresses.

**Failure handling is consistent** — HLS branch throws on FFmpeg failures with a descriptive error message, matching the existing SSRF block's error pattern. Callers of `downloadFile()` already handle exceptions gracefully (the assembly pipeline's segment download loop catches errors and marks segments as failed).

---

## Dependencies

**Already met:**
- `execFile` is already imported in server.js (used heavily for FFmpeg calls in assembly)
- `ffmpegPath()` helper exists at `server.js:994` and returns the FFmpeg binary path
- FFmpeg v8.1 is installed and working (verified via existing assembly runs)
- `fs` and `path` are already imported

**No new dependencies.**

---

## Verification

### Grep checks

```bash
# New domains present in whitelist
grep -n "boltdns.net\|brightcove.net" server.js
# Should have hits in the downloadFile trustedDomains array

# HLS detection branch present
grep -n "isHls\|HLS manifest\|HLS detected" server.js
# Should have hits in downloadFile

# Old whitelist error message still present (so the SSRF check still works for invalid URLs)
grep -n "URL blocked: not from trusted domain" server.js
# Should have 1 hit (unchanged error)
```

### Syntax check

```bash
node -c server.js
# exit 0
```

### Isolation test — HLS download works against a real Brightcove URL

Before committing, test the updated `downloadFile()` against the actual failing URL from smoke test #6:

```bash
# Extract the failing URL from the nodemon log or use a fresh scrape
# Example real URL from tonight's run:
URL="https://manifest.prod.boltdns.net/manifest/v1/hls/v3/clear/665003303001/7e8f7aa5-dd29-4309-8739-740e..."

# Direct FFmpeg test — verify HLS download works
ffmpeg -i "$URL" -c copy -bsf:a aac_adtstoasc -movflags +faststart -y /tmp/test_hls.mp4
ls -la /tmp/test_hls.mp4
ffprobe -v error -show_entries format=duration /tmp/test_hls.mp4
```

Expected: `/tmp/test_hls.mp4` exists with size > 100KB and a valid duration (probably 20-60 seconds for an Al Jazeera news clip).

If FFmpeg succeeds in terminal, the updated `downloadFile()` will succeed when called through the assembly pipeline.

### End-to-end verification — next News smoke test

After this commit ships, Rob runs News smoke test #7. Expected behavior:

1. **Fix 9 scraper still works** — `[news-scrape-video] ✅ ... → https://manifest.prod.boltdns.net/... (Xs)` per story
2. **`Got N/5 news video URLs`** — non-zero
3. **`Built News orderedClipUrls: N/5 stories have clip URLs`** — non-zero
4. **`Built segmentData: X segments (Y avatar + Z source_clips)`** — **Z > 0 for the first time in a COMPLETED assembly**
5. **Downstream segment download log shows:** `[downloadFile] HLS detected, using FFmpeg: ...` per clip
6. **`[downloadFile] HLS → MP4 complete: news_clip_X.mp4`** — successful FFmpeg resolution per clip
7. **Assembly completes with a non-zero clip count in the filename** (e.g., `22_avatar_3_clips` instead of `22_avatar_0_clips`)
8. **Gate 3 SOURCE CLIPS check PASSES** — because real clips are playing

---

## Commit strategy

```
fix(downloadFile): allow Brightcove CDN + handle HLS manifests via FFmpeg (Fix 9b)

Fix 9 (Al Jazeera video scraping, commit 8a908a0) successfully returned
real Brightcove HLS manifest URLs from yt-dlp, but downstream downloadFile()
at server.js:966 failed on them for two reasons:

1. SSRF whitelist didn't include Brightcove CDN domains (boltdns.net,
   brightcove.net, etc.) — every Fix 9 URL was blocked at the trust check
2. Naive axios.get streaming can't resolve HLS .m3u8 manifests — axios
   would download the ~2KB text playlist, not the actual video segments

Changes:
- server.js:968-978 — whitelist expanded with Brightcove + Al Jazeera
  entries: boltdns.net (primary — substring matches manifest.prod.boltdns.net),
  brightcove.net, brightcove.com, edge.api.brightcove.com, aljazeera.com,
  aljazeera.net
- server.js:985 — HLS detection branch added BEFORE the axios streaming path
  Detects .m3u8 or /hls/ URLs and routes to FFmpeg which natively supports
  the HLS protocol: ffmpeg -i {m3u8} -c copy -bsf:a aac_adtstoasc output.mp4
- Non-HLS URLs (Twitch, HeyGen, Google Drive) continue using the existing
  axios streaming path — backward compatible

Blocks unblocked:
- News smoke test #6/#7 now can actually download scraped clips
- Gate 3 SOURCE CLIPS check can meaningfully verify for News
- Filename will contain non-zero N_clips for the first time in a
  completed News assembly

Verification:
- Grep: boltdns.net in trustedDomains, isHls detection in downloadFile
- node -c server.js → exit 0
- Direct FFmpeg test against real Brightcove URL from smoke test #6
  succeeded in terminal before commit

References: LONGFORM_FIX_ROTATION.md News Wave 1 Fix 9 follow-up, smoke test #6
failure at asm_1776055054525
```

Per `COMMIT_CHECKLIST.md`:
1. Atomic staging: `git add server.js STATUS.md LONGFORM_FIX_ROTATION.md && git commit -m "..." && git push`
2. STATUS.md Last Agent Action row
3. LONGFORM_FIX_ROTATION.md — add Fix 9b entry in `✅ Shipped` with commit hash

---

## Rollback plan

```bash
git revert HEAD && git push
```

Revert restores the pre-Fix-9b state where News clips are blocked at the whitelist check. News smoke tests will continue producing `0_clips` files (same as before tonight). Safe.

---

## What this fix does NOT solve

1. **Fix 9's hit rate on mixed RSS feeds** — ~40% per Cline's earlier report. Fix 9b doesn't improve scraping hit rate; it only makes the scraped URLs usable downstream. Improving hit rate is a separate future task (prioritize `/video/` path articles, fall back to Ken Burns image-as-clip for stories with no video).
2. **Clip duration matching for News** — News's SETUP and SUMMARY scenes don't have a narration-to-clip-duration relationship like NBA Wave 2 enforced. News runs with real clips will have Bobby G's SETUP/SUMMARY playing sequentially around the clip, same as Twitch. If Bobby G's narration is longer or shorter than the clip, that's fine — the clip plays independently between SETUP and SUMMARY beats, no voiceover-style mixing.
3. **Script semantic alignment** — Fix 6's News Gemini prompt writes SUMMARY as "factual recap of what just played in the clip." With Fix 9 + Fix 9b finally producing real clips, this becomes semantically accurate for the first time. No additional prompt work needed.

---

## Why this matters

**Fix 9b is the final piece that makes Fix 9 actually work end-to-end.** Without it, Fix 9's scraper is producing correct data that gets thrown away by the downstream blocker. With it, News long-form finally has every piece of the creative set functional:

- Fix 5 — newscast-overlay route HTTP 200 ✅
- Fix 6 — News Gemini prompt non-repetitive ✅
- Fix 7 — newscast chrome RGBA alpha + logo on mug ✅
- Fix 8B — News top-right TV card with og:image ✅
- Fix 9 — Al Jazeera video scraping via JSON-LD + yt-dlp ✅
- **Fix 9b — Brightcove whitelist + HLS download via FFmpeg ← THIS HANDOFF**

After this lands, News smoke test #7 should be the first News long-form run where every creative element Rob designed tonight actually appears in the final assembled MP4.

---

## Checklist for Cline

- [ ] `server.js:968-978` trustedDomains array expanded with 6 Brightcove/Al Jazeera entries
- [ ] `server.js:985` HLS detection branch added before the existing axios streaming path
- [ ] `execFile`, `ffmpegPath`, `fs.existsSync`, `fs.statSync`, `fs.copyFileSync` all already imported — no new imports needed
- [ ] `node -c server.js` exit 0
- [ ] Nodemon clean restart
- [ ] Direct terminal test: `ffmpeg -i <real Brightcove URL from tonight's log> -c copy ...` succeeds, produces a playable MP4 > 100KB
- [ ] Grep checks pass (see Verification section)
- [ ] STATUS.md + LONGFORM_FIX_ROTATION.md updated (Fix 9b entry in Shipped)
- [ ] Atomic commit via chained `git add && git commit && git push`
- [ ] Commit hash reported back
