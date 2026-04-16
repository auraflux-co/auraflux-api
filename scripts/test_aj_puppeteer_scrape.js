#!/usr/bin/env node
/**
 * test_aj_puppeteer_scrape.js
 *
 * Sitemap-driven Al Jazeera news video scraper.
 *
 * Discovery: AJ sitemap (aljazeera.com/sitemap.xml?yyyy=YYYY&mm=MM&dd=DD)
 *   → filter by date (today + yesterday)
 *   → filter by topic keywords (caller-supplied or default US_KEYWORDS)
 *   → skip liveblogs, /video/newsfeed/, longform, podcasts
 *
 * Extraction: Puppeteer loads each article, scrolls to trigger lazy Brightcove
 *   player, intercepts network to capture HLS URL, checks manifest dimensions.
 *   Skips 9:16 portrait video.
 *
 * Configurable: pass --topic "tariff,trade,china" to override US_KEYWORDS.
 *
 * Run: node scripts/test_aj_puppeteer_scrape.js
 *      node scripts/test_aj_puppeteer_scrape.js --topic "iran,nuclear,sanctions"
 *
 * Requires: npm install puppeteer axios
 */

const puppeteer = require('puppeteer');
const axios = require('axios');

const AJ_BASE = 'https://www.aljazeera.com';
const BC_POLICY_KEY_HEADER = 'BCOV-Policy';

// CWN brand colors for pillarbox treatment on 9:16 portrait clips
const BRAND_NAVY = '#22304b';
const BRAND_GOLD = '#c7af4f';

// Default US-relevance keyword list
const US_KEYWORDS = [
  'us-', '-us-', 'trump', 'america', 'american', 'washington', 'congress',
  'senate', 'white-house', 'pentagon', 'biden', 'harris',
  'canada', 'mexico', 'nato', 'iran-us', 'us-iran', 'tariff', 'fentanyl',
  'deportation', 'immigration', 'border', 'fbi', 'cia', 'doge',
];

// Parse --topic flag from CLI args
function getTopicKeywords() {
  const topicIdx = process.argv.indexOf('--topic');
  if (topicIdx !== -1 && process.argv[topicIdx + 1]) {
    return process.argv[topicIdx + 1].split(',').map(k => k.trim().toLowerCase());
  }
  return US_KEYWORDS;
}

/**
 * Fetch AJ sitemap for a given date, return filtered article URLs.
 * @param {Date} date
 * @param {string[]} topicKeywords
 */
async function fetchSitemapUrls(date, topicKeywords) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const sitemapUrl = `${AJ_BASE}/sitemap.xml?yyyy=${yyyy}&mm=${mm}&dd=${dd}`;

  const resp = await axios.get(sitemapUrl, {
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CWN-Scraper/1.0)' },
  });

  const allUrls = [...resp.data.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);

  // Filter out non-article content
  const articles = allUrls.filter(u => {
    if (u.includes('/liveblog/')) return false;
    if (u.includes('/video/')) return false;
    if (u.includes('/longform/')) return false;
    if (u.includes('/podcasts/')) return false;
    if (u.includes('#')) return false;
    return true;
  });

  // Topic keyword filter
  const relevant = articles.filter(u =>
    topicKeywords.some(kw => u.toLowerCase().includes(kw))
  );

  return { date: `${yyyy}-${mm}-${dd}`, total: allUrls.length, articles: articles.length, relevant };
}

/**
 * Auto-scroll a page to trigger lazy-loaded content
 */
async function autoScroll(page, times = 5) {
  for (let i = 0; i < times; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await new Promise(r => setTimeout(r, 500));
  }
}

/**
 * Check a single article for embedded Brightcove video via Puppeteer.
 * Returns: { url, hasVideo, videoIds[], hlsUrls[], error }
 */
async function checkArticleForVideo(browser, url) {
  const result = { url, hasVideo: false, videoIds: [], hlsUrls: [], error: null };

  const page = await browser.newPage();
  const capturedHlsUrls = [];

  await page.setRequestInterception(true);
  page.on('request', req => req.continue());
  page.on('response', async resp => {
    if (resp.url().includes('edge.api.brightcove.com/playback/v1')) {
      try {
        const body = await resp.json();
        (body.sources || []).forEach(s => {
          if (s.type === 'application/x-mpegURL' || (s.src && s.src.includes('.m3u8'))) {
            capturedHlsUrls.push(s.src);
          }
        });
      } catch (_) {}
    }
  });

  try {
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await autoScroll(page, 5);

    try {
      await page.waitForSelector('[data-video-id]', { timeout: 4000 });
    } catch (_) {}

    const videoIds = await page.evaluate(() => {
      const ids = new Set();
      document.querySelectorAll('[data-video-id]').forEach(el => {
        const id = el.getAttribute('data-video-id');
        if (id && /^\d+$/.test(id)) ids.add(id);
      });
      return [...ids];
    });

    if (videoIds.length > 0 || capturedHlsUrls.length > 0) {
      result.hasVideo = true;
      result.videoIds = videoIds;
      result.hlsUrls = [...new Set(capturedHlsUrls)];
    }
  } catch (e) {
    result.error = e.message;
  } finally {
    await page.close();
  }

  return result;
}

/**
 * Check HLS manifest dimensions — returns array of { width, height, is16x9 }
 */
async function checkHlsDimensions(hlsUrl) {
  if (!hlsUrl) return null;
  try {
    const resp = await axios.get(hlsUrl, { timeout: 8000, responseType: 'text' });
    const matches = [...resp.data.matchAll(/RESOLUTION=(\d+)x(\d+)/g)];
    if (matches.length === 0) return null;
    return matches.map(m => ({
      width: parseInt(m[1]),
      height: parseInt(m[2]),
      is16x9: parseInt(m[1]) > parseInt(m[2]),
    }));
  } catch (_) {
    return null;
  }
}

/**
 * Build the FFmpeg pillarbox filter for a 9:16 portrait clip → 16:9 frame.
 * Fills side bars with CWN Navy, adds 4px Gold border strips at the seam.
 *
 * Input: any portrait clip (e.g. 608x1080)
 * Output: 1920x1080 with navy pillarbox + gold border lines
 *
 * Filter chain:
 *   1. scale to fit height (608x1080 → 608x1080, no-op; or scale shorter clips up)
 *   2. pad to 1920x1080 centered, navy background
 *   3. drawbox gold vertical lines at pillarbox seams
 */
function buildPillarboxFilter(inputWidth, inputHeight, targetW = 1920, targetH = 1080) {
  const navy = BRAND_NAVY.replace('#', '0x');
  const gold = BRAND_GOLD.replace('#', '0x');

  // Scale: fit within target height, preserve AR
  const scaledW = Math.round((inputWidth / inputHeight) * targetH);
  const padX = Math.round((targetW - scaledW) / 2);

  return [
    // Scale to fit height
    `scale=${scaledW}:${targetH}`,
    // Pad to full 16:9 with navy
    `pad=${targetW}:${targetH}:${padX}:0:${navy}`,
    // Gold border — left seam (4px wide)
    `drawbox=x=${padX}:y=0:w=4:h=${targetH}:color=${gold}@1.0:t=fill`,
    // Gold border — right seam (4px wide)
    `drawbox=x=${targetW - padX - 4}:y=0:w=4:h=${targetH}:color=${gold}@1.0:t=fill`,
  ].join(',');
}

async function main() {
  const topicKeywords = getTopicKeywords();
  const isCustomTopic = process.argv.includes('--topic');

  console.log('=== Al Jazeera Sitemap-Driven Video Scraper ===\n');
  console.log(`Topic filter: ${isCustomTopic ? `custom (${topicKeywords.join(', ')})` : 'default US keywords'}`);
  console.log();

  // Step 1: Collect candidate URLs from today + yesterday's sitemaps
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setUTCDate(today.getUTCDate() - 1);

  const [todayResult, yesterdayResult] = await Promise.all([
    fetchSitemapUrls(today, topicKeywords),
    fetchSitemapUrls(yesterday, topicKeywords),
  ]);

  console.log(`Sitemap ${todayResult.date}: ${todayResult.total} total → ${todayResult.articles} articles → ${todayResult.relevant.length} topic-relevant`);
  console.log(`Sitemap ${yesterdayResult.date}: ${yesterdayResult.total} total → ${yesterdayResult.articles} articles → ${yesterdayResult.relevant.length} topic-relevant`);

  // Merge, dedupe, today first
  const allRelevant = [...new Set([...todayResult.relevant, ...yesterdayResult.relevant])];
  console.log(`\nTotal candidate articles: ${allRelevant.length}`);

  if (allRelevant.length === 0) {
    console.log('No matching articles found. Try broader keywords.');
    return;
  }

  // Step 2: Puppeteer check each article (limit to 20 for speed)
  const toCheck = allRelevant.slice(0, 20);
  console.log(`\nChecking first ${toCheck.length} articles for embedded 16:9 Brightcove video...\n`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const results = [];

  try {
    for (const url of toCheck) {
      const slug = url.split('/').filter(Boolean).pop();
      process.stdout.write(`  ${slug.substring(0, 55)}... `);

      const result = await checkArticleForVideo(browser, url);
      results.push(result);

      if (result.error) {
        console.log(`❌ ERROR: ${result.error}`);
      } else if (result.hasVideo) {
        console.log(`✅ Brightcove IDs: [${result.videoIds.join(', ')}] | ${result.hlsUrls.length} HLS URL(s)`);
      } else {
        console.log('⚪ no video');
      }

      await new Promise(r => setTimeout(r, 400));
    }

    // Step 3: Dimension check
    console.log('\n=== DIMENSION CHECK ===\n');
    const withVideo = results.filter(r => r.hasVideo && r.hlsUrls.length > 0);

    for (const r of withVideo) {
      const dims = await checkHlsDimensions(r.hlsUrls[0]);
      r.dimensions = dims;
      const slug = r.url.split('/').filter(Boolean).pop();
      const section = r.url.replace(AJ_BASE, '').split('/')[1];
      if (dims) {
        const max = dims.reduce((a, b) => (a.width > b.width ? a : b));
        if (max.is16x9) {
          console.log(`  [/${section}/] ${slug.substring(0, 45)}: ${max.width}x${max.height} — 16:9 native ✅`);
        } else {
          const filter = buildPillarboxFilter(max.width, max.height);
          console.log(`  [/${section}/] ${slug.substring(0, 45)}: ${max.width}x${max.height} — 9:16 → pillarbox 🟨`);
          console.log(`    FFmpeg: ${filter.substring(0, 90)}...`);
        }
      } else {
        console.log(`  [/${section}/] ${slug.substring(0, 45)}: manifest fetch failed`);
      }
    }

    // Step 4: Summary
    console.log('\n=== SUMMARY ===');
    const landscape = results.filter(r => r.dimensions && r.dimensions.some(d => d.is16x9));
    const portrait = results.filter(r => r.dimensions && r.dimensions.every(d => !d.is16x9));
    const noVideo = results.filter(r => !r.hasVideo && !r.error);
    const totalUsable = landscape.length + portrait.length;

    console.log(`Candidate articles:          ${toCheck.length}`);
    console.log(`With Brightcove video:       ${results.filter(r => r.hasVideo).length}`);
    console.log(`  16:9 native (no treatment): ${landscape.length}`);
    console.log(`  9:16 portrait (pillarbox):  ${portrait.length}`);
    console.log(`  Total usable:               ${totalUsable}`);
    console.log(`Text-only (no video):        ${noVideo.length}`);

    console.log('\nAll usable clips:');
    [...landscape, ...portrait].forEach(r => {
      const section = r.url.replace(AJ_BASE, '').split('/')[1];
      const slug = r.url.split('/').filter(Boolean).pop();
      const max = r.dimensions.reduce((a, b) => (a.width > b.width ? a : b));
      const treatment = max.is16x9 ? '16:9 native' : `9:16 → Navy pillarbox + Gold border`;
      console.log(`  [/${section}/] ${max.width}x${max.height} [${treatment}]`);
      console.log(`    ${slug}`);
      console.log(`    IDs: ${r.videoIds.join(', ')}`);
    });

    // Step 5: Verdict
    console.log('\n=== PRODUCTION VERDICT ===');
    if (totalUsable >= 5) {
      console.log(`✅ STRONG: ${totalUsable} usable clips (${landscape.length} native 16:9 + ${portrait.length} pillarboxed 9:16)`);
      console.log('   → Sitemap approach is VALID for production. Handoff ready.');
      if (portrait.length > 0) {
        console.log(`   → 9:16 clips will be pillarboxed: Navy ${BRAND_NAVY} sides + Gold ${BRAND_GOLD} seam borders`);
      }
    } else if (totalUsable >= 3) {
      console.log(`✅ SUFFICIENT: ${totalUsable} usable clips — enough for a 5-story episode`);
      console.log('   → Consider 3-day lookback if pool is consistently thin.');
    } else {
      console.log(`⚠️  THIN: Only ${totalUsable} usable clips. Try broader keywords or 3-day lookback.`);
    }

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
