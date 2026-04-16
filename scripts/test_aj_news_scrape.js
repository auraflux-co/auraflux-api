#!/usr/bin/env node
/**
 * test_aj_news_scrape.js
 *
 * Tests scraping /us-canada/ for /news/ article links,
 * then checks each article for embedded video (Brightcove or otherwise).
 *
 * Run: node scripts/test_aj_news_scrape.js
 */

const axios = require('axios');
const cheerio = require('cheerio');

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function checkArticleForVideo(url) {
  try {
    const resp = await axios.get(url, { timeout: 8000, headers: BROWSER_HEADERS });
    const $ = cheerio.load(resp.data);
    const html = resp.data;

    const result = { url, hasVideo: false, videoType: null, videoId: null, posterUrl: null };

    // Check 1: Brightcove video-js player with data-video-id
    const bcPlayer = $('video-js[data-video-id], [data-video-id]').first();
    if (bcPlayer.length) {
      result.hasVideo = true;
      result.videoType = 'brightcove';
      result.videoId = bcPlayer.attr('data-video-id');
      result.posterUrl = $('picture.vjs-poster img').first().attr('src') || null;
      return result;
    }

    // Check 2: Brightcove video ID in JSON-LD or inline script
    const bcIdMatch = html.match(/"videoId"\s*:\s*"(\d+)"|data-video-id="(\d+)"|bcVid=(\d+)/);
    if (bcIdMatch) {
      result.hasVideo = true;
      result.videoType = 'brightcove';
      result.videoId = bcIdMatch[1] || bcIdMatch[2] || bcIdMatch[3];
      return result;
    }

    // Check 3: boltdns CDN image (Brightcove thumbnail = video exists)
    const boltdnsImg = html.match(/cf-images[^"']*boltdns[^"']*1920x1080[^"']*/);
    if (boltdnsImg) {
      result.hasVideo = true;
      result.videoType = 'brightcove-inferred';
      result.posterUrl = 'https://' + boltdnsImg[0];
      return result;
    }

    // Check 4: JSON-LD VideoObject
    const jsonLdMatch = html.match(/"@type"\s*:\s*"VideoObject"[^}]*"embedUrl"\s*:\s*"([^"]+)"/);
    if (jsonLdMatch) {
      result.hasVideo = true;
      result.videoType = 'json-ld-video';
      result.embedUrl = jsonLdMatch[1];
      return result;
    }

    // Check 5: Standard HTML5 video tag
    const videoTag = $('video[src], video source[src]').first();
    if (videoTag.length) {
      result.hasVideo = true;
      result.videoType = 'html5-video';
      result.src = videoTag.attr('src') || videoTag.find('source').attr('src');
      return result;
    }

    return result;
  } catch (e) {
    return { url, hasVideo: false, videoType: null, error: e.message };
  }
}

async function main() {
  console.log('Fetching Al Jazeera US-Canada page...\n');

  const resp = await axios.get('https://www.aljazeera.com/us-canada/', {
    timeout: 10000,
    headers: BROWSER_HEADERS
  });
  const $ = cheerio.load(resp.data);

  // Collect all /news/ article links (exclude liveblogs, longform, duplicates)
  const articleUrls = new Set();
  $('a[href^="/news/"]').each((i, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (href === '/news/') return;
    if (href.includes('/liveblog/')) return;
    if (href.includes('/longform/')) return;
    if (href.includes('#')) return;
    const dateMatch = href.match(/\/news\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
    if (!dateMatch) return;
    articleUrls.add(`https://www.aljazeera.com${href}`);
  });

  console.log(`Found ${articleUrls.size} news article links on US-Canada page\n`);
  console.log('Checking each for embedded video...\n');

  const results = [];
  for (const url of articleUrls) {
    process.stdout.write(`  Checking: ${url.split('/').slice(-2, -1)[0]}... `);
    const result = await checkArticleForVideo(url);
    results.push(result);
    if (result.hasVideo) {
      console.log(`✅ ${result.videoType}${result.videoId ? ' id=' + result.videoId : ''}`);
    } else if (result.error) {
      console.log(`❌ ERROR: ${result.error}`);
    } else {
      console.log('⚪ no video');
    }
    await new Promise(r => setTimeout(r, 300)); // polite delay
  }

  console.log('\n=== SUMMARY ===');
  const withVideo = results.filter(r => r.hasVideo);
  const byType = {};
  withVideo.forEach(r => { byType[r.videoType] = (byType[r.videoType] || 0) + 1; });

  console.log(`Total articles checked: ${results.length}`);
  console.log(`Articles with video: ${withVideo.length}`);
  console.log(`Video types found:`, byType);
  console.log('\nArticles with video:');
  withVideo.forEach(r => {
    console.log(`  [${r.videoType}] ${r.url}`);
    if (r.videoId) console.log(`    Brightcove ID: ${r.videoId}`);
  });
}

main().catch(console.error);
