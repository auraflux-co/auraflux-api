'use strict';
/**
 * nba_source.js — Phase 3 universal architecture source module
 *
 * Extracted verbatim from handleGenerateFullScript (lib/script_gen.js lines ~1416-1486).
 * Drops games without clip URLs (Gate 0), re-fetches fresh ESPN HLS URLs,
 * and runs Gemini clip analysis.
 *
 * Exports: async function fetchData({ items, type, jobId }, cfg)
 * Returns: { analyses, orderedClipUrls, clipReportDataForQA }
 *
 * NOTE: items array is mutated in-place (items without clipUrl are spliced out).
 */

const axios = require('axios');

/**
 * fetchData — validate, refresh, and analyze NBA highlight clips.
 *
 * @param {Object} params
 * @param {Array}  params.items  - Array of NBA game objects from the dashboard request
 * @param {string} params.type   - 'nba' or 'nba-short'
 * @param {string} params.jobId  - Job ID (unused here, reserved)
 * @param {Function} params.geminiAnalyzeClip - geminiAnalyzeClip function from script_gen.js
 * @param {Object} cfg - Content-type config from configLoader (unused, reserved)
 *
 * @returns {Promise<{
 *   analyses: Array,
 *   orderedClipUrls: Array,
 *   clipReportDataForQA: null,
 * }>}
 * items is mutated in-place.
 */
async function fetchData({ items, type, jobId, geminiAnalyzeClip }, cfg) {
  // Gate 0: Drop games with no clipUrl, proceed with valid games only (count varies by day)
  const beforeDrop = items.length;
  const missingClipUrl = items.filter(item => !item.clipUrl);
  if (missingClipUrl.length > 0) {
    const missingGames = missingClipUrl.map(i => `${i.away || '?'} vs ${i.home || i.gameId || '?'}`).join(', ');
    console.warn(`[nba_source] Gate 0: Dropping ${missingClipUrl.length}/${beforeDrop} NBA games with no clip URL: ${missingGames}`);
    items.splice(0, items.length, ...items.filter(item => !!item.clipUrl));
  }
  if (items.length === 0) {
    const errMsg = `Gate 0 FAIL: No NBA games have highlight clip URLs today. Run SELECT GAMES → wait for scraper to complete → retry.`;
    console.error(`[nba_source] ${errMsg}`);
    throw new Error(errMsg);
  }
  console.log(`[nba_source] Analyzing ${items.length} NBA highlight clip${items.length !== 1 ? 's' : ''} (dropped ${beforeDrop - items.length} with no URL)...`);
  // Re-fetch fresh ESPN URLs immediately before analysis — article.video URLs expire in seconds
  await Promise.all(items.map(async (item) => {
    if (!item.gameId) return;
    try {
      const summaryUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${item.gameId}`;
      const resp = await axios.get(summaryUrl, { timeout: 10000 });
      const summaryData = resp.data || {};
      const articleVideos = (summaryData.article && summaryData.article.video) || [];
      if (articleVideos.length) {
        const v = articleVideos[0];
        // Prefer Akamai HLS (stable) over direct CDN MP4 (expires in seconds)
        const freshUrl = v.links?.source?.HLS?.HD?.href
                      || v.links?.source?.HLS?.href
                      || v.links?.source?.HD?.href;
        if (freshUrl) {
          item.clipUrl = freshUrl;
          console.log(`[nba-fresh-url] ✅ Refreshed clip URL for ${item.gameId} [${freshUrl.includes('.m3u8') ? 'HLS' : 'MP4'}]`);
        }
      }
    } catch(e) {
      console.warn(`[nba-fresh-url] Failed to refresh URL for ${item.gameId}: ${e.message}`);
    }
  }));
  let analyses = await Promise.all(
    items.map(item => geminiAnalyzeClip(item.localPath || item.clipUrl||'', item.thumbnailUrl||'', 'nba', item))
  );
  let nbaHits = analyses.filter(a => a && a.length > 50).length;
  console.log(`[nba_source] Got ${nbaHits}/${items.length} NBA analyses (${nbaHits} video, ${items.length - nbaHits} thumbnail/fallback)`);

  // Gate 0: All games must have video analysis — thumbnail fallback = fabricated narration
  if (nbaHits < items.length) {
    console.warn(`[nba_source] Gate 0: ${nbaHits}/${items.length} video analyses — HLS URLs likely expired. Re-fetching fresh URLs and retrying...`);
    await Promise.all(items.map(async (item) => {
      if (!item.gameId) return;
      try {
        const summaryUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${item.gameId}`;
        const resp = await axios.get(summaryUrl, { timeout: 10000 });
        const articleVideos = ((resp.data || {}).article || {}).video || [];
        if (articleVideos.length) {
          const v = articleVideos[0];
          const freshUrl = v.links?.source?.HLS?.HD?.href || v.links?.source?.HLS?.href || v.links?.source?.HD?.href;
          if (freshUrl) { item.clipUrl = freshUrl; console.log(`[gate0-retry] ✅ Fresh URL for ${item.gameId}`); }
        }
      } catch(e) { console.warn(`[gate0-retry] Failed to refresh ${item.gameId}: ${e.message}`); }
    }));
    analyses = await Promise.all(
      items.map(item => geminiAnalyzeClip(item.localPath || item.clipUrl||'', item.thumbnailUrl||'', 'nba', item))
    );
    nbaHits = analyses.filter(a => a && a.length > 50).length;
    console.log(`[nba_source] Gate 0 retry: Got ${nbaHits}/${items.length} NBA analyses`);
    if (nbaHits < items.length) {
      const failedGames = items.filter((_, i) => !analyses[i] || analyses[i].length <= 50).map(g => `${g.away} vs ${g.home}`).join(', ');
      throw new Error(`Gate 0 FAIL: Only ${nbaHits}/${items.length} NBA clips analyzed after retry. Failed: ${failedGames}. HLS streams may be unavailable. Try again in a few minutes.`);
    }
  }

  // NBA orderedClipUrls — one entry per game using the (refreshed) clip URL
  // NOTE: NBA clips don't expire the same way as Twitch CDN URLs, so the refreshed URL
  // is suitable for assembly. Re-fetch at assembly time if needed.
  const orderedClipUrls = items.map((item, i) => ({
    url:      item.clipUrl || item.localPath || '',
    pageUrl:  item.clipUrl || '',
    label:    `GAME${i + 1}_CLIP`,
    streamer: `game_${i + 1}`,
    title:    `${item.away || '?'} vs ${item.home || '?'}`,
    gameId:   item.gameId || ''
  }));

  return {
    analyses,
    orderedClipUrls,
    // NBA has no clipReportDataForQA — Gate 1 QA doesn't need it
    clipReportDataForQA: null
  };
}

module.exports = { fetchData };
