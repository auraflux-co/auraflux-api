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

function parseTimeToSeconds(token) {
  const raw = String(token || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'end') return 'end';
  const parts = raw.split(':').map(p => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 3) return null;
  const nums = parts.map(p => Number(p));
  if (nums.some(n => !Number.isFinite(n) || n < 0)) return null;
  if (nums.length === 2) return (nums[0] * 60) + nums[1];
  if (nums.length === 3) return (nums[0] * 3600) + (nums[1] * 60) + nums[2];
  return nums[0];
}

function extractNbaTimingTargets(analysisText) {
  const lines = String(analysisText || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const rows = [];
  for (const line of lines) {
    const clean = line.replace(/^\|/, '').replace(/\|$/, '').trim();
    if (!clean || /timestamp/i.test(clean) && /narration/i.test(clean)) continue;
    if (/^-{2,}$/.test(clean.replace(/\|/g, '').replace(/\s/g, ''))) continue;

    // Supports:
    // 1) 0:00-0:02 | Narration...
    // 2) | 0:00-0:02 | Narration... |
    // 3) 0:00-0:02 - Narration...
    const m = clean.match(/^([0-9:]{1,8})\s*-\s*([0-9:]{1,8}|end)\s*(?:\||-)\s*(.+)$/i);
    if (!m) continue;

    const startSec = parseTimeToSeconds(m[1]);
    const endToken = parseTimeToSeconds(m[2]);
    const narration = String(m[3] || '').trim();
    if (!Number.isFinite(startSec) || (!Number.isFinite(endToken) && endToken !== 'end') || !narration) continue;

    rows.push({
      startSec,
      endSec: endToken === 'end' ? null : endToken,
      narration
    });
  }

  // Normalize to monotonic non-overlapping windows.
  const targets = [];
  let prevEnd = 0;
  for (const row of rows) {
    const startSec = Math.max(prevEnd, row.startSec);
    const endSec = row.endSec == null ? null : Math.max(startSec + 0.05, row.endSec);
    targets.push({
      startSec: Number(startSec.toFixed(3)),
      endSec: endSec == null ? null : Number(endSec.toFixed(3)),
      narration: row.narration
    });
    prevEnd = endSec == null ? startSec : endSec;
  }
  return targets;
}

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
  const gate0Strategy = cfg?.gate0Strategy || {};
  const strategyPhase = String(gate0Strategy.phase || 'worker_attempt');
  const strategyPassType = String(gate0Strategy.passType || 'attempt');
  const strategyPassNumber = Number(gate0Strategy.passNumber || 0);
  console.log(`[nba_source] Gate0 strategy: phase=${strategyPhase} passType=${strategyPassType} passNumber=${strategyPassNumber}`);

  const selectHighlightVideo = (topVideos, articleVideos) => {
    const allTop = Array.isArray(topVideos) ? topVideos : [];
    const allArticle = Array.isArray(articleVideos) ? articleVideos : [];
    const hlRank = (v) => {
      const h = String(v?.headline || '').toLowerCase();
      if (h.includes('highlights')) return 3;
      if (h.includes('highlight')) return 2;
      if (h.includes('recap')) return 1;
      return 0;
    };
    if (strategyPassType === 'intervention' || strategyPassNumber >= 2) {
      const articleSorted = allArticle.slice().sort((a, b) => hlRank(b) - hlRank(a));
      return articleSorted[0] || allTop.slice().sort((a, b) => hlRank(b) - hlRank(a))[0] || null;
    }
    const topSorted = allTop.slice().sort((a, b) => hlRank(b) - hlRank(a));
    return topSorted[0] || allArticle.slice().sort((a, b) => hlRank(b) - hlRank(a))[0] || null;
  };
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
      // Check videos[] first (main highlights array), then article.video fallback
      const topVideos = summaryData.videos || [];
      const articleVideos = (summaryData.article && summaryData.article.video) || [];
      // Find Game Highlights video first, then any video
      const hlVideo = selectHighlightVideo(topVideos, articleVideos);
      if (hlVideo) {
        const src = hlVideo.links?.source || {};
        const freshUrl = src.HLS?.HD?.href || src.HLS?.href || src.HD?.href || src.mezzanine?.href;
        if (freshUrl) {
          item.clipUrl = freshUrl;
          console.log(`[nba-fresh-url] ✅ Refreshed clip URL for ${item.gameId} [${freshUrl.includes('.m3u8') ? 'HLS' : 'MP4'}] "${hlVideo.headline||'?'}"`);
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
        const summaryData2 = resp.data || {};
        const topVideos2 = summaryData2.videos || [];
        const articleVideos2 = (summaryData2.article?.video) || [];
        const hlVideo2 = selectHighlightVideo(topVideos2, articleVideos2);
        if (hlVideo2) {
          const src2 = hlVideo2.links?.source || {};
          const freshUrl = src2.HLS?.HD?.href || src2.HLS?.href || src2.HD?.href || src2.mezzanine?.href;
          if (freshUrl) { item.clipUrl = freshUrl; console.log(`[gate0-retry] ✅ Fresh URL for ${item.gameId} "${hlVideo2.headline||'?'}"`); }
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
  const orderedClipUrls = items.map((item, i) => {
    const timingTargets = extractNbaTimingTargets(analyses[i] || '');
    return {
      url:      item.clipUrl || item.localPath || '',
      pageUrl:  item.clipUrl || '',
      label:    `GAME${i + 1}_CLIP`,
      streamer: `game_${i + 1}`,
      title:    `${item.away || '?'} vs ${item.home || '?'}`,
      gameId:   item.gameId || '',
      clipTimingTargets: timingTargets,
      clipTimingFormat: timingTargets.length > 0 ? 'timestamp_table' : 'none'
    };
  });

  return {
    analyses,
    orderedClipUrls,
    // NBA has no clipReportDataForQA — Gate 1 QA doesn't need it
    clipReportDataForQA: null
  };
}

module.exports = { fetchData };
