'use strict';
/**
 * twitch_source.js — Phase 3 universal architecture source module
 * ⚠️  C0-ONLY: This source resolves Twitch GQL MP4 clip URLs for ClipzWorld.
 *    C1+ customers use generic source ingest (url_ingest / upload via POST /api/jobs).
 *    Do not extend this module for C1+ — create a new source adapter instead.
 *
 * Extracted verbatim from handleGenerateFullScript (lib/script_gen.js lines ~1134-1413).
 * Resolves GQL MP4 URLs, runs Gemini clip analysis, and early-downloads high-expiry clips.
 *
 * Exports: async function fetchData({ items, type, jobId }, cfg)
 * Returns: { items (mutated), analyses, orderedClipUrls, clipReportDataForQA }
 *
 * NOTE: items array is mutated in-place (display names, clips updated) — same behaviour
 * as the original inline code. Callers should pass the same items reference they use
 * downstream for Gemini script generation.
 */

const path = require('path');
const fs = require('fs');
const TwitchClient = require('../clients/twitch_client');
const { downloadFile } = require('../downloader');

const twitchClient = new TwitchClient();

function resolveTwitchClipMp4(slug, preferQuality) {
  return twitchClient.resolveClipMp4(slug, preferQuality);
}

function extractTwitchSlug(urlOrSlug) {
  return twitchClient.extractSlug(urlOrSlug);
}

function twitchThumbToMp4(thumbnailUrl) {
  return twitchClient.thumbnailToMp4(thumbnailUrl);
}

const STREAMER_DISPLAY_NAMES = {
  jasontheween: 'Jason',
  hasanabi: 'Hasan',
  adapt: 'Adapt',
  stableronaldo: 'Ron',
  lacy: 'Lacy',
  marlon: 'Marlon',
  cinna: 'Cinna',
  yonnajay: 'Yonna',
  jaycinco: 'Jay Cinco',
  maya: 'Maya',
  extraemily: 'ExtraEmily',
  yourragegaming: 'Rage',
};

// High-expiry streamers whose clips must be pre-downloaded immediately after GQL resolve
const HIGH_EXPIRY_STREAMERS = ['maya', 'extraemily'];

const TMP_DIR = path.join(__dirname, '..', '..', 'tmp');

/**
 * fetchData — resolve, analyze, and early-download Twitch clips.
 *
 * @param {Object} params
 * @param {Array}  params.items  - Array of streamer objects from the dashboard request
 * @param {string} params.type   - 'twitch' or 'twitch-short'
 * @param {string} params.jobId  - Job ID for logging
 * @param {Function} params.geminiAnalyzeClip - geminiAnalyzeClip function from script_gen.js
 * @param {Object} cfg - Content-type config; may include `gate0Strategy` (same contract as news/NBA).
 *
 * @returns {Promise<{
 *   analyses: Array,
 *   orderedClipUrls: Array,
 *   clipReportDataForQA: Object,
 * }>}
 * items is mutated in-place.
 */
async function fetchData({ items, type, jobId, geminiAnalyzeClip }, cfg) {
  const gate0Strategy = cfg?.gate0Strategy || {};
  const strategyPhase = String(gate0Strategy.phase || 'worker_attempt');
  const strategyPassType = String(gate0Strategy.passType || 'attempt');
  const strategyPassNumber = Number(gate0Strategy.passNumber || 0);
  console.log(
    `[twitch_source] Gate0 strategy: phase=${strategyPhase} passType=${strategyPassType} passNumber=${strategyPassNumber}`
  );

  const forceGqlRefresh = strategyPassType === 'sendback' || strategyPassType === 'intervention';
  const sequentialGql = strategyPassType === 'intervention' || strategyPassNumber >= 2;
  const preResolveDelayMs =
    (strategyPassType === 'sendback' ? 400 * strategyPassNumber : 0) +
    (strategyPassType === 'intervention' ? 900 + 400 * strategyPassNumber : 0);

  const allClips = [];
  items.forEach((item) => {
    const clips =
      item.clips && item.clips.length
        ? item.clips
        : [
            {
              thumbnailUrl: item.thumbnailUrl || '',
              title: item.title || '',
              game: item.game || '',
              url: item.url || '',
            },
          ];
    clips.forEach((clip) =>
      allClips.push({
        pageUrl: clip.url || '',
        mp4UrlDash: clip.mp4Url || '',
        thumbnailUrl: clip.thumbnailUrl || '',
        streamer: item.streamer,
        title: clip.title || '',
        game: clip.game || '',
        isBackup: clip.isBackup || false,
        targetClipsPerStreamer: item.targetClipsPerStreamer || 2,
      })
    );
  });

  // Apply display names to items before script generation
  items.forEach(function (item) {
    const twitch_name = (item.streamer || '').toLowerCase().replace(/\s+/g, '');
    item.displayName = STREAMER_DISPLAY_NAMES[twitch_name] || item.streamer;
  });
  console.log(`[twitch_source] Resolving GQL MP4 URLs for ${allClips.length} clips (batched)...`);

  if (preResolveDelayMs > 0) {
    console.log(`[twitch_source] Gate0 strategy delay ${preResolveDelayMs}ms before GQL`);
    await new Promise((r) => setTimeout(r, preResolveDelayMs));
  }

  async function resolveClip(clip) {
    if (!forceGqlRefresh && clip.mp4UrlDash && clip.mp4UrlDash.includes('sig=')) {
      clip.videoUrl = clip.mp4UrlDash;
      clip.assemblyUrl = clip.assemblyUrl || clip.mp4UrlDash;
      return;
    }
    const slug = extractTwitchSlug(clip.pageUrl);
    if (!slug) {
      clip.videoUrl = twitchThumbToMp4(clip.thumbnailUrl);
      return;
    }
    try {
      if (sequentialGql) {
        const resultHigh = await resolveTwitchClipMp4(slug, 'high');
        const resultLow = await resolveTwitchClipMp4(slug, 'low');
        clip.videoUrl = resultLow.mp4Url;
        clip.assemblyUrl = resultHigh.mp4Url;
        console.log(
          `[gql] ✓ ${clip.streamer} (sequential): Gemini=${resultLow.quality} Assembly=${resultHigh.quality}`
        );
      } else {
        const [resultLow, resultHigh] = await Promise.all([
          resolveTwitchClipMp4(slug, 'low'),
          resolveTwitchClipMp4(slug, 'high'),
        ]);
        clip.videoUrl = resultLow.mp4Url;
        clip.assemblyUrl = resultHigh.mp4Url;
        console.log(
          `[gql] ✓ ${clip.streamer}: Gemini=${resultLow.quality} Assembly=${resultHigh.quality}`
        );
      }
    } catch (e) {
      console.warn(`[gql] ✗ ${clip.streamer}: ${e.message}`);
      try {
        const resultLow = await resolveTwitchClipMp4(slug, 'low');
        clip.videoUrl = resultLow.mp4Url;
        clip.assemblyUrl = clip.assemblyUrl || resultLow.mp4Url;
        console.log(`[gql] ↺ ${clip.streamer}: recovered on low-only retry`);
      } catch (e2) {
        clip.videoUrl = twitchThumbToMp4(clip.thumbnailUrl);
      }
    }
  }

  // Resolve clips per streamer — use backups if primary clips fail GQL
  // Group by streamer, resolve in order, keep first targetClipsPerStreamer successes
  const resolvedByStreamer = {};
  const analysisClips = []; // final clips to analyze with Gemini

  // Get unique streamers in order
  const streamerOrder = [];
  allClips.forEach((c) => {
    if (!resolvedByStreamer[c.streamer]) {
      resolvedByStreamer[c.streamer] = [];
      streamerOrder.push(c.streamer);
    }
  });

  // Batch resolve all clips (including backups), 2 waves with 3s pause
  const mid = Math.ceil(allClips.length / 2);
  console.log(`[gql] Batch 1: ${mid} clips...`);
  await Promise.all(allClips.slice(0, mid).map(resolveClip));
  if (allClips.length > mid) {
    console.log(`[gql] Waiting 3s before batch 2 (${allClips.length - mid} clips)...`);
    await new Promise((r) => setTimeout(r, 3000));
    console.log(`[gql] Batch 2: ${allClips.length - mid} clips...`);
    await Promise.all(allClips.slice(mid).map(resolveClip));
  }

  if (forceGqlRefresh) {
    const weak = allClips.filter((c) => !c.videoUrl || !String(c.videoUrl).includes('sig='));
    if (weak.length > 0) {
      console.log(
        `[twitch_source] Gate0 ${strategyPassType}: second GQL pass for ${weak.length} clip(s) without signed URL`
      );
      await Promise.all(weak.map(resolveClip));
    }
  }

  // For each streamer, pick the first targetClipsPerStreamer clips that resolved OK
  // Fall back to backup clips if primary clips expired/were deleted
  let totalResolved = 0;
  streamerOrder.forEach((streamer) => {
    const streamerClips = allClips.filter((c) => c.streamer === streamer);
    const target =
      streamerClips[0] && streamerClips[0].targetClipsPerStreamer
        ? streamerClips[0].targetClipsPerStreamer
        : Math.ceil(streamerClips.length / 2);

    const good = streamerClips.filter((c) => c.videoUrl && c.videoUrl.includes('sig='));
    const bad = streamerClips.filter((c) => !c.videoUrl || !c.videoUrl.includes('sig='));

    const picked = good.slice(0, target);
    if (picked.length < target && bad.length) {
      // Not enough good clips — fill with thumbnail-fallback clips
      bad.slice(0, target - picked.length).forEach((c) => picked.push(c));
    }

    if (good.length < target) {
      console.log(
        `[gql] ${streamer}: ${good.length}/${target} resolved — ${target - good.length} expired/deleted, using backups`
      );
    }

    picked.forEach((c) => analysisClips.push(c));
    totalResolved += good.slice(0, target).length;
  });

  console.log(
    `[twitch_source] GQL resolved ${totalResolved}/${analysisClips.length} final clips with signed URLs. Analyzing with Gemini...`
  );

  // Build orderedClipUrls here while analysisClips is in scope
  // CRITICAL: url = assemblyUrl (high-quality CDN, may expire)
  //           pageUrl = permanent Twitch page URL → always re-resolve at assembly time
  //           geminiUrl = exact URL Gemini watched → used for QA verification
  const orderedClipUrls = analysisClips.map((c) => ({
    url: c.assemblyUrl || c.videoUrl || c.mp4UrlDash || c.url || '',
    pageUrl: c.pageUrl || c.url || '',
    geminiUrl: c.videoUrl || '', // exact URL Gemini watched — for QA mismatch detection
    streamer: c.streamer || '',
    displayName: c.displayName || c.streamer || '',
    title: c.title || '',
    isBackup: c.isBackup || false,
  }));
  console.log(`[twitch_source] Built orderedClipUrls: ${orderedClipUrls.length} clips`);

  // ── Early download: cache clips for streamers with known CDN expiry issues ──
  // Maya's clips expire within ~1 hour. Pre-download them now so assembly
  // always has a valid local copy regardless of how long HeyGen takes.
  const earlyDownloadDir = path.join(TMP_DIR, 'early_clips');
  if (!fs.existsSync(earlyDownloadDir)) fs.mkdirSync(earlyDownloadDir, { recursive: true });

  const earlyDownloadAll = strategyPassType === 'intervention' && strategyPassNumber >= 2;
  const earlyClips = orderedClipUrls.filter((c) => {
    if (!c.url || !String(c.url).includes('sig=')) return false;
    if (earlyDownloadAll) return true;
    return HIGH_EXPIRY_STREAMERS.includes((c.streamer || '').toLowerCase());
  });

  if (earlyClips.length > 0) {
    console.log(
      `[twitch_source] 📥 Early-downloading ${earlyClips.length} clip(s)${earlyDownloadAll ? ' (intervention: all signed)' : ' (high-expiry streamers)'}`
    );
    for (const clip of earlyClips) {
      const slug = extractTwitchSlug(clip.pageUrl) || extractTwitchSlug(clip.url) || '';
      const fname = `early_${slug || Date.now()}_${clip.streamer}.mp4`;
      const dest = path.join(earlyDownloadDir, fname);
      if (fs.existsSync(dest)) {
        clip.localCache = dest;
        continue;
      }
      try {
        // Always use fresh GQL token for early download
        let dlUrl = clip.url;
        if (slug) {
          const fresh = await resolveTwitchClipMp4(slug, 'high');
          dlUrl = fresh.mp4Url;
        }
        await downloadFile(dlUrl, dest);
        const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
        if (size > 10000) {
          clip.localCache = dest;
          console.log(`[early-dl] ✅ Cached: ${fname} (${(size / 1024 / 1024).toFixed(1)}MB)`);
        } else {
          console.warn(`[early-dl] ⚠️  Too small after download: ${fname}`);
          try {
            fs.unlinkSync(dest);
          } catch (e) {}
        }
      } catch (e) {
        console.warn(`[early-dl] ⚠️  Failed to early-download ${clip.streamer} clip: ${e.message}`);
      }
    }
  }

  // Replace allClips with the curated analysisClips for Gemini
  allClips.length = 0;
  analysisClips.forEach((c) => allClips.push(c));

  // Step 2: Gemini watches each clip — batched to avoid CDN rate limiting
  // Split into 3 waves: first third, 5s pause, second third, 5s pause, final third
  const WAVE_SIZE = Math.ceil(allClips.length / 3);
  const waves = [
    allClips.slice(0, WAVE_SIZE),
    allClips.slice(WAVE_SIZE, WAVE_SIZE * 2),
    allClips.slice(WAVE_SIZE * 2),
  ].filter((w) => w.length > 0);

  const flatAnalyses = [];
  for (let wi = 0; wi < waves.length; wi++) {
    if (wi > 0) {
      console.log(
        `[gemini] Wave ${wi + 1}: waiting 5s before next batch of ${waves[wi].length} clips...`
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
    console.log(`[gemini] Wave ${wi + 1}/${waves.length}: analyzing ${waves[wi].length} clips...`);
    const waveResults = await Promise.all(
      waves[wi].map((c) =>
        geminiAnalyzeClip(c.videoUrl, c.thumbnailUrl, 'twitch', {
          streamer: c.streamer,
          title: c.title,
          game: c.game,
          pageUrl: c.pageUrl,
        }).then((analysis) => {
          // Tag thumbnail-only analyses so Fix #6 can filter them out.
          // A clip is "video-analyzed" only if it had a signed CDN URL (sig=).
          const isVideoAnalyzed = !!(c.videoUrl && c.videoUrl.includes('sig='));
          return { analysis, isVideoAnalyzed };
        })
      )
    );
    flatAnalyses.push(...waveResults);
  }

  // Build analyses indexed by streamer name (not array position) to avoid order mismatch.
  // flatAnalyses is in streamerOrder sequence; items may be in a different order.
  // Keying by streamer name ensures Jason's analyses always go to Jason's item, etc.
  // Fix #6: flatAnalyses now contains {analysis, isVideoAnalyzed} objects — extract text + track video flag.
  const analysesByStreamer = {};
  const videoAnalyzedByStreamer = {}; // tracks how many clips had real video (sig=) per streamer
  let flatIdx = 0;
  streamerOrder.forEach((streamer) => {
    const streamerClips = allClips.filter((c) => c.streamer === streamer);
    const target =
      streamerClips[0] && streamerClips[0].targetClipsPerStreamer
        ? streamerClips[0].targetClipsPerStreamer
        : Math.ceil(streamerClips.length / 2);
    const count = Math.min(target, streamerClips.length);
    const slice = flatAnalyses.slice(flatIdx, flatIdx + count);
    // Extract plain text analyses (backward-compatible with both string and {analysis,isVideoAnalyzed} formats)
    analysesByStreamer[streamer] = slice.map((a) => (a && typeof a === 'object' ? a.analysis : a));
    // Count how many clips had real video analysis (not thumbnail fallback)
    videoAnalyzedByStreamer[streamer] = slice.filter((a) =>
      a && typeof a === 'object' ? a.isVideoAnalyzed : a && a.length > 50
    ).length;
    flatIdx += count;
  });
  // Build clipsByStreamer map from analysisClips (the clips that were ACTUALLY analyzed)
  // analysisClips is in streamerOrder, so we must iterate streamerOrder to slice correctly.
  const clipsByStreamer = {};
  let clipIdx = 0;
  streamerOrder.forEach((streamer) => {
    const streamerClips = allClips.filter((c) => c.streamer === streamer);
    const target =
      streamerClips[0] && streamerClips[0].targetClipsPerStreamer
        ? streamerClips[0].targetClipsPerStreamer
        : Math.ceil(streamerClips.length / 2);
    const count = Math.min(target, streamerClips.length);
    clipsByStreamer[streamer] = analysisClips.slice(clipIdx, clipIdx + count);
    clipIdx += count;
  });

  // Update items[].clips to match the clips that were actually analyzed
  items.forEach((item) => {
    const analyzedClips = clipsByStreamer[item.streamer] || [];
    item.clips = analyzedClips.map((c) => ({
      url: c.pageUrl,
      mp4Url: c.videoUrl,
      assemblyUrl: c.assemblyUrl,
      thumbnailUrl: c.thumbnailUrl,
      title: c.title,
      game: c.game,
      streamer: c.streamer,
      isBackup: c.isBackup || false,
    }));
  });

  console.log('[clip-mapping] Updated items[].clips to match analysisClips order');
  items.forEach((item) => {
    console.log(
      `  ${item.streamer}: ${item.clips.length} clips - ${item.clips.map((c) => (c.title || '').slice(0, 30)).join(', ')}`
    );
  });
  console.log('[clip-mapping] streamerOrder:', streamerOrder);
  console.log(
    '[clip-mapping] items order:',
    items.map((i) => i.streamer)
  );

  // Capture clip report data for Gate 1 why-doc (pass or fail)
  // Snapshot allClips and analysisClips now — they may be mutated later
  const clipReportDataForQA = {
    items,
    allClips: [...analysisClips], // allClips was replaced with analysisClips above
    streamerOrder: [...streamerOrder],
    analysisClips: [...analysisClips],
  };

  // Map analyses by streamer name (c918cad fix preserved)
  let analyses = items.map((item) => analysesByStreamer[item.streamer] || []);

  const analysisText = (a) => {
    if (!a) return '';
    if (typeof a === 'object' && a.analysis != null) return String(a.analysis);
    return String(a);
  };
  const geminiHits = flatAnalyses.filter((a) => analysisText(a).length > 50).length;
  const videoAnalyzedHits = flatAnalyses.filter(
    (a) => a && typeof a === 'object' && a.isVideoAnalyzed
  ).length;
  console.log(
    `[twitch_source] Gemini: ${geminiHits}/${flatAnalyses.length} non-trivial text, ` +
      `${videoAnalyzedHits}/${flatAnalyses.length} from signed video URLs`
  );

  // Fix #6: Filter out streamers with fewer than 2 real video clips (sig= URL).
  // Hard floor of 2 clips for long-form only — Bobby G's 7-scene block needs at least
  // 2 clips for setup/reaction variety. Short-form needs exactly 1 clip, so skip this guard.
  // Thumbnail fallback analyses are also >50 chars, so the old length check was broken —
  // it let streamers with 0 real clips through, causing Gemini to hallucinate content.
  if (type === 'twitch') {
    const MIN_CLIPS_PER_STREAMER = 2;
    const itemsBefore = items.length;
    const filteredPairs = items
      .map((item, i) => ({ item, analysis: analyses[i] }))
      .filter(
        ({ item }) => (videoAnalyzedByStreamer[item.streamer] || 0) >= MIN_CLIPS_PER_STREAMER
      );
    if (filteredPairs.length < itemsBefore) {
      const dropped = items
        .filter((item) => !filteredPairs.find((p) => p.item.streamer === item.streamer))
        .map((item) => `${item.streamer}(${videoAnalyzedByStreamer[item.streamer] || 0} clips)`);
      console.warn(
        `[twitch_source] ⚠️  Dropping ${itemsBefore - filteredPairs.length} streamers with <2 real clips: ${dropped.join(', ')}`
      );
      items.splice(0, items.length, ...filteredPairs.map((p) => p.item));
      analyses = filteredPairs.map((p) => p.analysis);
    }
    console.log(
      `[twitch_source] Streamers with ≥2 clips: ${items.length}/${itemsBefore} — ${items.map((i) => i.streamer).join(', ')}`
    );
  } else {
    // twitch-short: 1 clip per streamer is correct
    console.log(
      `[twitch_source] twitch-short: ${items.length} streamer(s), 1 clip each — skipping ≥2 clip guard`
    );
  }

  // ── Gate 0 analysis cross-check — verify Gemini's analysis mentions the confirmed streamer ──
  // Detects cases where Gemini analyzed the wrong clip or produced a generic/hallucinated description
  // that ignores the actual streamer being covered. Flags poisoned analyses for Gate 1.
  analyses = analyses.map((analysis, i) => {
    const item = items[i];
    if (!analysis || !item) return analysis;
    const displayName = item.displayName || item.streamer || '';
    const handle = (item.handle || item.twitchUsername || item.streamer || '').toLowerCase();
    if (!displayName) return analysis;
    // Check if either the display name or handle appears in the analysis
    const nameInAnalysis =
      new RegExp(`\\b${displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(
        analysis
      ) ||
      (handle &&
        new RegExp(`\\b${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(analysis));
    if (!nameInAnalysis) {
      console.warn(
        `[twitch_source] ⚠️ GATE0_STREAMER_MISSING: Analysis for "${displayName}" does not mention the streamer — may be wrong clip or thumbnail-only analysis`
      );
      return (
        analysis +
        `\n\n⚠️ GATE0_ENTITY_WARNING: This analysis does not mention the confirmed streamer "${displayName}". Confirmed entity: streamer="${displayName}", game="${item.game || 'unknown'}". Script generation MUST use the display name "${displayName}" (NOT the handle "${handle}") and MUST reference confirmed clip context — do NOT fabricate content about other streamers.`
      );
    }
    // Also check if the wrong form (handle) would be used instead of display name
    if (
      handle &&
      handle !== displayName.toLowerCase() &&
      new RegExp(`\\b${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(analysis) &&
      !new RegExp(`\\b${displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(analysis)
    ) {
      console.warn(
        `[twitch_source] ⚠️ GATE0_HANDLE_IN_ANALYSIS: Analysis uses handle "${handle}" instead of display name "${displayName}"`
      );
      return (
        analysis +
        `\n\n⚠️ GATE0_ENTITY_WARNING: Analysis uses Twitch handle "${handle}" — script MUST use display name "${displayName}" instead. The handle is a system identifier, not a brand name.`
      );
    }
    return analysis;
  });

  return {
    analyses,
    orderedClipUrls,
    clipReportDataForQA,
  };
}

module.exports = { fetchData };
