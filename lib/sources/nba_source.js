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

  const toArray = (v) => !v ? [] : Array.isArray(v) ? v : [v];

  const hasUrl = (v) => {
    const src = (v?.links?.source) || {};
    const hls = src.HLS || {};
    return !!(hls.HD?.href || hls.href || src.HD?.href || src.mezzanine?.href);
  };

  const extractUrl = (v) => {
    const src = v?.links?.source || {};
    return src.HLS?.HD?.href || src.HLS?.href || src.HD?.href || src.mezzanine?.href || '';
  };

  // For long-form: prefer clips with "Game Highlights" in the title (the actual compiled reel).
  // Player feature clips ("Ant drops 36 points", 109s) can exceed the "Game Highlights" reel
  // (107s) by a few seconds, making pure duration selection unreliable.
  // Fall back to longest if no "Game Highlights" titled clip exists.
  const isHighlightsReel = (v) => /game highlights|highlights$/i.test(v.headline || v.title || v.description || '');

  const selectHighlightVideo = (topVideos, articleVideos) => {
    const merged = [...toArray(topVideos), ...toArray(articleVideos)].filter(hasUrl);
    if (!merged.length) return null;
    // Prefer "Game Highlights" reel by title, then fall back to longest
    const highlightsCandidates = merged.filter(isHighlightsReel);
    const pool = highlightsCandidates.length > 0 ? highlightsCandidates : merged;
    const chosen = pool.slice().sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
    const tag = highlightsCandidates.length > 0 ? 'Game Highlights reel' : 'longest (no highlights title found)';
    console.log(`[selectHighlightVideo] ✅ ${tag} → "${chosen.headline||'?'}" (${chosen.duration||'?'}s)`);
    return chosen;
  };

  // For nba-short: find a clip in the merged pool whose duration matches the user-selected
  // clip so we can get a fresh URL for the SAME clip rather than replacing it with the
  // highlights reel.
  const findClipByDuration = (topVideos, articleVideos, targetDuration) => {
    if (!targetDuration) return null;
    const merged = [...toArray(topVideos), ...toArray(articleVideos)].filter(hasUrl);
    // Allow ±2s tolerance for duration matching
    const match = merged.find(v => Math.abs((v.duration || 0) - targetDuration) <= 2);
    if (match) console.log(`[findClipByDuration] ✅ Matched "${match.headline||'?'}" (${match.duration}s) for target ${targetDuration}s`);
    return match || null;
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
  const isShortForm = type === 'nba-short';
  // Re-fetch fresh ESPN URLs immediately before analysis — article.video URLs expire in seconds.
  // For nba-short: user picked a specific clip — find that SAME clip in the fresh pool by
  // duration so we get a fresh URL for THEIR clip, not the highlights reel. If no match is
  // found, keep the original URL (may still be valid if job started soon after picking).
  await Promise.all(items.map(async (item) => {
    if (!item.gameId) return;
    try {
      const summaryUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${item.gameId}`;
      const resp = await axios.get(summaryUrl, { timeout: 10000 });
      const summaryData = resp.data || {};
      const topVideos = summaryData.videos || [];
      const articleVideos = summaryData.article?.video || null;

      if (isShortForm && item.clipDuration) {
        // Short-form: find the specific clip the user selected by matching duration
        const matchedClip = findClipByDuration(topVideos, articleVideos, item.clipDuration);
        if (matchedClip) {
          const freshUrl = extractUrl(matchedClip);
          if (freshUrl) {
            item.clipUrl = freshUrl;
            console.log(`[nba-fresh-url] ✅ Short-form: refreshed user-selected clip "${matchedClip.headline||'?'}" (${matchedClip.duration}s) for ${item.gameId}`);
          } else {
            console.warn(`[nba-fresh-url] ⚠️ Short-form: matched clip has no extractable URL — keeping original for ${item.gameId}`);
          }
        } else {
          console.warn(`[nba-fresh-url] ⚠️ Short-form: no duration match for ${item.clipDuration}s in ${item.gameId} — keeping original picker URL`);
        }
      } else {
        // Long-form (or short-form without stored duration): pick the longest clip as highlights reel
        const hlVideo = selectHighlightVideo(topVideos, articleVideos);
        if (hlVideo) {
          const freshUrl = extractUrl(hlVideo);
          if (freshUrl) {
            item.clipUrl = freshUrl;
            // Store headline so script writer knows who won without guessing from jersey colors
            item.clipHeadline = hlVideo.headline || hlVideo.title || '';
            console.log(`[nba-fresh-url] ✅ Refreshed clip URL for ${item.gameId} [${freshUrl.includes('.m3u8') ? 'HLS' : 'MP4'}] "${hlVideo.headline||'?'}"`);
          }
        }
      }

      // Extract confirmed player names from ESPN leaders — prevents Gemini from hallucinating
      // stale roster data (e.g. Trae Young was traded to Dallas, no longer on Atlanta)
      const leaderTeams = summaryData.leaders || [];
      const playersByTeam = {};
      for (const teamEntry of leaderTeams) {
        const abbr = teamEntry.team?.abbreviation || teamEntry.team?.displayName || '';
        if (!abbr) continue;
        const names = new Set();
        for (const cat of (teamEntry.leaders || [])) {
          for (const l of (cat.leaders || [])) {
            const n = l.athlete?.displayName;
            if (n) names.add(n);
          }
        }
        if (names.size > 0) playersByTeam[abbr] = [...names];
      }
      if (Object.keys(playersByTeam).length > 0) {
        item.playerContext = playersByTeam;
        console.log(`[nba-players] ✅ ${item.gameId} roster context:`, JSON.stringify(playersByTeam));
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
        const articleVideos2 = summaryData2.article?.video || null;

        if (isShortForm && item.clipDuration) {
          const matchedClip2 = findClipByDuration(topVideos2, articleVideos2, item.clipDuration);
          if (matchedClip2) {
            const freshUrl = extractUrl(matchedClip2);
            if (freshUrl) { item.clipUrl = freshUrl; console.log(`[gate0-retry] ✅ Short-form clip "${matchedClip2.headline||'?'}" (${matchedClip2.duration}s) for ${item.gameId}`); }
          } else {
            console.warn(`[gate0-retry] ⚠️ Short-form: no duration match for ${item.clipDuration}s — keeping existing URL for ${item.gameId}`);
          }
        } else {
          const hlVideo2 = selectHighlightVideo(topVideos2, articleVideos2);
          if (hlVideo2) {
            const freshUrl = extractUrl(hlVideo2);
            if (freshUrl) { item.clipUrl = freshUrl; console.log(`[gate0-retry] ✅ Fresh URL for ${item.gameId} "${hlVideo2.headline||'?'}"`); }
          }
        }

        // Preserve player context if not already set
        if (!item.playerContext) {
          const leaderTeams2 = summaryData2.leaders || [];
          const pc2 = {};
          for (const te of leaderTeams2) {
            const abbr = te.team?.abbreviation || te.team?.displayName || '';
            if (!abbr) continue;
            const names = new Set();
            for (const cat of (te.leaders || [])) {
              for (const l of (cat.leaders || [])) { const n = l.athlete?.displayName; if (n) names.add(n); }
            }
            if (names.size > 0) pc2[abbr] = [...names];
          }
          if (Object.keys(pc2).length > 0) item.playerContext = pc2;
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

  // ── Gate 0 roster cross-check — scan Gemini's analysis for wrong player names ──
  // If playerContext is confirmed (ESPN boxscore), any name in the analysis not on either
  // team's roster is Gemini hallucinating from stale training data.
  // Flag the poisoned analysis so Gate 1 knows the analysis is unreliable.
  analyses = analyses.map((analysis, i) => {
    const item = items[i];
    if (!analysis || !item?.playerContext) return analysis;
    const confirmedNames = new Set(
      Object.values(item.playerContext).flat().map(n => n.toLowerCase())
    );
    if (confirmedNames.size === 0) return analysis;
    // Extract capitalized name pairs from analysis text
    const namePattern = /\b([A-Z][a-z]{1,12})\s+([A-Z][a-z]{1,12})\b/g;
    const wrongNames = [];
    for (const match of [...analysis.matchAll(namePattern)]) {
      const full = `${match[1]} ${match[2]}`;
      const lower = full.toLowerCase();
      // Skip team names and generic broadcast phrases
      if (!confirmedNames.has(lower) && !/quarter|half|period|game\s+\d|first|second|third|fourth|final|overtime/i.test(full)) {
        const count = (analysis.match(new RegExp(full.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        if (count >= 2 && !wrongNames.find(n => n.name === full)) {
          wrongNames.push({ name: full, count });
        }
      }
    }
    if (wrongNames.length > 0) {
      const badNames = wrongNames.map(n => `${n.name} (${n.count}x)`).join(', ');
      const correctedNames = Object.entries(item.playerContext)
        .map(([team, names]) => `${team}: ${names.join(', ')}`)
        .join(' | ');
      console.warn(`[nba_source] ⚠️ GATE0_ANALYSIS_WRONG_PLAYERS: ${item.away} vs ${item.home} — Gemini used non-roster names: ${badNames}. Confirmed: ${correctedNames}`);
      // Append a correction notice to the analysis so Gate 1 sees it
      return analysis + `\n\n⚠️ GATE0_ROSTER_WARNING: The following names in this analysis may be wrong (not in ESPN boxscore): ${badNames}. Confirmed active players — ${correctedNames}. Script generation MUST use only confirmed player names.`;
    }
    return analysis;
  });

  // NBA orderedClipUrls — one entry per game using the (refreshed) clip URL
  // NOTE: NBA clips don't expire the same way as Twitch CDN URLs, so the refreshed URL
  // is suitable for assembly. Re-fetch at assembly time if needed.
  const orderedClipUrls = items.map((item, i) => {
    const timingTargets = extractNbaTimingTargets(analyses[i] || '');
    return {
      url:             item.clipUrl || item.localPath || '',
      clipUrl:         item.clipUrl || item.localPath || '',
      pageUrl:         item.clipUrl || '',
      label:           `GAME${i + 1}_CLIP`,
      streamer:        `game_${i + 1}`,
      title:           `${item.away || '?'} vs ${item.home || '?'}`,
      gameId:          item.gameId || '',
      imageUrl:        item.thumbnailUrl || '',
      orientation:     'landscape', // ESPN highlights are always 16:9 — assembly uses default crop
      pillarboxFilter: null,
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
