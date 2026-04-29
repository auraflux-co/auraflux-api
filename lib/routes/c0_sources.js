'use strict';
// C0-ONLY — Content source scraping: Twitch, NBA (ESPN), News (Al Jazeera)
// None of these routes belong on C1+ — they are hardcoded to specific sports/news
// sources and C0 production workflows.
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const { execFile } = require('child_process');
const { ffmpegPath: _ffmpegDockerPath } = require('../ffmpeg_utils');
const { withPuppeteerExecutable } = require('../services/puppeteer_utils');
const { downloadFile, downloadVideoForAnalysis } = require('../downloader');
const TwitchClient = require('../clients/twitch_client');
const { requireFields, validateContentType, validateArrayLength } = require('../validation');
const { body, validationResult } = require('express-validator');

const ROOT_DIR = path.join(__dirname, '..', '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');
const TMP_DIR = path.join(ROOT_DIR, 'tmp');

function ffmpegPath() {
  return _ffmpegDockerPath();
}

/**
 * Scrape ESPN game page for HLS manifest URL using Puppeteer.
 * ESPN uses BAMGrid/Hive player on Akamai CDN (not Brightcove).
 * HLS manifests are at service-pkgespn.akamaized.net/opp/cmaf/espn/.../*.m3u8
 * @param {string} gameId
 * @returns {Promise<{videoUrl: string, duration?: number, title?: string} | null>}
 */
async function scrapeEspnGameVideoUrl(gameId) {
  const gamePageUrl = `https://www.espn.com/nba/video/_/gameId/${gameId}`;
  let capturedHlsUrl = null;
  let browser;

  try {
    browser = await puppeteer.launch(
      withPuppeteerExecutable({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      })
    );
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', (req) => req.continue());
    page.on('response', async (resp) => {
      const url = resp.url();
      // ESPN uses service-pkgespn.akamaized.net for HLS manifests
      if (url.includes('service-pkgespn.akamaized.net') && url.includes('.m3u8')) {
        capturedHlsUrl = url;
        console.log(`[nba-scrape] HLS manifest captured: ${url.slice(0, 80)}...`);
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.goto(gamePageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Scroll to trigger lazy-loaded video player
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await new Promise((r) => setTimeout(r, 600));
    }

    // Wait up to 5s for HLS manifest intercept
    for (let i = 0; i < 10 && !capturedHlsUrl; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }

    await browser.close();
    browser = null;

    if (capturedHlsUrl) {
      console.log(
        `[nba-scrape] Puppeteer HLS captured for ${gameId}: ${capturedHlsUrl.slice(0, 80)}...`
      );
      return { videoUrl: capturedHlsUrl };
    }
  } catch (e) {
    console.warn(`[nba-scrape] Puppeteer fallback failed for ${gameId}: ${e.message}`);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
  }

  return null;
}

// downloadEspnVideo — thin wrapper around the universal downloader
// Keeping this name so existing callers don't need changes.
async function downloadEspnVideo(url, outPath) {
  return downloadVideoForAnalysis(url, outPath, { maxSecs: 90 });
}

// ── GET /nba/game-clips/:gameId ────────────────────────────────────
// Returns ALL available clips for a game from ESPN Summary API.
// Used by the dashboard short-form clip picker to show the full menu.
// ── GET /twitch/clips-pool ────────────────────────────────────────────────────
// Returns recent clip metadata (thumbnails, titles, durations) for a list of
// streamers. Used by the dashboard short-form clip picker — no MP4 resolution,
// just Helix API metadata so the UI loads fast.
router.get('/twitch/clips-pool', async (req, res) => {
  const streamersParam = (req.query.streamers || '').trim();
  const clipsPerStreamer = Math.max(1, Math.min(10, parseInt(req.query.clipsPerStreamer) || 3));
  if (!streamersParam) return res.status(400).json({ error: 'streamers query param required' });

  const streamerList = streamersParam
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!streamerList.length) return res.status(400).json({ error: 'no streamers provided' });

  const clientId = process.env.TWITCH_CLIENT_ID;
  const token = process.env.TWITCH_TOKEN;
  if (!clientId || !token)
    return res.status(500).json({ error: 'TWITCH_CLIENT_ID / TWITCH_TOKEN not set' });

  try {
    // Resolve user IDs in one batch call
    const userResp = await axios.get(
      `https://api.twitch.tv/helix/users?${streamerList.map((s) => `login=${s}`).join('&')}`,
      { headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    const users = userResp.data?.data || [];

    // Fetch recent clips for each resolved user in parallel
    const allClips = (
      await Promise.all(
        users.map(async (user) => {
          try {
            const clipsResp = await axios.get(
              `https://api.twitch.tv/helix/clips?broadcaster_id=${user.id}&first=${clipsPerStreamer}`,
              {
                headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` },
                timeout: 10000,
              }
            );
            return (clipsResp.data?.data || []).map((c) => ({
              streamer: user.display_name || user.login,
              title: c.title || 'Clip',
              thumbnail: c.thumbnail_url || '',
              duration: Math.round(c.duration || 0),
              url: c.url || '',
              slug: c.id || '',
              game: c.game_id || '',
              viewCount: c.view_count || 0,
            }));
          } catch (e) {
            console.warn(`[twitch/clips-pool] Failed for ${user.login}: ${e.message}`);
            return [];
          }
        })
      )
    ).flat();

    res.json({ ok: true, clips: allClips });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /nba/game-clips/:gameId ────────────────────────────────────────────────
router.get('/nba/game-clips/:gameId', async (req, res) => {
  const { gameId } = req.params;
  if (!gameId) return res.status(400).json({ error: 'gameId required' });
  try {
    const summaryUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`;
    const summaryResp = await axios.get(summaryUrl, { timeout: 10000 });
    const summaryData = summaryResp.data;

    const articleVideos = Array.isArray(summaryData.article?.video)
      ? summaryData.article.video
      : summaryData.article?.video
        ? [summaryData.article.video]
        : [];
    const topVideos = summaryData.videos || [];
    const all = [...topVideos, ...articleVideos];

    const clips = all
      .map((v) => {
        const src = v.links?.source || {};
        const url = src.HLS?.HD?.href || src.HLS?.href || src.HD?.href || src.mezzanine?.href || '';
        if (!url) return null;
        return {
          headline: v.headline || v.title || 'Clip',
          duration: v.duration || 0,
          url,
          thumbnail: (typeof v.thumbnail === 'string' ? v.thumbnail : v.thumbnail?.href) || '',
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.duration - a.duration);

    res.json({ ok: true, gameId, clips });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /nba/scrape-game-highlight ─────────────────────────────────
// Scrapes the ESPN game page for the video with the highest duration
// User requirement: "video on that page with the highest duration--top left of the game_id page"
router.post('/nba/scrape-game-highlight', async (req, res) => {
  const { gameId, formType } = req.body;
  if (!gameId) return res.status(400).json({ error: 'gameId required' });
  // Short-form clips need 30-90s for split-screen. Long-form uses any duration ≥ 10s.
  const isShortFormRequest = formType === 'short';
  const minDurationSecs = isShortFormRequest ? 30 : 10;
  const maxDurationSecs = isShortFormRequest ? 90 : null;

  try {
    console.log(`[nba-scrape] Fetching highlights for gameId: ${gameId} via ESPN Summary API`);

    // Primary path: ESPN Summary API — returns Akamai HLS URLs (stable, no expiry)
    // article.video = compiled highlights reel (87-115s) — not always present
    // d.videos = individual play clips + highlights — longest duration = highlights reel
    // Puppeteer removed: d.videos Akamai HLS is reliable and doesn't require a browser
    const summaryUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`;
    const summaryResp = await axios.get(summaryUrl, { timeout: 10000 });
    const summaryData = summaryResp.data;

    // Check article.video first — this is where the compiled highlights reel lives
    const articleVideos = (summaryData.article && summaryData.article.video) || [];
    if (articleVideos.length) {
      const highlight = articleVideos[0]; // First is always the Game Highlights reel
      // Prefer Akamai HLS manifest (stable, no expiring token) over direct CDN MP4 (expires in seconds)
      const hlsUrl = highlight.links?.source?.HLS?.HD?.href || highlight.links?.source?.HLS?.href;
      const directMp4 = highlight.links?.source?.HD?.href;
      const hlUrl = hlsUrl || directMp4;
      if (hlUrl) {
        console.log(
          `[nba-scrape] ✅ Gate 0 PASS: Game Highlights from article.video: "${highlight.headline}" (${highlight.duration}s) [${hlsUrl ? 'HLS' : 'direct MP4'}]`
        );
        // Download immediately — ESPN CDN URLs expire within seconds
        const tmpPathAv = path.join(ROOT_DIR, 'tmp', `nba_highlight_${gameId}_${Date.now()}.mp4`);
        let localPathAv = null;
        try {
          localPathAv = await downloadEspnVideo(hlUrl, tmpPathAv);
        } catch (e) {
          console.warn(`[nba-scrape] Download failed (will use URL fallback): ${e.message}`);
        }
        return res.json({
          ok: true,
          gate0: 'pass',
          gameId,
          videoUrl: hlUrl,
          localPath: localPathAv,
          thumbnail: (highlight.thumbnail && highlight.thumbnail.href) || '',
          title: highlight.headline || 'Game Highlights',
          description: highlight.description || '',
          duration: highlight.duration || 0,
          source: 'article.video',
        });
      }
    }

    // Step 3: Fall back to play clips (d.videos) — longest duration
    console.warn(
      `[nba-scrape] ⚠️ article.video empty — falling back to API play clips (longest duration)`
    );
    const videos = summaryData.videos || [];

    if (!videos.length) {
      // Gate 0 FAIL: Puppeteer failed and API has no videos either
      return res.json({
        ok: false,
        gate0: 'fail',
        error: `No videos found for game ${gameId} — video page Puppeteer failed and ESPN API returned empty videos[]. Game may be too recent or too old.`,
      });
    }

    console.log(
      `[nba-scrape] Found ${videos.length} API play clips for game ${gameId} — selecting ${isShortFormRequest ? 'best 30-90s clip for short-form' : 'longest clip for long-form'}`
    );

    // Step 2: Use full video pool — select best clip based on form type.
    // Long-form: select longest duration (game highlights reel is reliably longest at 115s).
    // Short-form: prefer clips in 30-90s range for split-screen; fall back to longest if none in range.
    // Keyword filtering on API metadata was removed: ESPN titles don't contain "highlight"
    // even when the page shows "Game Highlights", so the filter always returned 0 matches.
    const videoPool = videos;
    console.log(`[nba-scrape]   Using full pool of ${videoPool.length} videos`);

    // Step 3: Find best video — prefer 30-90s range for short-form, longest for long-form
    let highestDurationVideo = null;
    let maxDuration = 0;
    let shortFormPreferred = null; // best clip in 30-90s range for short-form

    for (const video of videoPool) {
      const duration = video.duration || 0;
      const title = video.headline || video.title || video.description || '';

      console.log(`[nba-scrape]   Video: "${title}" (${duration}s)`);

      // Track the longest clip (long-form selection + short-form fallback)
      if (duration > maxDuration) {
        maxDuration = duration;
        highestDurationVideo = video;
      }

      // Track best clip in 30-90s range for short-form (prefer longer within range)
      if (isShortFormRequest && duration >= minDurationSecs && duration <= maxDurationSecs) {
        if (!shortFormPreferred || duration > (shortFormPreferred.duration || 0)) {
          shortFormPreferred = video;
        }
      }
    }

    // Short-form: use preferred 30-90s clip if found, otherwise fall back to longest
    if (isShortFormRequest && shortFormPreferred) {
      highestDurationVideo = shortFormPreferred;
      maxDuration = shortFormPreferred.duration || 0;
      console.log(`[nba-scrape] Short-form: selected ${maxDuration}s clip in target 30-90s range`);
    } else if (isShortFormRequest) {
      console.warn(
        `[nba-scrape] Short-form: no clip in 30-90s range found — falling back to longest (${maxDuration}s)`
      );
    }

    if (!highestDurationVideo) {
      console.warn(`[nba-scrape] No valid video with duration found`);
      return res.json({
        ok: false,
        gate0: 'fail',
        error: `No video with duration >0 found for game ${gameId} — ESPN may not have processed highlights yet.`,
      });
    }

    // Step 4: Extract best quality video URL — prefer Akamai HLS (stable, no expiry)
    // over direct CDN MP4 (expires within seconds of being generated)
    const links = highestDurationVideo.links || {};
    const source = links.source || {};
    let videoUrl =
      source.HLS?.HD?.href ||
      source.HLS?.href ||
      source.HD?.href ||
      source.mezzanine?.href ||
      source.full?.href ||
      source.href ||
      links.mobile?.href ||
      '';

    // Gate 0: Validate the selected URL is usable
    // Puppeteer already ran first and failed, so no further fallback is available.
    if (!videoUrl) {
      console.error(`[nba-scrape] Gate 0 FAIL: No usable video URL found for game ${gameId}`);
      return res.json({
        ok: false,
        gate0: 'fail',
        error: `No valid highlight clip URL found for game ${gameId} — Puppeteer failed and API returned metadata but no downloadable URL. Check ESPN API response at: ${summaryUrl}`,
      });
    }

    // Gate 0: Validate duration meets minimum threshold (30s for short-form, 10s for long-form)
    if (maxDuration > 0 && maxDuration < minDurationSecs) {
      console.warn(
        `[nba-scrape] Gate 0 WARN: Best video for game ${gameId} is only ${maxDuration}s — below ${minDurationSecs}s minimum (formType: ${formType || 'long'})`
      );
      return res.json({
        ok: false,
        gate0: 'fail',
        error: `No valid highlight clips found for game ${gameId} — longest clip is only ${maxDuration}s (minimum: ${minDurationSecs}s for ${isShortFormRequest ? 'short-form' : 'long-form'})`,
      });
    }

    // Also extract thumbnail
    const thumbnail = highestDurationVideo.thumbnail || '';

    console.log(
      `[nba-scrape] ✅ Gate 0 PASS: Selected longest duration video: "${highestDurationVideo.headline || highestDurationVideo.title || 'Game Highlights'}" (${maxDuration}s)`
    );
    console.log(`[nba-scrape]    URL: ${videoUrl.slice(0, 80)}...`);

    // Download immediately — ESPN CDN URLs expire within seconds
    const tmpPathApi = path.join(ROOT_DIR, 'tmp', `nba_highlight_${gameId}_${Date.now()}.mp4`);
    let localPathApi = null;
    try {
      const { execFile } = require('child_process');
      const ffmpegBin = ffmpegPath();
      const ffmpegArgs = [
        '-i',
        videoUrl,
        '-t',
        '90',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '28',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        '-y',
        tmpPathApi,
      ];
      await new Promise((resolve, reject) => {
        execFile(ffmpegBin, ffmpegArgs, { timeout: 120000 }, (err) =>
          err ? reject(err) : resolve()
        );
      });
      const sizeApi = fs.existsSync(tmpPathApi) ? fs.statSync(tmpPathApi).size : 0;
      if (sizeApi > 1000) {
        localPathApi = tmpPathApi;
        console.log(
          `[nba-scrape] ✅ Downloaded highlight to ${tmpPathApi} (${(sizeApi / 1024 / 1024).toFixed(1)}MB)`
        );
      }
    } catch (e) {
      console.warn(`[nba-scrape] Download failed (will use URL fallback): ${e.message}`);
    }

    res.json({
      ok: true,
      gate0: 'pass',
      gameId,
      videoUrl,
      localPath: localPathApi,
      thumbnail,
      title: highestDurationVideo.headline || highestDurationVideo.title || 'Game Highlights',
      description: highestDurationVideo.description || '',
      duration: maxDuration,
      videoCount: videos.length,
      source: 'api',
    });
  } catch (err) {
    console.error(`[nba-scrape] Error:`, err.message);
    res.status(500).json({ error: err.message, gate0: 'error' });
  }
});

// ── GET /news/us-canada-videos ────────────────────────────────────
// Scrapes Al Jazeera with US & Canada editorial priority: hub page links first,
// then /us-canada/… sitemap URLs, then other sitemap articles (excludes /features/, /opinion/, /longform/).
// Returns 100% video-guaranteed stories (vs ~20-30% hit rate from global RSS feed).
// Supports NEWS_RSS_URL env var override for future RSS.app migration (Fix 30).
//
// Response: { ok, source, lookbackHours, totalFound, recentCount, videos[] }
// Each video: { url, href, title, thumbnail, publishedAt, dateString }

const NEWS_SOURCE_URL = process.env.NEWS_RSS_URL || 'https://www.aljazeera.com/us-canada/';
const NEWS_LOOKBACK_HOURS = 48; // Red 4 hotfix 2: was 24, extended to 48 to handle midnight-UTC edge case where AJ URL dates are parsed as start-of-day and every story becomes "25 hours old" after UTC midnight rolls. Paired with end-of-day timestamp parse below at line 5800.

// ── Track C: per-video validation pass ───────────────────────────────────────
// 5 checks run in parallel per video before the dashboard renders story cards.
// Results flow back as video.validation = { status, checks, issues[] }
// status: 'ok' | 'warning' | 'fail'
async function validateVideo(v) {
  const checks = {};
  const issues = [];

  // Check 1: Brightcove URL reachable (HEAD, 3s timeout)
  try {
    const headResp = await axios.head(v.url, { timeout: 3000, maxRedirects: 3 });
    checks.brightcoveReachable = headResp.status < 400;
    if (!checks.brightcoveReachable) issues.push(`Article URL returned HTTP ${headResp.status}`);
  } catch (e) {
    checks.brightcoveReachable = false;
    issues.push(`Article URL unreachable: ${e.message}`);
  }

  // Check 2: scrapeArticleVideo() full Fix 9 flow — fetch article HTML, extract
  // JSON-LD VideoObject.embedUrl (Brightcove player URL), run yt-dlp on the
  // Brightcove URL (NOT the article URL — yt-dlp doesn't support AJ article URLs
  // directly and always returns "Unsupported URL"). This is the correct pattern
  // per Fix 9's scrapeArticleVideo() helper at server.js:6710.
  //
  // Red 4 hotfix 3: Track C was calling yt-dlp directly on the article URL,
  // which fails 100% of the time because AJ /video/newsfeed/ URLs are not a
  // supported yt-dlp extractor target. Every video was marked fail on ytdlpExtract
  // regardless of actual content. Fix: reuse scrapeArticleVideo() which handles
  // the JSON-LD intermediate step.
  let hlsUrl = null;
  try {
    hlsUrl = await scrapeArticleVideo(v.url);
    checks.ytdlpExtract = !!hlsUrl;
    if (!hlsUrl)
      issues.push(
        'scrapeArticleVideo returned null (no Brightcove embed or yt-dlp failed on embed URL)'
      );
  } catch (e) {
    checks.ytdlpExtract = false;
    issues.push(`scrapeArticleVideo failed: ${e.message}`);
  }

  // Check 3 & 4: dimensions and duration are SKIPPED in Track C v1.
  // The old code path tried to read them from yt-dlp JSON output, but
  // scrapeArticleVideo() returns only the HLS manifest URL (not metadata).
  // To get dimensions/duration we'd need an additional ffprobe call on the
  // HLS manifest, which adds latency per-video. Deferred to Track C v2.
  //
  // For now: if scrapeArticleVideo() returned a non-null URL, treat dimensions
  // and duration as "passed by absence of evidence" — the article HAS a video,
  // which is the only thing that truly matters for the selection gate.
  checks.dimensionsOk = hlsUrl ? null : false;
  checks.durationOk = hlsUrl ? null : false;

  // Check 5: og:image reachable (HEAD, 3s timeout)
  if (v.thumbnail) {
    try {
      const imgResp = await axios.head(v.thumbnail, { timeout: 3000, maxRedirects: 3 });
      checks.ogImageReachable = imgResp.status < 400;
      if (!checks.ogImageReachable) issues.push(`og:image returned HTTP ${imgResp.status}`);
    } catch (e) {
      checks.ogImageReachable = false;
      issues.push(`og:image unreachable: ${e.message}`);
    }
  } else {
    checks.ogImageReachable = null; // no thumbnail to check
  }

  // Derive overall status
  const hasFail =
    checks.brightcoveReachable === false ||
    checks.ytdlpExtract === false ||
    checks.durationOk === false;
  const hasWarning =
    checks.dimensionsOk === false ||
    checks.durationOk === 'warning' ||
    checks.ogImageReachable === false;
  const status = hasFail ? 'fail' : hasWarning ? 'warning' : 'ok';

  return { ...v, validation: { status, checks, issues } };
}

// ── AJ Sitemap-driven article discovery ──────────────────────────────────────
// Fetches Al Jazeera's per-day sitemap XML, filters to US-topic news articles.
// Excludes: /liveblog/ /video/ /longform/ /podcasts/ (no video or wrong format)
// Returns array of article URL strings.
async function fetchAjSitemapUrls(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const sitemapUrl = `https://www.aljazeera.com/sitemap.xml?yyyy=${yyyy}&mm=${mm}&dd=${dd}`;

  console.log(`[fetchAjSitemapUrls] Fetching ${sitemapUrl}`);
  const resp = await axios.get(sitemapUrl, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CWN/1.0)' },
  });

  const xml = resp.data || '';
  // Extract all <loc> URLs from the sitemap XML
  const locMatches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
  const allUrls = locMatches
    .map((m) => m.replace(/<\/?loc>/g, '').trim())
    .filter((u) => u.startsWith('https://www.aljazeera.com/'));

  // Exclude non-article paths — return ALL remaining articles (no topic keyword filter)
  const EXCLUDE_PATHS = ['/liveblog/', '/video/', '/longform/', '/podcasts/', '/program/'];
  const articleUrls = allUrls.filter((u) => !EXCLUDE_PATHS.some((p) => u.includes(p)));

  console.log(
    `[fetchAjSitemapUrls] ${allUrls.length} total → ${articleUrls.length} articles (all topics)`
  );
  return articleUrls;
}

/**
 * Collect article URLs linked from the US & Canada hub (editorial queue), excluding /features/ etc.
 * @returns {Promise<string[]>}
 */
const AJ_ALLOWED_SECTION_PATH_RE = /\/(where\/united-states|us-canada)\//i;

/** Dated article slug: /news/2026/4/22/… or /where/united-states/…/2026/…/… */
function ajArticleHasDatedSlugPath(pathname) {
  return /\/\d{4}\/\d{1,2}\/\d{1,2}\/[^/]+/i.test(pathname || '');
}

function ajAljazeeraArticleBaseOk(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  let p;
  try {
    p = new URL(urlStr).pathname || '';
  } catch {
    return false;
  }
  if (!/^https:\/\/(www\.)?aljazeera\.com\//i.test(urlStr)) return false;
  if (/\/(features|opinion|longform|podcasts|program|gallery)\b/i.test(p)) return false;
  if (!ajArticleHasDatedSlugPath(p)) return false;
  return true;
}

/**
 * Sitemap (and Gemini recovery): only URLs whose path is explicitly US/Canada editorial.
 * Do NOT use bare /news/… from the sitemap — those are global and not US-first.
 */
function ajArticlePathFromSitemapStrict(urlStr) {
  if (!ajAljazeeraArticleBaseOk(urlStr)) return false;
  try {
    return AJ_ALLOWED_SECTION_PATH_RE.test(new URL(urlStr).pathname || '');
  } catch {
    return false;
  }
}

/**
 * Hub queues (where/united-states + us-canada landing pages): allow /news/YYYY/MM/DD/…
 * because those links are curated on those pages (US-first queue), not raw sitemap.
 */
function ajArticlePathFromHubQueues(urlStr) {
  if (!ajAljazeeraArticleBaseOk(urlStr)) return false;
  let p;
  try {
    p = new URL(urlStr).pathname || '';
  } catch {
    return false;
  }
  return AJ_ALLOWED_SECTION_PATH_RE.test(p) || /\/news\//i.test(p);
}

async function fetchAjHubArticleUrls(hubUrl, maxUrls = 45) {
  const hub = String(hubUrl || '')
    .trim()
    .replace(/\/?$/, '/');
  if (!hub) return [];
  const resp = await axios.get(hub, {
    timeout: 25000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });
  const $ = cheerio.load(resp.data || '');
  const out = [];
  const badPath = (p) =>
    /\/(features|opinion|longform|podcasts|program|gallery|sport|sports)\b/i.test(p);
  const looksArticle = (p) =>
    ajArticleHasDatedSlugPath(p) && (AJ_ALLOWED_SECTION_PATH_RE.test(p) || /\/news\//i.test(p));
  $('a[href]').each((_, el) => {
    if (out.length >= maxUrls) return false;
    const href = ($(el).attr('href') || '').trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    let abs;
    try {
      abs = new URL(href, 'https://www.aljazeera.com').href.split('#')[0];
    } catch {
      return;
    }
    let p;
    try {
      const u = new URL(abs);
      if (!/aljazeera\.com$/i.test(u.hostname || '')) return;
      p = u.pathname || '';
    } catch {
      return;
    }
    if (badPath(p)) return;
    if (!looksArticle(p)) return;
    out.push(abs);
  });
  const uniq = [...new Set(out)];
  console.log(`[fetchAjHubArticleUrls] ${uniq.length} article URL(s) from ${hub}`);
  return uniq;
}

/** ffprobe HLS / MP4 duration (seconds); null on failure. */
function probeHlsDurationSeconds(hlsUrl) {
  return new Promise((resolve) => {
    try {
      execFile(
        ffprobePath(),
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          hlsUrl,
        ],
        { timeout: 35000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const d = parseFloat(String(stdout || '').trim(), 10);
          resolve(Number.isFinite(d) ? d : null);
        }
      );
    } catch {
      resolve(null);
    }
  });
}

/** ffprobe HLS / MP4 stream dimensions; returns {width,height} or null on failure. */
/**
 * Brightcove master playlists list multiple RESOLUTION=WxH variants; the in-page embed
 * is often 16:9 while a 9:16 rendition exists. Pick the highest-area portrait variant URL.
 * @returns {Promise<{ hlsUrl: string, orientation: 'portrait'|'landscape', sourceWidth: number, sourceHeight: number }|null>}
 */
async function pickPortraitOrLargestVariantFromHlsMaster(masterHlsUrl) {
  if (!masterHlsUrl || typeof masterHlsUrl !== 'string') return null;
  try {
    const resp = await axios.get(masterHlsUrl, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CWN/1.0)' },
    });
    const text = String(resp.data || '');
    if (!text.includes('#EXTM3U')) return null;
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const variants = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      const resM = line.match(/RESOLUTION=(\d+)x(\d+)/i);
      const bwM = line.match(/BANDWIDTH=(\d+)/i);
      const uriLine = lines[i + 1];
      if (!resM || !uriLine || uriLine.startsWith('#')) continue;
      const w = parseInt(resM[1], 10);
      const h = parseInt(resM[2], 10);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
      let variantUrl = uriLine;
      if (!/^https?:\/\//i.test(variantUrl)) {
        try {
          variantUrl = new URL(variantUrl, masterHlsUrl).href;
        } catch {
          continue;
        }
      }
      variants.push({
        w,
        h,
        bandwidth: bwM ? parseInt(bwM[1], 10) : 0,
        url: variantUrl,
      });
    }
    if (variants.length === 0) return null;
    const portrait = variants.filter((v) => v.h > v.w);
    if (portrait.length > 0) {
      portrait.sort((a, b) => b.w * b.h - a.w * a.h);
      const best = portrait[0];
      return {
        hlsUrl: best.url,
        orientation: 'portrait',
        sourceWidth: best.w,
        sourceHeight: best.h,
      };
    }
    variants.sort((a, b) => b.w * b.h - a.w * a.h);
    const best = variants[0];
    return {
      hlsUrl: masterHlsUrl,
      orientation: 'landscape',
      sourceWidth: best.w,
      sourceHeight: best.h,
    };
  } catch {
    return null;
  }
}

function probeHlsDimensions(hlsUrl) {
  return new Promise((resolve) => {
    try {
      execFile(
        ffprobePath(),
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=width,height',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          hlsUrl,
        ],
        { timeout: 35000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const lines = String(stdout || '')
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (lines.length < 2) return resolve(null);
          const width = parseInt(lines[0], 10);
          const height = parseInt(lines[1], 10);
          if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            return resolve(null);
          }
          resolve({ width, height });
        }
      );
    } catch {
      resolve(null);
    }
  });
}

/** Strip #fragment so Puppeteer navigates to a stable document URL. */
function stripAjPageFragment(url) {
  if (!url || typeof url !== 'string') return url;
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

/**
 * Extra AJ pages to try first in scrapeAjNewsVideos (sitemap excludes /video/… paths).
 * Set NEWS_AJ_PINNED_URLS= (empty) or "off" to disable built-in example.
 * @returns {string[]}
 */
function getPinnedAjUrlsForScraper() {
  const raw = process.env.NEWS_AJ_PINNED_URLS;
  if (raw !== undefined) {
    const t = String(raw).trim();
    if (t === '' || t === '0' || t.toLowerCase() === 'off' || t.toLowerCase() === 'false')
      return [];
    return t
      .split(/[\n,]+/)
      .map((s) => stripAjPageFragment(s.trim()))
      .filter(Boolean);
  }
  // Default: no pinned URLs — discovery is US-Canada hub + /us-canada/ sitemap paths first.
  return [];
}

// ── AJ Puppeteer video scraper ────────────────────────────────────────────────
// Opens a Puppeteer browser, walks sitemap articles in order (today first, then
// yesterday as fallback), intercepts Brightcove API network responses to capture
// HLS URLs directly, checks manifest dimensions.
// Stops as soon as targetCount confirmed videos are found (no hard article cap).
// Returns array of { articleUrl, videoId, hlsUrl, orientation, pillarboxFilter }
// orientation: 'landscape' (16:9) | 'portrait' (9:16)
// pillarboxFilter: null for landscape, FFmpeg filter string for portrait
//
// Brightcove account: 665003303001
// HLS served at manifest.prod.boltdns.net
// forcedCandidates: optional URL list (e.g. Gemini recovery) — merged after pinned URLs
async function scrapeAjNewsVideos(targetCount = 5, forcedCandidates = null) {
  const puppeteer = require('puppeteer');
  const results = [];

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  let candidateUrls = [];
  if (Array.isArray(forcedCandidates) && forcedCandidates.length > 0) {
    candidateUrls = forcedCandidates.map((u) => stripAjPageFragment(String(u))).filter(Boolean);
    console.log(`[scrapeAjNewsVideos] Using ${candidateUrls.length} forced candidate URL(s)`);
  } else {
    try {
      const [todayUrls, yestUrls] = await Promise.all([
        fetchAjSitemapUrls(today),
        fetchAjSitemapUrls(yesterday),
      ]);
      const mergedSitemap = [...todayUrls, ...yestUrls];
      const sitemapWhereUs = mergedSitemap.filter((u) => /\/where\/united-states\//i.test(u));
      const sitemapUsCanada = mergedSitemap.filter((u) => /\/us-canada\//i.test(u));
      const sitemapAllowed = mergedSitemap.filter(
        (u) =>
          AJ_ALLOWED_SECTION_PATH_RE.test(u) &&
          !/\/features\//i.test(u) &&
          !/\/opinion\//i.test(u) &&
          !/\/longform\//i.test(u)
      );
      const primaryHubUrl =
        process.env.NEWS_US_PRIMARY_HUB_URL || 'https://www.aljazeera.com/where/united-states/';
      const fallbackHubUrl =
        process.env.NEWS_US_CANADA_HUB_URL || 'https://www.aljazeera.com/us-canada/';
      let primaryHubUrls = [];
      let fallbackHubUrls = [];
      try {
        primaryHubUrls = await fetchAjHubArticleUrls(primaryHubUrl, 50);
      } catch (e) {
        console.warn(
          `[scrapeAjNewsVideos] Primary hub fetch failed (${primaryHubUrl}): ${e.message}`
        );
      }
      try {
        fallbackHubUrls = await fetchAjHubArticleUrls(fallbackHubUrl, 50);
      } catch (e) {
        console.warn(
          `[scrapeAjNewsVideos] Fallback hub fetch failed (${fallbackHubUrl}): ${e.message}`
        );
      }
      const seen = new Set();
      const pushOrder = (arr) => {
        for (const u of arr) {
          if (!seen.has(u)) {
            seen.add(u);
            candidateUrls.push(u);
          }
        }
      };
      candidateUrls = [];
      pushOrder(primaryHubUrls);
      pushOrder(fallbackHubUrls);
      pushOrder(sitemapWhereUs);
      pushOrder(sitemapUsCanada);
      pushOrder(
        sitemapAllowed.filter(
          (u) => !/\/where\/united-states\//i.test(u) && !/\/us-canada\//i.test(u)
        )
      );
      const hubUrlSet = new Set(
        [...primaryHubUrls, ...fallbackHubUrls].map((u) => stripAjPageFragment(String(u)))
      );
      candidateUrls = candidateUrls
        .map((u) => stripAjPageFragment(String(u)))
        .filter((u) => {
          if (!u) return false;
          if (hubUrlSet.has(u)) return ajArticlePathFromHubQueues(u);
          return ajArticlePathFromSitemapStrict(u);
        });
      console.log(
        `[scrapeAjNewsVideos] Candidate order: primaryHub=${primaryHubUrls.length}, fallbackHub=${fallbackHubUrls.length}, ` +
          `sitemap where/united-states=${sitemapWhereUs.length}, sitemap /us-canada/=${sitemapUsCanada.length}, ` +
          `US-first filter (hub=/news|section, sitemap=section only) → ${candidateUrls.length} URL(s)`
      );
    } catch (e) {
      console.warn(`[scrapeAjNewsVideos] Sitemap fetch error: ${e.message}`);
      return [];
    }
  }

  const pinned = getPinnedAjUrlsForScraper();
  if (pinned.length) {
    const seen = new Set(pinned);
    const tail = candidateUrls.filter((u) => !seen.has(u));
    candidateUrls = [...pinned, ...tail];
    console.log(
      `[scrapeAjNewsVideos] Prepended ${pinned.length} pinned URL(s) (NEWS_AJ_PINNED_URLS)`
    );
  }

  if (candidateUrls.length === 0) {
    console.warn('[scrapeAjNewsVideos] No candidate URLs (sitemap + pinned empty)');
    return [];
  }

  console.log(`[scrapeAjNewsVideos] Scanning for ${targetCount} videos (no article cap)...`);

  const browser = await puppeteer.launch(
    withPuppeteerExecutable({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
  );

  try {
    for (const articleUrl of candidateUrls) {
      // Stop as soon as we have enough confirmed videos
      if (results.length >= targetCount) break;

      let capturedHls = null;
      let capturedVideoId = null;

      const page = await browser.newPage();
      try {
        // Spoof a real browser UA so AJ doesn't serve a bot-detection page
        await page.setUserAgent(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );
        // Pre-accept GDPR/consent so the wall doesn't stall the page load
        await page.setCookie(
          {
            name: 'OptanonAlertBoxClosed',
            value: new Date().toISOString(),
            domain: '.aljazeera.com',
            path: '/',
          },
          {
            name: 'OptanonConsent',
            value:
              'isGpcEnabled=0&datestamp=' +
              encodeURIComponent(new Date().toISOString()) +
              '&version=202209.1.0&isIABGlobal=false&hosts=&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A1&AwaitingReconsent=false',
            domain: '.aljazeera.com',
            path: '/',
          }
        );
        // Intercept requests: block heavy assets to speed up load, let Brightcove API through
        await page.setRequestInterception(true);
        const BLOCK_TYPES = new Set(['image', 'font', 'media']);
        const BLOCK_DOMAINS = [
          'googlesyndication.com',
          'doubleclick.net',
          'googletagmanager.com',
          'google-analytics.com',
          'facebook.net',
          'scorecardresearch.com',
          'quantserve.com',
        ];
        page.on('request', (req) => {
          const url = req.url();
          if (BLOCK_TYPES.has(req.resourceType()) || BLOCK_DOMAINS.some((d) => url.includes(d))) {
            req.abort();
          } else {
            req.continue();
          }
        });

        page.on('response', async (resp) => {
          const url = resp.url();
          // Brightcove playback API returns JSON with HLS sources
          if (
            url.includes('edge.api.brightcove.com') ||
            url.includes('/accounts/665003303001/videos/')
          ) {
            try {
              const json = await resp.json();
              const sources = json.sources || [];
              // Prefer HLS manifest (application/x-mpegURL or .m3u8)
              const hls = sources.find(
                (s) =>
                  (s.type === 'application/x-mpegURL' || (s.src && s.src.includes('.m3u8'))) &&
                  s.src &&
                  s.src.includes('manifest.prod.boltdns.net')
              );
              if (hls && hls.src && !capturedHls) {
                capturedHls = hls.src;
                capturedVideoId = json.id || url.match(/videos\/(\d+)/)?.[1] || null;
                console.log(
                  `[scrapeAjNewsVideos] Captured HLS for ${articleUrl.slice(-60)}: ${hls.src.slice(0, 80)}`
                );
              }
            } catch (_) {}
          }
        });

        await page.goto(stripAjPageFragment(articleUrl), {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        // Scroll to trigger lazy-loaded players
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await new Promise((r) => setTimeout(r, 2000));
      } catch (e) {
        console.warn(`[scrapeAjNewsVideos] Page error on ${articleUrl.slice(-60)}: ${e.message}`);
      } finally {
        await page.close();
      }

      if (!capturedHls) continue;

      // In-page Video.js is often 16:9 chrome while Brightcove master lists a 9:16 rendition — pick that variant URL.
      let orientation = 'landscape';
      let pillarboxFilter = null;
      let manifestWidth = 1920;
      let manifestHeight = 1080;
      let effectiveHls = capturedHls;
      try {
        const variantPick = await pickPortraitOrLargestVariantFromHlsMaster(capturedHls);
        if (variantPick && variantPick.orientation === 'portrait') {
          effectiveHls = variantPick.hlsUrl;
          orientation = 'portrait';
          manifestWidth = variantPick.sourceWidth;
          manifestHeight = variantPick.sourceHeight;
          pillarboxFilter = buildAjPillarboxFilter(manifestWidth, manifestHeight);
          console.log(
            `[scrapeAjNewsVideos] Portrait variant from master ${manifestWidth}x${manifestHeight}: ${articleUrl.slice(-60)}`
          );
        } else {
          const probed = await probeHlsDimensions(capturedHls);
          if (probed && probed.width > 0 && probed.height > 0) {
            manifestWidth = probed.width;
            manifestHeight = probed.height;
          } else {
            const manifestResp = await axios.get(capturedHls, { timeout: 10000 });
            const manifestText = manifestResp.data || '';
            const resMatches = [...manifestText.matchAll(/RESOLUTION=(\d+)x(\d+)/g)];
            if (resMatches.length > 0) {
              const dims = resMatches.map((m) => ({
                w: parseInt(m[1], 10),
                h: parseInt(m[2], 10),
              }));
              dims.sort((a, b) => b.w * b.h - a.w * a.h);
              manifestWidth = dims[0].w;
              manifestHeight = dims[0].h;
            }
          }
          if (manifestHeight > manifestWidth) {
            orientation = 'portrait';
            pillarboxFilter = buildAjPillarboxFilter(manifestWidth, manifestHeight);
          }
        }
      } catch (e) {
        console.warn(`[scrapeAjNewsVideos] Manifest check failed: ${e.message}`);
      }

      // Accept both landscape and portrait — clips go into the split-screen bottom half
      // and are cropped/scaled by FFmpeg regardless of source orientation.
      console.log(
        `[scrapeAjNewsVideos] ✅ ${orientation.toUpperCase()} ${manifestWidth}x${manifestHeight}: ${articleUrl.slice(-60)}`
      );

      const maxClipSec = parseFloat(process.env.NEWS_AJ_MAX_CLIP_SEC || '180', 10);
      if (Number.isFinite(maxClipSec) && maxClipSec > 0) {
        const dur = await probeHlsDurationSeconds(effectiveHls);
        if (dur != null && dur > maxClipSec + 0.25) {
          console.log(
            `[scrapeAjNewsVideos] ⏭  duration ${dur.toFixed(1)}s > ${maxClipSec}s (NEWS_AJ_MAX_CLIP_SEC): ${articleUrl.slice(-60)}`
          );
          continue;
        }
      }

      results.push({
        articleUrl: stripAjPageFragment(articleUrl),
        videoId: capturedVideoId,
        hlsUrl: effectiveHls,
        orientation,
        pillarboxFilter,
        sourceWidth: manifestWidth,
        sourceHeight: manifestHeight,
      });

      console.log(
        `[scrapeAjNewsVideos] ✅ added ${orientation} ${manifestWidth}x${manifestHeight}: ${articleUrl.slice(-60)}`
      );
    }
  } finally {
    await browser.close();
  }

  const landscape = results.filter((r) => r.orientation === 'landscape').length;
  const portrait = results.filter((r) => r.orientation === 'portrait').length;
  console.log(
    `[scrapeAjNewsVideos] Done: ${results.length} with video (${landscape} landscape, ${portrait} portrait)`
  );
  return results;
}

// ── AJ pillarbox filter builder ───────────────────────────────────────────────
// Builds an FFmpeg complex filter string that:
//   1. Scale-pads a 9:16 portrait clip to 1920x1080 16:9 frame
//   2. Fills side bars with Navy #22304b
//   3. Draws 4px Gold #c7af4f seam borders between content and bars
// w/h = source clip dimensions (e.g. 1080x1920)
// Output: ready to pass as -vf value in ffmpeg call
function buildAjPillarboxFilter(w, h) {
  // Target output: 1920x1080 16:9
  const targetW = 1920;
  const targetH = 1080;

  // Scale to fit height, then pad width with navy sides
  // scale height to 1080, compute scaled width, center in 1920
  const filter = [
    // Step 1: scale to target height, preserve aspect
    `scale=-2:${targetH}`,
    // Step 2: pad to target width with navy background
    `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=0x22304b`,
    // Step 3: gold seam left border (4px, full height)
    `drawbox=x='(${targetW}-iw)/2-4':y=0:w=4:h=${targetH}:color=0xc7af4f@1.0:t=fill`,
    // Step 4: gold seam right border (4px, full height)
    `drawbox=x='(${targetW}+iw)/2':y=0:w=4:h=${targetH}:color=0xc7af4f@1.0:t=fill`,
  ].join(',');

  return filter;
}

router.get('/news/us-canada-videos', async (req, res) => {
  try {
    // ── Puppeteer-confirmed AJ video pool ────────────────────────────────────
    // Runs scrapeAjNewsVideos(): sitemap discovery → Puppeteer → Brightcove intercept.
    // Returns ONLY articles with confirmed HLS video URLs.
    // The dashboard shows these to the operator — text-only articles are excluded.
    // Typical results: 6-12 confirmed videos from today+yesterday's sitemap.
    console.log('[news/us-canada-videos] Running Puppeteer AJ scraper...');
    let ajVideos = await scrapeAjNewsVideos(5);
    console.log(`[news/us-canada-videos] Scraped ${ajVideos.length} confirmed video articles`);

    // ── Gate 0: Gemini recovery when scraper returns 0 videos ────────────────
    // If Puppeteer found nothing (timeouts, Brightcove not firing), ask Gemini to
    // pick the most video-likely articles from the sitemap and retry once.
    if (ajVideos.length === 0) {
      console.log(
        '[news/us-canada-videos] Gate 0: 0 videos — asking Gemini to select best candidates for retry...'
      );
      try {
        const [todayUrls, yestUrls] = await Promise.all([
          fetchAjSitemapUrls(new Date()),
          fetchAjSitemapUrls(new Date(Date.now() - 86400000)),
        ]);
        const merged = [...todayUrls, ...yestUrls].filter((u) =>
          ajArticlePathFromSitemapStrict(String(u))
        );
        const usFirst = merged.filter((u) => /\/where\/united-states\//i.test(u));
        const usCanadaNext = merged.filter((u) => /\/us-canada\//i.test(u));
        const allowedTail = merged.filter(
          (u) =>
            !/\/features\//i.test(u) &&
            !/\/opinion\//i.test(u) &&
            !/\/longform\//i.test(u) &&
            !/\/where\/united-states\//i.test(u) &&
            !/\/us-canada\//i.test(u)
        );
        const seenG = new Set();
        const ordered = [];
        for (const u of [...usFirst, ...usCanadaNext, ...allowedTail]) {
          if (!seenG.has(u)) {
            seenG.add(u);
            ordered.push(u);
          }
        }
        const allUrls = ordered.slice(0, 60);
        if (allUrls.length > 0) {
          const slugList = allUrls
            .map((u, i) => `${i + 1}. ${u.split('/').filter(Boolean).pop()}`)
            .join('\n');
          const geminiPrompt = `You are selecting news articles for a video show. From this list of Al Jazeera article slugs, pick the 8 most likely to have an embedded video (breaking news, conflict, politics, interviews tend to have video; opinion/analysis rarely do). Return ONLY a JSON array of the numbers you selected, e.g. [1,3,7,12,15,18,22,25]. No explanation.\n\n${slugList}`;
          const geminiResp = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            { contents: [{ parts: [{ text: geminiPrompt }] }] },
            { timeout: 15000 }
          );
          const geminiText = (
            (geminiResp.data?.candidates?.[0]?.content?.parts || []).map((p) => p.text).join('') ||
            ''
          ).trim();
          const match = geminiText.match(/\[[\d,\s]+\]/);
          if (match) {
            const indices = JSON.parse(match[0])
              .map((n) => n - 1)
              .filter((n) => n >= 0 && n < allUrls.length);
            const candidateUrls = indices.map((n) => allUrls[n]);
            console.log(
              `[news/us-canada-videos] Gate 0 Gemini picked ${candidateUrls.length} candidates — retrying scrape...`
            );
            ajVideos = await scrapeAjNewsVideos(5, candidateUrls);
            console.log(`[news/us-canada-videos] Gate 0 retry: ${ajVideos.length} videos found`);
          }
        }
      } catch (e) {
        console.warn(`[news/us-canada-videos] Gate 0 Gemini recovery failed: ${e.message}`);
      }
    }

    // Convert to the video object shape the dashboard expects
    const videos = ajVideos.map((v) => {
      const dateMatch = v.articleUrl.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
      let publishedAt = new Date().toISOString();
      if (dateMatch) {
        const [_, yyyy, mm, dd] = dateMatch;
        publishedAt = new Date(
          `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T23:59:59Z`
        ).toISOString();
      }
      const slug = v.articleUrl.split('/').filter(Boolean).pop() || '';
      const title = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

      return {
        url: v.articleUrl,
        href: v.articleUrl.replace('https://www.aljazeera.com', ''),
        title: title || '(untitled)',
        thumbnail: null,
        publishedAt,
        hlsUrl: v.hlsUrl,
        orientation: v.orientation, // 'landscape' | 'portrait'
        pillarboxFilter: v.pillarboxFilter, // null or FFmpeg filter string
      };
    });

    videos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    const landscape = videos.filter((v) => v.orientation === 'landscape').length;
    const portrait = videos.filter((v) => v.orientation === 'portrait').length;

    const hint =
      videos.length === 0
        ? 'No clips with Brightcove HLS from US/Canada AJ paths. Causes: Puppeteer did not capture HLS, duration over NEWS_AJ_MAX_CLIP_SEC, or Gemini sitemap recovery failed (check GEMINI_API_KEY). Server logs tag [news/us-canada-videos] and [scrapeAjNewsVideos].'
        : null;

    return res.json({
      ok: true,
      videos,
      recentCount: videos.length,
      totalFound: videos.length,
      scrapedWithVideo: ajVideos.length,
      droppedNonPortrait: 0,
      hint,
      source:
        'AJ where/united-states first, fallback us-canada — Puppeteer Brightcove — landscape + portrait — duration ≤ NEWS_AJ_MAX_CLIP_SEC',
      landscape,
      portrait,
    });
  } catch (err) {
    console.error('[news/us-canada-videos] Error:', err.message);
    return res.status(500).json({ error: err.message, videos: [], recentCount: 0 });
  }
});

// ── POST /twitch-clip-url ────────────────────────────────────────
// Resolves a Twitch clip page URL or slug to a direct MP4 download URL.
// Uses Twitch's GQL API (same method used by yt-dlp, streamlink, etc.)
// Returns { ok, mp4Url, quality, slug }
//
// Body: { url } — e.g. "https://www.twitch.tv/clips/SomeClipSlug"
//            or { slug } — e.g. "SomeClipSlug"

// Use TwitchClient methods instead of standalone functions
function extractTwitchSlug(urlOrSlug) {
  return twitchClient.extractSlug(urlOrSlug);
}

async function resolveTwitchClipMp4(slug, preferQuality) {
  return twitchClient.resolveClipMp4(slug, preferQuality);
}

router.post('/twitch-clip-url', async (req, res) => {
  const { url, slug: rawSlug } = req.body;
  const slug = rawSlug || extractTwitchSlug(url || '');
  if (!slug) return res.status(400).json({ error: 'Provide a Twitch clip URL or slug' });

  try {
    console.log(`[twitch-clip-url] Resolving slug: ${slug}`);
    const result = await resolveTwitchClipMp4(slug);
    console.log(`[twitch-clip-url] ✓ ${result.quality} — ${result.mp4Url.slice(0, 80)}...`);
    res.json({ ok: true, slug, ...result });
  } catch (err) {
    console.warn(`[twitch-clip-url] Failed for ${slug}: ${err.message}`);
    res.status(500).json({ error: err.message, slug });
  }
});

// ── POST /analyze-clip ────────────────────────────────────────────
// 1. Downloads thumbnail from URL
// 2. Sends to Gemini 2.5 Flash for visual analysis (what is actually happening)
// 3. Sends analysis + metadata to Claude with CWN voice rules
// 4. Returns a fully formatted CWN script ready for the script editor
//
// Body: { thumbnailUrl, clipTitle, streamer, game, contentType, clipUrl, viewCount }
// contentType: 'twitch' | 'nba' | 'news'

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_APIKEY = process.env.GEMINI_API_KEY; // Validated at startup

// CWN_VOICE_GUIDES moved to lib/script_gen.js (only consumer — getVoiceGuide() is in that module)

router.post('/analyze-clip', async (req, res) => {
  const { thumbnailUrl, clipTitle, streamer, game, contentType, clipUrl, viewCount } = req.body;

  if (!thumbnailUrl && !clipTitle) {
    return res.status(400).json({ error: 'thumbnailUrl or clipTitle required' });
  }
  if (!GEMINI_APIKEY) {
    return res.status(400).json({ error: 'GEMINI_API_KEY not set in .env' });
  }

  const type = contentType || 'twitch';
  console.log(
    `[analyze] Starting analysis — type:${type} streamer:${streamer || '?'} clip:"${clipTitle || '?'}"`
  );

  try {
    // ── Step 1: Gemini visual analysis ──────────────────────────────
    let geminiAnalysis = '';

    if (thumbnailUrl) {
      // Download thumbnail
      let imageBase64 = '';
      let mimeType = 'image/jpeg';
      try {
        const imgResp = await axios.get(thumbnailUrl, {
          responseType: 'arraybuffer',
          timeout: 10000,
        });
        imageBase64 = Buffer.from(imgResp.data).toString('base64');
        const ct = imgResp.headers['content-type'] || 'image/jpeg';
        mimeType = ct.split(';')[0].trim();
      } catch (e) {
        console.warn('[analyze] Thumbnail download failed:', e.message, '— proceeding text-only');
      }

      if (imageBase64) {
        // Build Gemini prompt based on content type
        const geminiPrompts = {
          twitch: `This is a thumbnail/still frame from a Twitch clip by streamer "${streamer || 'unknown'}".
Clip title: "${clipTitle || 'unknown'}".
Describe concisely (3-5 sentences): 
1. What game or content is visible
2. What the streamer appears to be reacting to
3. The specific visual moment — what is literally happening on screen
4. The energy or emotion visible (if the streamer's face/reaction is shown)
Be specific. No hype language.`,

          nba: `This is a thumbnail from an NBA game highlight clip.
Clip title: "${clipTitle || 'unknown'}".
Describe concisely (3-4 sentences):
1. Which teams are visible
2. What specific play or moment is shown
3. Any notable player action or positioning
4. The game situation if discernible (close game, blowout, big moment)
Be factual and specific.`,

          news: `This is a thumbnail from a news video.
Headline: "${clipTitle || 'unknown'}".
Describe concisely (2-3 sentences):
1. What is literally shown in the image — people, places, objects
2. The visual context that relates to the headline
3. Any notable details visible
Be factual. No editorializing.`,
        };

        const geminiPrompt = geminiPrompts[type] || geminiPrompts.twitch;

        const geminiBody = {
          contents: [
            {
              parts: [
                { text: geminiPrompt },
                { inline_data: { mime_type: mimeType, data: imageBase64 } },
              ],
            },
          ],
          generationConfig: { maxOutputTokens: 300, temperature: 0.3 },
        };

        const geminiResp = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
          geminiBody,
          { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
        );

        const parts = geminiResp.data?.candidates?.[0]?.content?.parts || [];
        geminiAnalysis = parts
          .map((p) => p.text || '')
          .join('')
          .trim();
        console.log(`[analyze] Gemini analysis: ${geminiAnalysis.slice(0, 120)}...`);
      }
    }

    // ── Step 2: Claude rewrites in CWN voice ─────────────────────────
    const tone = 'deadpan'; // Style guide from Gemini reference library handles voice — tone selector removed
    const voiceGuide = getVoiceGuide(type, tone);
    console.log(`[generate-full-script] tone:${tone}`);

    const claudePrompt = `Write a CWN script segment for the following source clip.

CLIP METADATA:
- Type: ${type}
- ${streamer ? `Streamer: ${streamer}` : ''}
- ${game ? `Game/Category: ${game}` : ''}
- Title: ${clipTitle || 'N/A'}
- ${viewCount ? `Views: ${viewCount.toLocaleString()}` : ''}
- ${clipUrl ? `URL: ${clipUrl}` : ''}

VISUAL ANALYSIS (from Gemini):
${geminiAnalysis || '(No visual analysis available — use clip title and metadata only)'}

Write the CWN script segment following the voice rules exactly.
Output ONLY the script — no preamble, no explanation, no markdown.`;

    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: voiceGuide,
      messages: [{ role: 'user', content: claudePrompt }],
    });

    const cwnScript = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    console.log(`[analyze] CWN script generated (${cwnScript.length} chars)`);

    res.json({
      ok: true,
      geminiAnalysis,
      cwnScript,
      clipTitle,
      streamer,
      contentType: type,
    });
  } catch (err) {
    console.error('[analyze] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /generate-full-script ───────────────────────────────────
// Generates a COMPLETE CWN script with no placeholders.
// 1. Calls Gemini 2.5 Flash on every thumbnail in parallel (visual analysis)
// 2. Calls Claude once with ALL data + visual analyses + voice guide
// 3. Returns a fully written script targeting 90%+ of video runtime
//
// Body: {
//   type: 'nba' | 'news' | 'twitch',
//   items: [
//     NBA:    { gameId, away, home, awayScore, homeScore, leader, leaderStat, injuries, thumbnailUrl }
//     News:   { title, desc, source, link, thumbnailUrl }
//     Twitch: { streamer, title, views, game, thumbnailUrl, url }
//   ],
//   date: 'Friday, April 3, 2026'
// }

// FULL_SCRIPT_SYSTEM moved to lib/script_gen.js (module split — only consumer)

// ── GEMINI VIDEO ANALYSIS (Files API) ────────────────────────────
// Upload video → Gemini watches full clip with audio → delete file
// Falls back to thumbnail analysis if video download/upload fails

const GEMINI_FILE_LIMIT = 34 * 1024 * 1024; // 34MB

// Use TwitchClient method
function twitchThumbToMp4(thumbnailUrl) {
  return twitchClient.thumbnailToMp4(thumbnailUrl);
}

/**
 * Scrape the Open Graph image URL from an article page.
 * Used for News TV card generation — each Al Jazeera article's og:image
 * becomes the hero image on that story's top-right TV card.
 * Fix 8B: axios + cheerio already in package.json, no new deps needed.
 *
 * @param {string} articleUrl - absolute URL to the article
 * @returns {Promise<string|null>} - the og:image URL, or null if scraping fails
 */
// ── Fix 9: Scrape real video clips from Al Jazeera articles ──────────────────
// Strategy: JSON-LD VideoObject → Brightcove embed URL → yt-dlp for HLS manifest URL.
// yt-dlp fails on article URLs directly (Unsupported URL) but succeeds on the
// Brightcove player embed URL extracted from the JSON-LD VideoObject block.
// YouTube embeds (rare, ~10% of video articles) also handled via yt-dlp's YT extractor.
// Live streams (is_live=true or duration=0) are filtered out — not usable as clips.
// Returns: absolute HLS/MP4 URL string ready for yt-dlp download, or null on failure.
// Per-article timeout: 15s. Non-fatal — story skips clip if scrape fails.

// Keep old name as alias (used in analyze-clip route)

router.post(
  '/generate-full-script',
  body('type').isString(),
  body('items').isArray(),
  body('formType').optional().isString(),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  },
  requireFields('type', 'items'),
  validateContentType(['twitch', 'nba', 'news', 'twitch-short', 'nba-short', 'news-short']),
  validateArrayLength('items', 1),
  async (req, res) => {
    const { type, items } = req.body;
    // Build ajVideoPool directly from items the dashboard already scraped —
    // avoids a full second Puppeteer run that adds 3-5 minutes before Gemini starts.
    // Items from fetchCwnNewsVideos() already carry hlsUrl, orientation, pillarboxFilter.
    let ajVideoPool = [];
    if ((type === 'news' || type === 'news-short') && Array.isArray(items)) {
      ajVideoPool = items
        .filter((it) => it.hlsUrl || it.videoUrl)
        .map((it) => ({
          articleUrl: it.link || it.url || '',
          title: it.title || '',
          hlsUrl: it.hlsUrl || it.videoUrl || '',
          orientation: (it.sourceOrientation || it.orientation || 'landscape').toLowerCase(),
          pillarboxFilter: it.pillarboxFilter || null,
        }));
      console.log(
        `[/generate-full-script] ajVideoPool built from request items: ${ajVideoPool.length} videos (no re-scrape)`
      );
    }
    // Create Job Spec at job start — single document every stage reads
    try {
      const { type: contentType, formType, itemCount, title } = req.body;
      const sourceType =
        contentType === 'news' || contentType === 'news-short' ? 'site_scrape' : 'url_list';
      const sourceUrls = Array.isArray(items)
        ? items.map((it) => it.videoUrl || it.clipUrl || it.url || it.link || null).filter(Boolean)
        : [];
      req.jobSpec = await createJobSpec({
        customerId: req.body.customerId || 'c0',
        showId: req.body.showId || null,
        templateId: formType === 'short' ? 'short-form' : 'long-form',
        contentType,
        createdBy: 'dashboard',
        expectedSynth: !!req.body.expectedSynth,
        sourceType,
        sourceConfig:
          sourceType === 'site_scrape' ? { siteTarget: contentType } : { urls: sourceUrls },
        items: Array.isArray(items) ? items : [],
        title: title || null,
      });
    } catch (specErr) {
      console.warn(
        '[/generate-full-script] Job Spec creation failed (non-fatal):',
        specErr.message
      );
    }
    // Override deliverySpec platforms if caller specified them (e.g. platform selector modal)
    if (
      req.jobSpec &&
      req.body.platforms &&
      Array.isArray(req.body.platforms) &&
      req.body.platforms.length > 0
    ) {
      req.jobSpec.deliverySpec.platforms = req.body.platforms;
      console.log(
        `[/generate-full-script] deliverySpec.platforms overridden by request: ${req.body.platforms.join(', ')}`
      );
    }
    // Store the semantic jobSpecId on req so script_gen can cross-reference it into the job card
    let preGenerateAllReady = false;
    let preGenerateCommitments = {};
    if (req.jobSpec) {
      req.jobSpecId = req.jobSpec.jobId;

      // ── PRE-GENERATE GATE COMMITMENT CHECK ───────────────────────────────
      // Every gate worker runs canProduce() + commit() against this job spec
      // BEFORE production starts. All must confirm they can deliver.
      // Job ID is only confirmed after all gates sign off.
      // QA agents are also notified of the confirmed job ID and spec.
      const sep = '═'.repeat(60);
      console.log('\n' + sep);
      console.log(`[PRE-GENERATE] Job spec received — gate workers signing off`);
      console.log(`[PRE-GENERATE] Job ID:        ${req.jobSpec.jobId}`);
      console.log(`[PRE-GENERATE] Customer:      ${req.jobSpec.customerId}`);
      console.log(`[PRE-GENERATE] Template:      ${req.jobSpec.templateId}`);
      console.log(`[PRE-GENERATE] Content type:  ${req.jobSpec.contentType}`);
      console.log(
        `[PRE-GENERATE] Form factor:   ${req.jobSpec.order?.output?.formFactor} (${req.jobSpec.order?.output?.aspectRatio})`
      );
      console.log(
        `[PRE-GENERATE] Resolution:    ${req.jobSpec.order?.output?.resolution?.width}×${req.jobSpec.order?.output?.resolution?.height}`
      );
      console.log(
        `[PRE-GENERATE] Platforms:     ${req.jobSpec.deliverySpec?.platforms?.join(', ') || 'none'}`
      );
      console.log(
        `[PRE-GENERATE] Avatar ID:     ${req.jobSpec.designSpec?.avatarId?.slice(0, 8) || 'n/a'}...`
      );
      console.log(
        `[PRE-GENERATE] Expected clips:${req.jobSpec.designSpec?.expectedClipCount ?? 'n/a'}`
      );
      console.log(`[PRE-GENERATE] Chrome skin:   ${req.jobSpec.designSpec?.chrome?.skin || 'n/a'}`);
      console.log(
        `[PRE-GENERATE] Outro line:    ${req.jobSpec.designSpec?.voice?.outroLine || 'from customerConfig'}`
      );
      console.log(sep);

      // Run canProduce + commit on all gate workers
      try {
        const gates = {
          gate0: require('../portals/portal0'),
          gate1: require('../portals/portal1'),
          gate2: require('../portals/portal2'),
          gate3a: require('../portals/portal3a'),
          gate3b: require('../portals/portal3b'),
          gate4: require('../portals/portal4'),
          gate5: require('../portals/portal5'),
        };

        let allReady = true;
        const commitments = {};

        for (const [name, gate] of Object.entries(gates)) {
          try {
            // canProduce check
            const readiness =
              typeof gate.canProduce === 'function'
                ? await Promise.resolve(gate.canProduce(req.jobSpec))
                : { ready: true, missing: [] };

            // commit declaration
            const commitment =
              typeof gate.commit === 'function'
                ? await Promise.resolve(gate.commit(req.jobSpec))
                : { committed: 'no commit() defined' };

            const ready = readiness.ready !== false;
            commitments[name] = { ready, commitment };

            if (!ready) {
              allReady = false;
              console.log(
                `[${name.toUpperCase()}] ❌ NOT READY: ${(readiness.missing || readiness.reasons || []).map((m) => m.item || m).join(', ')}`
              );
            } else {
              const summary = commitment?.summary || commitment?.committed || 'ready';
              console.log(`[${name.toUpperCase()}] ✅ SIGNED OFF: ${summary}`);
            }
          } catch (gErr) {
            console.log(`[${name.toUpperCase()}] ⚠️  Sign-off error (non-fatal): ${gErr.message}`);
          }
        }

        console.log(sep);
        if (allReady) {
          console.log(
            `[PRE-GENERATE] ✅ ALL GATES SIGNED OFF — Job confirmed: ${req.jobSpec.jobId}`
          );
          console.log(`[PRE-GENERATE] 🚀 Production starting — notifying all QA agents`);
          console.log(`[PRE-GENERATE] QA agents briefed on job: ${req.jobSpec.jobId}`);
          console.log(
            `[PRE-GENERATE] Gate thresholds: G1≥${req.jobSpec.designSpec?.qaThresholds?.gate1?.pass} G2≥${req.jobSpec.designSpec?.qaThresholds?.gate2?.pass} G3a≥${req.jobSpec.designSpec?.qaThresholds?.gate3a?.pass} G4≥${req.jobSpec.designSpec?.qaThresholds?.gate4?.pass}`
          );
        } else {
          console.log(`[PRE-GENERATE] ⚠️  Some gates not ready — job proceeding with warnings`);
          console.log(`[PRE-GENERATE] Kill this job if critical gates failed`);
        }
        console.log(sep + '\n');

        // Emit job confirmed event on pipeline bus for monitoring
        pipelineBus.emit('job:confirmed', {
          jobId: req.jobSpec.jobId,
          contentType: req.jobSpec.contentType,
          templateId: req.jobSpec.templateId,
          jobSpec: req.jobSpec, // full jobSpec for gate prepare() pre-work
          commitments,
          allReady,
        });

        // NR: job confirmed event — queryable per customer/content type
        nrJobConfirmed(req.jobSpec, allReady);

        preGenerateAllReady = allReady;
        preGenerateCommitments = commitments;
        try {
          persistJobSpecGateContracts(req.jobSpec, commitments);
        } catch (contractErr) {
          console.warn(
            '[PRE-GENERATE] Failed to persist gate contracts (non-fatal):',
            contractErr.message
          );
        }
      } catch (commitErr) {
        console.warn('[PRE-GENERATE] Gate sign-off check failed (non-fatal):', commitErr.message);
      }

      // ── QA generate confirm (monitor + optional enforce) ─────────────────
      // Gate workers sign off above; this tracks whether QA should also ack before generate (policy).
      try {
        const qaGen = require('../qa_generate_confirm');
        qaGen.persistAfterPreGenerate(req.jobSpec.jobId, {
          allReady: preGenerateAllReady,
          commitments: preGenerateCommitments,
        });
        const policyOn = qaGen.isPolicyEnabled();
        pipelineBus.emit('qa:generate_confirm_policy', {
          jobId: req.jobSpec.jobId,
          contentType: req.jobSpec.contentType,
          templateId: req.jobSpec.templateId,
          policyEnabled: policyOn,
          gateWorkersAllReady: preGenerateAllReady,
          monitorNote: policyOn
            ? 'QA_CONFIRM_ON_GENERATE: require qaGenerateConfirmed on this POST or POST /job/:id/qa-confirm-generate'
            : 'QA generate confirm not required — set QA_CONFIRM_ON_GENERATE=true to enforce QA ack like gate sign-off',
        });
        nrQaGenerateConfirmPolicy(req.jobSpec, {
          policyEnabled: policyOn,
          gateWorkersAllReady: preGenerateAllReady,
        });
        if (policyOn) {
          // Same POST must include qaGenerateConfirmed (each generate creates a new jobId — no separate round-trip yet).
          if (!qaGen.requestSaysConfirmed(req.body)) {
            return res.status(422).json({
              error:
                'QA_CONFIRM_ON_GENERATE is enabled: include qaGenerateConfirmed: true on this POST after QA agents agree (same request as gate sign-off). Optional: POST /job/:jobId/qa-confirm-generate for manual DB ack when reusing a job id.',
              needsQaGenerateConfirm: true,
              jobId: req.jobSpec.jobId,
              gateWorkersAllReady: preGenerateAllReady,
            });
          }
          qaGen.markConfirmed(req.jobSpec.jobId, { source: 'request_body' });
        }
      } catch (qaErr) {
        console.warn(
          '[generate-full-script] QA generate confirm hook failed (non-fatal):',
          qaErr.message
        );
      }
    }
    handleGenerateFullScript(req, res, saveJobCard, startHeyGenPoller, ajVideoPool);
  }
);

// ── POST /analyze-style-library ─────────────────────────────────
// One-time teaching pass: Gemini watches reference videos and extracts
// a style fingerprint per content type. Stored in cwn_style_guides.json.
// Dashboard calls this from Settings → TEACH GEMINI button.
router.post('/analyze-style-library', async (req, res) => {
  const { library } = req.body;
  // library: { twitch: [url, url], nba: [url], news: [url], ... }
  if (!library || !Object.keys(library).length) {
    return res.status(400).json({ error: 'No reference library provided' });
  }
  if (!GEMINI_APIKEY) return res.status(400).json({ error: 'GEMINI_API_KEY not set' });

  const STYLE_GUIDE_PATH = path.join(__dirname, 'data/cwn_style_guides.json');
  let existingGuides = {};
  try {
    existingGuides = JSON.parse(fs.readFileSync(STYLE_GUIDE_PATH, 'utf8'));
  } catch (e) {}

  const results = {};
  const errors = {};

  for (const [contentType, urls] of Object.entries(library)) {
    if (!urls || !urls.length) continue;
    console.log(`[style-library] Analyzing ${urls.length} reference videos for: ${contentType}`);

    const videoAnalyses = [];
    for (const url of urls) {
      if (!url || !url.startsWith('http')) continue;
      try {
        // Download video sample (first 32MB) for Gemini analysis
        const tmpPath = path.join(
          TMP_DIR,
          `ref_${contentType}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp4`
        );
        const MAX_BYTES = 32 * 1024 * 1024;

        console.log(`[style-library] Downloading: ${url.slice(0, 80)}...`);
        await new Promise((res, rej) => {
          const { execFile } = require('child_process');
          const args = [
            '--quiet',
            '--no-warnings',
            '-f',
            'best[ext=mp4][filesize<33M]/best[filesize<33M]/best',
            '--max-filesize',
            '33m',
            '-o',
            tmpPath,
            '--no-playlist',
            '--no-part',
          ];
          execFile('yt-dlp', args.concat([url]), { timeout: 90000 }, (err, stdout, stderr) => {
            if (err) rej(new Error(`yt-dlp: ${stderr || err.message}`));
            else res();
          });
        });

        if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size < 1000) {
          console.warn(`[style-library] Download failed for ${url}`);
          try {
            fs.unlinkSync(tmpPath);
          } catch (e) {}
          continue;
        }

        // Cap at 32MB
        const stat = fs.statSync(tmpPath);
        if (stat.size > MAX_BYTES) {
          const buf = fs.readFileSync(tmpPath).slice(0, MAX_BYTES);
          fs.writeFileSync(tmpPath, buf);
        }

        console.log(
          `[style-library] Uploading ${(fs.statSync(tmpPath).size / 1024 / 1024).toFixed(1)}MB to Gemini...`
        );
        const geminiFile = await waitForGeminiFile(await uploadToGeminiFiles(tmpPath));

        // 2x VIEWING: Watch each reference video 2 times for style learning
        console.log(`[style-library] Starting 2x viewing analysis for ${url.slice(0, 60)}...`);
        const multipleViewings = [];

        for (let viewNum = 1; viewNum <= 2; viewNum++) {
          const stylePrompt = `You are analyzing a reference video to extract a STYLE FINGERPRINT for Bobby G, the host of ClipzWorld News (CWN), a "${contentType}" show.

Bobby G's voice blend: Norm MacDonald (flat deadpan, never explains the joke) + Jon Stewart Daily Show (one alarming observation, controlled disbelief) + Stuart Scott ESPN (cultural authority, rhythm, cadence) + Space Ghost Coast to Coast (non-sequitur pivots are fine, chaos is fine).

Bobby G NEVER does: hype phrases ("What's up everyone!"), exclamation energy, "This is insane!", "You won't believe this", audience callouts ("Drop a comment below"), explaining the joke, or warm enthusiasm.

This is VIEWING #${viewNum} of 2. ${viewNum === 1 ? 'Watch this video carefully for the first time.' : 'Focus on details you may have missed in the first viewing — extract nuanced stylistic details and recurring patterns.'}

Extract ONLY what applies to Bobby G's voice. Focus on:
1. SENTENCE STRUCTURE: How short? How flat? State-the-fact pattern?
2. TIMING & PACING: Where does the host pause? How long after a clip before speaking?
3. OBSERVATION STYLE: Does the host make it MORE alarming or just note the absurdity?
4. TRANSITION STRUCTURE: How does it move between topics? One word? One sentence?
5. HUMOR TECHNIQUE: Understatement? Non-sequitur? Deadpan? What specifically?
6. WHAT THIS HOST DOES NOT DO: Explicit list of avoided behaviors
7. RHYTHM PATTERNS: Sentence length variation, [beat] placement, trailing off vs punchy endings

Do NOT extract: energy level, catchphrases, audience engagement tactics, hype language, or anything that conflicts with flat deadpan delivery. Those are surface features of the performer, not the voice Bobby G uses.`;

          // Retry up to 3 times on 503 with exponential backoff
          let genResp = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              genResp = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
                {
                  contents: [
                    {
                      parts: [
                        { text: stylePrompt },
                        { file_data: { mime_type: 'video/mp4', file_uri: geminiFile.uri } },
                      ],
                    },
                  ],
                  generationConfig: { maxOutputTokens: 1000, temperature: 0.2 },
                },
                { headers: { 'Content-Type': 'application/json' }, timeout: 90000 }
              );
              break; // success
            } catch (retryErr) {
              const is503 = retryErr.response && retryErr.response.status === 503;
              if (is503 && attempt < 3) {
                const backoff = attempt * 15000; // 15s, 30s
                console.warn(
                  `[style-library]   ⚠️ 503 on viewing ${viewNum} attempt ${attempt} — retrying in ${backoff / 1000}s`
                );
                await new Promise((r) => setTimeout(r, backoff));
              } else {
                throw retryErr;
              }
            }
          }

          const observation = (genResp.data?.candidates?.[0]?.content?.parts || [])
            .map((p) => p.text || '')
            .join('')
            .trim();
          if (observation.length > 100) {
            multipleViewings.push(`--- VIEWING #${viewNum} ---\n${observation}`);
            console.log(
              `[style-library]   ✓ Viewing ${viewNum}/2 complete (${observation.length} chars)`
            );
          }

          // Rate limit pause between viewings (shorter than between videos)
          if (viewNum < 2) await new Promise((r) => setTimeout(r, 2000));
        }

        // Synthesize all 2 viewings into a deep per-video analysis
        if (multipleViewings.length >= 1) {
          // Require at least 1 successful viewing
          const deepSynthesisPrompt = `You watched this "${contentType}" reference video ${multipleViewings.length} times and extracted style observations for Bobby G, host of ClipzWorld News.

Bobby G's voice: Norm MacDonald deadpan + Jon Stewart controlled disbelief + Stuart Scott cultural authority. Flat. Never explains the joke. State the fact, one observation, done.

Here are your ${multipleViewings.length} viewing observations:
${multipleViewings.join('\n\n')}

Synthesize these into ONE DEEP style analysis — but filter everything through Bobby G's voice constraints:
- Keep: sentence structure, timing patterns, observation technique, transition rhythm, deadpan moves
- Discard: hype energy, audience callouts, exclamation delivery, warm enthusiasm, catchphrase energy
- Identify patterns that appeared across multiple viewings
- Be specific and actionable — a Gemini model should read this and write flat deadpan scripts
Max 600 words.`;

          try {
            const { Anthropic } = require('@anthropic-ai/sdk');
            const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const msg = await anthropic.messages.create({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 800,
              messages: [{ role: 'user', content: deepSynthesisPrompt }],
            });
            const deepAnalysis = msg.content[0]?.text || multipleViewings.join('\n\n');
            videoAnalyses.push(
              `--- Reference video (2x viewing): ${url.slice(0, 60)} ---\n${deepAnalysis}`
            );
            console.log(
              `[style-library] ✅ 2x analysis complete for ${url.slice(0, 60)} (${deepAnalysis.length} chars)`
            );
          } catch (e) {
            // Fallback: concatenate all viewings
            videoAnalyses.push(
              `--- Reference video (2 viewings): ${url.slice(0, 60)} ---\n${multipleViewings.join('\n\n')}`
            );
            console.log(
              `[style-library] ✅ 2x analysis complete (fallback) for ${url.slice(0, 60)}`
            );
          }
        } else {
          console.warn(
            `[style-library] Only ${multipleViewings.length}/2 viewings succeeded, skipping video`
          );
        }

        // Cleanup
        try {
          fs.unlinkSync(tmpPath);
        } catch (e) {}
        try {
          await axios.delete(
            `https://generativelanguage.googleapis.com/v1beta/${geminiFile.name}?key=${GEMINI_APIKEY}`
          );
        } catch (e) {}

        // Rate limit pause between videos — longer to avoid 503s on rapid succession
        await new Promise((r) => setTimeout(r, 5000));
      } catch (e) {
        console.warn(`[style-library] Failed for ${url}: ${e.message}`);
        errors[url] = e.message;
      }
    }

    if (videoAnalyses.length > 0) {
      // Synthesize all analyses into one coherent style guide
      const isShortForm = contentType.endsWith('-short');
      const shortConstraints = isShortForm
        ? `

SHORT-FORM SPECIFIC RULES (this is a 45-60 second vertical video):
- ONE clip, ONE observation, done — no callbacks, no multi-part builds
- Every sentence must earn its place — cut anything that doesn't land immediately
- No setup longer than 2 sentences before the clip
- Post-clip reaction: maximum 2 sentences
- [beat] used once maximum per script
- Must feel complete in under 60 seconds`
        : '';

      const synthesisPrompt = `You analyzed ${videoAnalyses.length} reference videos for Bobby G, host of ClipzWorld News (CWN) "${contentType}" show.

Bobby G's voice: Norm MacDonald deadpan + Jon Stewart controlled disbelief + Stuart Scott cultural authority + Space Ghost non-sequitur. Flat delivery. Never explains the joke. Never hypes. State the fact, one observation, done.${shortConstraints}

Here are the individual analyses:
${videoAnalyses.join('\n\n')}

Write a UNIFIED STYLE GUIDE for Bobby G's "${contentType}" scripts. Extract the structural, rhythmic, and comedic patterns from the reference videos that are COMPATIBLE with Bobby G's flat deadpan delivery.

INCLUDE:
- Sentence structure patterns (how short, how flat, state-fact-then-observation)
- Timing cues (where [beat] pauses belong, how long after a clip before speaking)
- Transition structure (one word? one sentence? non-sequitur pivot?)
- Observation technique (make it more alarming, not less — never explain)
- What this voice NEVER does (explicit do-not list)

DO NOT INCLUDE:
- Hype phrases, exclamation energy, audience callouts
- "What's up everyone", "This is insane", "You won't believe"
- Warm enthusiasm or cheerleader energy
- Anything that contradicts flat deadpan delivery

Format as clear bullet points under clear headings. Max 400 words. This will be injected into every "${contentType}" script generation prompt.`;

      try {
        const { Anthropic } = require('@anthropic-ai/sdk');
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          messages: [{ role: 'user', content: synthesisPrompt }],
        });
        const styleGuide = msg.content[0]?.text || videoAnalyses.join('\n\n');
        existingGuides[contentType] = styleGuide;
        results[contentType] = {
          ok: true,
          videoCount: videoAnalyses.length,
          chars: styleGuide.length,
        };
        console.log(
          `[style-library] ✅ Style guide for ${contentType}: ${styleGuide.length} chars`
        );
      } catch (e) {
        // Fallback: just concatenate analyses
        existingGuides[contentType] = videoAnalyses.join('\n\n');
        results[contentType] = { ok: true, videoCount: videoAnalyses.length, fallback: true };
      }
    } else {
      results[contentType] = { ok: false, error: 'No videos could be analyzed' };
    }

    // Pause between content types to avoid Gemini 503 rate limits
    await new Promise((r) => setTimeout(r, 15000));
  }

  // Save style guides to disk
  fs.writeFileSync(STYLE_GUIDE_PATH, JSON.stringify(existingGuides, null, 2));
  console.log(`[style-library] Saved style guides to ${STYLE_GUIDE_PATH}`);

  res.json({ ok: true, results, errors, guidePath: STYLE_GUIDE_PATH });
});

// ── GET /style-library ────────────────────────────────────────────
// Returns currently stored style guides
router.get('/style-library', (req, res) => {
  const STYLE_GUIDE_PATH = path.join(__dirname, 'data/cwn_style_guides.json');
  try {
    const guides = JSON.parse(fs.readFileSync(STYLE_GUIDE_PATH, 'utf8'));
    res.json({ ok: true, guides, path: STYLE_GUIDE_PATH });
  } catch (e) {
    res.json({ ok: true, guides: {}, message: 'No style guides yet — run Teaching Pass first' });
  }
});

// ── Publishing Routes ─────────────────────────────────────────────

// /publish/*, /upload-status, /heygen/*, /log-heygen-metrics — now in lib/routes/publish.js + lib/routes/heygen.js

module.exports = router;
