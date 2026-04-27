'use strict';
/**
 * news_source.js — Phase 3 universal architecture source module
 *
 * Extracted verbatim from handleGenerateFullScript (lib/script_gen.js lines ~1488-1613).
 * Prioritizes news stories, scrapes og:image + video URLs, runs Gemini analysis,
 * matches to AJ Puppeteer video pool, and enforces Gate 0 (all stories must have video).
 *
 * Exports: async function fetchData({ items, type, jobId, ajVideoPool }, cfg)
 * Returns: { analyses, orderedClipUrls, clipReportDataForQA }
 *
 * NOTE: items array is mutated in-place (heroImageUrl, videoUrl, pillarboxFilter attached).
 *
 * PARTIAL EXTRACTION — Gate 0 HTTP response (lines ~1554-1586) is entangled with
 * express res object and job stuck marking. That block is left inline in
 * handleGenerateFullScript and marked # PHASE4_INLINE. This module returns a
 * { gate0Fail, gate0Data } property so the caller can handle the HTTP response.
 */

const axios = require('axios');

/**
 * fetchData — prioritize, scrape, and analyze news stories.
 *
 * @param {Object} params
 * @param {Array}  params.items        - Array of news story objects from dashboard request
 * @param {string} params.type         - 'news' or 'news-short'
 * @param {string} params.jobId        - Job ID for stuck-job marking
 * @param {Array}  params.ajVideoPool  - Pre-scraped AJ Puppeteer video pool (may be empty)
 * @param {Function} params.geminiAnalyzeClip  - geminiAnalyzeClip from script_gen.js
 * @param {Function} params.scrapeArticleOgImage  - scrapeArticleOgImage from script_gen.js
 * @param {Function} params.scrapeArticleVideo    - scrapeArticleVideo from script_gen.js
 * @param {Function} params.prioritizeNewsStories - prioritizeNewsStories from script_gen.js
 * @param {Function} params.matchStoryToAjVideo   - matchStoryToAjVideo from script_gen.js
 * @param {Object} cfg - Content-type config from configLoader (unused, reserved)
 *
 * @returns {Promise<{
 *   analyses: Array,
 *   orderedClipUrls: Array,
 *   clipReportDataForQA: null,
 *   gate0Fail: boolean,
 *   gate0Data: Object|null,   // populated only when gate0Fail=true
 * }>}
 * items is mutated in-place.
 */
async function fetchData({
  items,
  type,
  jobId,
  ajVideoPool = [],
  geminiAnalyzeClip,
  scrapeArticleOgImage,
  scrapeArticleVideo,
  prioritizeNewsStories,
  matchStoryToAjVideo
}, cfg) {
  const gate0Strategy = cfg?.gate0Strategy || {};
  const strategyPhase = String(gate0Strategy.phase || 'worker_attempt');
  const strategyPassType = String(gate0Strategy.passType || 'attempt');
  const strategyPassNumber = Number(gate0Strategy.passNumber || 0);
  console.log(`[news_source] Gate0 strategy: phase=${strategyPhase} passType=${strategyPassType} passNumber=${strategyPassNumber}`);

  // Prioritize stories by urgency before Gemini analysis
  if (type === 'news' || type === 'news-short') {
    const prioritized = prioritizeNewsStories(items);
    const priorityChange = prioritized.map((s, i) => `${i+1}. ${(s.title||'').slice(0, 40)}`).join(', ');
    console.log(`[news_source] Story priority order: ${priorityChange}`);
    items.splice(0, items.length, ...prioritized);
  }
  // ── Fix 8B: Scrape og:image per story for TV card background ──
  // ── Fix 9: Scrape real video clips from Al Jazeera articles ──
  // Both run in parallel with Gemini analysis for speed.
  // Fix 8B: populates item.heroImageUrl for the top-right OVERLAY_ZONE TV card.
  // Fix 9: populates item.videoUrl so Fix 1's orderedClipUrls filter picks it up.
  //   Strategy: JSON-LD VideoObject → Brightcove embed URL → yt-dlp HLS manifest.
  //   Hit rate: ~30-40% on mixed RSS feed (100% on /video/ path articles).
  //   Non-fatal: stories without video get avatar-only segments (same as before Fix 9).
  console.log(`[news_source] Scraping og:image + video URLs for ${items.length} news articles...`);
  const ogImagePromises = items.map(item => scrapeArticleOgImage(item.link || item.url || ''));
  const videoScrapePromises = items.map(item => scrapeArticleVideo(item.link || item.url || ''));

  // News: try video URL from RSS enclosure first, then thumbnail + full article text
  console.log(`[news_source] Analyzing ${items.length} news stories...`);
  const [ogImages, scrapedVideoUrls, analysesResult] = await Promise.all([
    Promise.all(ogImagePromises),
    Promise.all(videoScrapePromises),
    Promise.all(items.map(item => geminiAnalyzeClip(item.videoUrl||'', item.thumbnailUrl||'', 'news', item)))
  ]);
  const analyses = analysesResult;

  // Attach scraped og:image URLs and video URLs to items
  items.forEach((item, i) => {
    item.heroImageUrl = ogImages[i] || item.thumbnailUrl || '';
    // Fix 9: attach scraped video URL — overrides any RSS enclosure URL
    // Fix 1's orderedClipUrls filter at line ~6758 picks this up automatically
    if (scrapedVideoUrls[i]) {
      item.videoUrl = scrapedVideoUrls[i];
    }
  });

  // ADD: Override with Puppeteer-scraped AJ video pool if available and better
  if (ajVideoPool && ajVideoPool.length > 0) {
    const portraitPool = ajVideoPool.filter(v => (v.orientation || '').toLowerCase() === 'portrait');
    const poolToUse = type === 'news' ? portraitPool : ajVideoPool;
    // Pool URLs come from scrape: hub-curated /news/… OR sitemap section paths only (US-first).
    const ALLOWED_AJ_ARTICLE_RE =
      /(\/(where\/united-states|us-canada)\/|\/news\/\d{4}\/\d{1,2}\/\d{1,2}\/)/i;
    items.forEach(item => {
      const match = matchStoryToAjVideo(item.title || item.link || '', poolToUse);
      if (match) {
        if (!ALLOWED_AJ_ARTICLE_RE.test(String(match.articleUrl || ''))) {
          console.log(`[news-video-match] ⏭  Rejecting non-allowed AJ path for "${(item.title || '').slice(0, 40)}": ${String(match.articleUrl || '')}`);
          return;
        }
        if (/\/features\//i.test(String(match.articleUrl || ''))) {
          console.log(`[news-video-match] ⏭  Rejecting /features/ match for "${(item.title || '').slice(0, 40)}"`);
          return;
        }
        item.videoUrl         = match.hlsUrl;
        item.pillarboxFilter  = match.pillarboxFilter || null; // null for landscape
        item.sourceOrientation = match.orientation;
        console.log(`[news-video-match] "${(item.title||'').slice(0,40)}" → ${match.orientation} HLS from ${match.articleUrl.slice(-60)}`);
      }
    });
    const poolHits = items.filter(i => i.sourceOrientation).length;
    if (type === 'news') {
      console.log(`[news-video-match] ${poolHits}/${items.length} stories matched to AJ PORTRAIT pool (${portraitPool.length}/${ajVideoPool.length} pool entries portrait)`);
    } else {
      console.log(`[news-video-match] ${poolHits}/${items.length} stories matched to AJ Puppeteer pool`);
    }
  }

  // Gate0 sendback/intervention: retry unresolved stories with alternate scrape pass.
  if ((strategyPassType === 'sendback' || strategyPassType === 'intervention') && (type === 'news' || type === 'news-short')) {
    const unresolved = items
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => !item.videoUrl);
    if (unresolved.length > 0) {
      console.log(`[news_source] Gate0 ${strategyPassType} pass ${strategyPassNumber}: retrying video scrape for ${unresolved.length} unresolved stor${unresolved.length === 1 ? 'y' : 'ies'}`);
      const secondPassUrls = await Promise.all(
        unresolved.map(({ item }) => scrapeArticleVideo(item.link || item.url || ''))
      );
      unresolved.forEach(({ item }, i) => {
        if (secondPassUrls[i]) item.videoUrl = secondPassUrls[i];
      });
    }
  }

  const heroHits = items.filter(i => i.heroImageUrl).length;
  const videoHits = items.filter(i => i.videoUrl).length;
  console.log(`[news_source] Got ${heroHits}/${items.length} og:image URLs (hero images for TV cards)`);
  console.log(`[news_source] Got ${videoHits}/${items.length} news video URLs (Fix 9 — Al Jazeera Brightcove scrape)`);

  const newsHits = analyses.filter(a => a && a.length > 50).length;
  console.log(`[news_source] Got ${newsHits}/${items.length} news analyses`);

  // ── Gate 0 analysis cross-check — verify Gemini's analysis aligns with confirmed article data ──
  // Detects cases where Gemini analyzed the wrong video, hallucinated content, or analyzed a
  // thumbnail instead of the actual article topic. Flags the poisoned analysis so Gate 1 can reject.
  analyses = analyses.map((analysis, i) => {
    const item = items[i];
    if (!analysis || !item?.title) return analysis;
    // Check if key topic words from the article title appear in the analysis
    const titleWords = (item.title || '').split(/\s+/).filter(w => w.length > 4);
    if (titleWords.length === 0) return analysis;
    const coveredCount = titleWords.filter(word =>
      new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(analysis)
    ).length;
    const coverageRatio = coveredCount / titleWords.length;
    // If fewer than 20% of title words appear in the analysis, Gemini likely analyzed the wrong content
    if (coverageRatio < 0.2) {
      const confirmedSource = item.source || 'Al Jazeera';
      console.warn(`[news_source] ⚠️ GATE0_TOPIC_MISMATCH: Analysis for "${item.title.slice(0, 50)}" has only ${Math.round(coverageRatio * 100)}% title keyword coverage — possible wrong-article or thumbnail-only analysis`);
      return analysis + `\n\n⚠️ GATE0_TOPIC_WARNING: This analysis may not match the confirmed article. Confirmed story: "${item.title}" (source: ${confirmedSource}). Script generation MUST align with this confirmed article — do NOT invent content not supported by this topic.`;
    }
    return analysis;
  });

  // ── Fix 25c: Pre-Gate-0 hard gate — block episode if any story lacks video ──
  // PHASE4_INLINE: Gate 0 HTTP response is handled inline in handleGenerateFullScript
  // because it needs express res object and jobId from the handler scope.
  // This module returns gate0Fail=true + gate0Data so the caller can issue the response.
  if (type === 'news') {
    // Product lock: News long-form should use AJ portrait source clips only.
    // If a story did not map to a confirmed portrait pool hit, clear fallback URLs so Gate 0
    // hard-fails and avoids low-quality landscape source clips.
    items.forEach((item) => {
      const isPortrait = (item.sourceOrientation || '').toLowerCase() === 'portrait';
      if (!isPortrait) {
        item.videoUrl = null;
        item.pillarboxFilter = null;
      }
    });

    const expectedClipCount = items.length;
    const actualClipCount = items.filter(i => i.videoUrl && typeof i.videoUrl === 'string').length;
    if (actualClipCount < expectedClipCount) {
      const missingStories = items
        .filter(i => !i.videoUrl)
        .map(i => i.title || i.link || '(unknown)');

      // Mark stuck via HTTP endpoint (avoids circular dependency on server.js)
      if (jobId) {
        const reason = `Gate 0: News scraper found ${actualClipCount}/${expectedClipCount} clips with confirmed video. Missing stories: ${missingStories.slice(0, 3).join(' | ')}${missingStories.length > 3 ? ` (+${missingStories.length - 3} more)` : ''}. AJ sitemap may be down or returning no US content today.`;
        try {
          await axios.post(`http://localhost:${process.env.PORT || 3000}/job/${jobId}/stuck`, {
            gate: 'gate0',
            reason,
            detail: { actualClipCount, expectedClipCount, missingStories: missingStories.slice(0, 5) }
          }, { timeout: 5000 });
        } catch (e) {
          console.warn(`[news-clip-gate] Failed to mark job stuck: ${e.message}`);
        }
      }

      return {
        analyses,
        orderedClipUrls: [],
        clipReportDataForQA: null,
        gate0Fail: true,
        gate0Data: {
          expectedClipCount,
          actualClipCount,
          missingStories,
          errorMsg: `NEWS_CLIP_GATE_FAIL: ${actualClipCount} of ${expectedClipCount} selected stories have video. Missing: ${missingStories.join(' | ')}. Retry with a different selection or wait for fresh content.`
        }
      };
    }
    console.log(`[news-clip-gate] ✅ PASS — ${actualClipCount}/${expectedClipCount} stories have video, proceeding to Gemini analysis`);
  }

  // Build orderedClipUrls for News — one entry per story, using the video URL
  // that Gemini analyzed (same URL used for assembly — news clips don't expire like Twitch CDN)
  // FIX: orderedClipUrls was only populated in the Twitch block (line 6172 comment says so).
  // News and NBA were added later but this step was never added — causing 22_avatar_0_clips output.
  let orderedClipUrls = [];
  if (type === 'news') {
    // Fix 6: preserve story-index alignment — keep null entries for stories without clips.
    // Previously .filter(c => c.url) dropped failed scrapes, destroying index alignment:
    // stories 1/2/4 scraped → filtered array [clip1,clip2,clip4] → poller mispairs clip4 to STORY3_SETUP.
    // Now: null entries are preserved; heygen-poller skips them cleanly.
    orderedClipUrls = items.map((item, i) => {
      const videoUrl = item.videoUrl || item.clipUrl || null;
      return {
        url:        videoUrl,
        clipUrl:    videoUrl,
        pageUrl:    item.link || item.url || '',
        label:      `STORY${i + 1}_CLIP`,
        streamer:   `story_${i + 1}`,
        title:      item.title || `Story ${i + 1}`,
        category:   item.category || 'WORLD NEWS',
        source:     item.source || 'Al Jazeera',
        imageUrl:   item.heroImageUrl || item.thumbnailUrl || null,
        storyIndex: i
      };
    });
    const clipsWithUrl = orderedClipUrls.filter(c => c.url).length;
    console.log(`[news_source] Built News orderedClipUrls: ${clipsWithUrl}/${items.length} stories have clip URLs (${items.length - clipsWithUrl} null placeholders preserved for index alignment)`);
  }

  return {
    analyses,
    orderedClipUrls,
    clipReportDataForQA: null,
    gate0Fail: false,
    gate0Data: null
  };
}

module.exports = { fetchData };
