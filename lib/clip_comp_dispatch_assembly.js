'use strict';

/**
 * Fire /assemble for clip-comp cards — shared by hook confirm and legacy reassemble paths.
 */

const axios = require('axios');
const {
  buildClipCompSeoInput,
  generateClipCompCreativeBriefWithTimeout,
  buildRepurposeClipCompBrief,
} = require('./clip_comp_hooks');
const { resolveClipCompPublishContentType } = require('./clip_comp');

function clipCompClipCount(card = {}) {
  return (card.orderedClipUrls || []).length
    || (card.clipHookCandidates || []).length
    || (card.clipHookTitles || []).length
    || 1;
}

/** False when hooks.mode is whisper_only (FableFlow) — no burned hook card. */
function clipCompBurnedHooksEnabled(card = {}) {
  const { mergeCompCreative } = require('./clip_comp_creative');
  const cc = mergeCompCreative({
    preset: card.compCreative?.preset || card.compCreativePreset,
    overrides: card.compCreative || {},
  });
  return cc.hooks?.mode !== 'whisper_only';
}

/** True when operator must pick/confirm hooks before the first FFmpeg burn. */
function needsHookBeforeAssembly(card = {}) {
  if (!card.clipsOnly) return false;
  const needsFirstBuild = !card.assembledAt && !card.driveUrl && !(card.burnedHookTitles || []).length;
  // whisper_only: no hook pick, but first assemble still required (stuck hook_review leftovers)
  if (!clipCompBurnedHooksEnabled(card)) return needsFirstBuild;
  if (card.stage === 'hook_review') return true;
  return needsFirstBuild;
}

function buildAssemblePayload(card = {}, jobId) {
  const orderedClipUrls = card.orderedClipUrls || [];
  const { pickStableLibraryMp4 } = require('./content_library/stable_mp4');
  const segmentData = orderedClipUrls.map((c, i) => {
    const stable = pickStableLibraryMp4(c);
    const playUrl = stable || c.clipUrl || c.url || '';
    return {
      url: playUrl,
      pageUrl: c.pageUrl || '',
      label: c.label || `CLIP_${i + 1}`,
      type: 'source_clip',
      clipUrl: playUrl,
      mp4Url: c.mp4Url || stable || '',
      stagedUrl: c.stagedUrl || stable || '',
      r2Url: c.r2Url || stable || '',
      title: c.title || '',
      pillarboxFilter: c.pillarboxFilter != null ? c.pillarboxFilter : null,
      orientation: c.orientation || 'landscape',
      trimStart: c.trimStart,
      trimEnd: c.trimEnd,
      postLiveVod: stable ? false : !!c.postLiveVod,
      vodPeakWindow: !!c.vodPeakWindow || !!stable,
      vodOrigin: c.vodOrigin || null,
      clipTimingTargets: [],
      clipTimingFormat: 'none',
      layoutSegments: Array.isArray(c.layoutSegments) ? c.layoutSegments : [],
      openingLayout: c.openingLayout || null,
      zoomPunch: c.zoomPunch || null,
      cameraShake: c.cameraShake || null,
      impactTint: c.impactTint || null,
      speedRamps: c.speedRamps || null,
      highlightSfx: c.highlightSfx || null,
      overlayTexts: c.overlayTexts || null,
    };
  });
  const retryNum = card._assemblyRetryCount || 1;
  const assemblyId = `asm_${jobId}_r${retryNum}`;
  const contentType = card.contentType || 'twitch-short';
  const clipCompBrief = card.clipCompBrief || null;
  const sourceSignals = {
    clipCompBrief,
    streamers: card.streamers || [],
    items: card.items || orderedClipUrls,
    orderedClipUrls,
  };
  const fullScript = clipCompBrief
    ? buildClipCompSeoInput(clipCompBrief, card.compCreative || null)
    : (card.script?.raw || card.script || null);

  return {
    segments: segmentData.map((s) => s.url),
    segmentData,
    labels: segmentData.map((s) => s.label),
    transition: 'crossfade',
    format: (contentType || '').includes('-short') ? 'portrait' : 'portrait',
    assemblyId,
    contentType,
    clipCompProfile: card.clipCompProfile || 'streamer',
    publishContentType: resolveClipCompPublishContentType(contentType, sourceSignals),
    jobId,
    jobSpecId: card.specId || card.jobSpecId || null,
    jobTitle: card.title || null,
    streamers: card.streamers || [],
    clipsOnly: true,
    orderedClipUrls,
    postLiveVodSessionId: card.postLiveVodSessionId || null,
    postLiveMuteRanges: card.postLiveMuteRanges?.length ? card.postLiveMuteRanges : null,
    expectedClips: segmentData.length,
    designSpec: card.designSpec,
    compCreative: card.compCreative,
    captionText: null,
    items: card.items || orderedClipUrls.map((c) => ({
      title: c.title || '',
      headline: c.title || '',
      displayName: c.displayName || c.streamer || '',
      streamer: c.streamer || c.displayName || '',
      clipTitle: c.title || '',
    })),
    fullScript,
    clipHookTitles: card.clipHookTitles || null,
    clipHookCandidates: card.clipHookCandidates || null,
    clipCompBrief,
    regenerateClipHooks: false,
  };
}

function hookItemsFromCard(card = {}) {
  const orderedClips = card.orderedClipUrls || [];
  return (card.items || orderedClips).map((c) => ({
    title: c.title || '',
    headline: c.title || '',
    displayName: c.displayName || c.streamer || '',
    streamer: c.streamer || c.displayName || '',
    clipTitle: c.title || '',
    thumbnailUrl: c.thumbnailUrl || '',
    game: c.game || '',
    viewCount: c.views || c.viewCount || null,
    sceneLabel: c.sceneLabel || '',
    segmentKind: c.segmentKind || '',
  }));
}

/**
 * Hook Machine → hook_review (or auto-assemble). Survives server restart when re-invoked.
 */
async function runClipCompHookGeneration(jobId, card, {
  saveJobCard,
  autoConfirmHooks = false,
  repurposeFast = false,
  onPublished,
} = {}) {
  const orderedClipUrls = card.orderedClipUrls || [];
  if (!orderedClipUrls.length) {
    throw new Error('No orderedClipUrls on card — cannot generate hooks');
  }

  // whisper_only presets (FableFlow): skip Hook Machine + hook_review → assemble now
  // Keep a lightweight SEO brief (curiosity title seed) — do not null clipCompBrief.
  if (!clipCompBurnedHooksEnabled(card)) {
    const n = orderedClipUrls.length;
    const hookItems = hookItemsFromCard(card);
    const { buildBriefFromHooks } = require('./clip_comp_hooks');
    const emptyHooks = Array.from({ length: n }, () => '');
    card.clipHookTitles = emptyHooks;
    card.clipHookCandidates = Array.from({ length: n }, () => []);
    card.clipCompBrief = buildBriefFromHooks(orderedClipUrls, hookItems, emptyHooks);
    card.hookMachineFailed = false;
    card.hookMachineNeedsReview = false;
    card.hooksPendingReassemble = false;
    card.hooksConfirmedAt = new Date().toISOString();
    card.hooksOperatorLocked = true;
    if (typeof saveJobCard === 'function') saveJobCard(jobId, card);
    console.log(`[clip-comp] ${jobId}: whisper_only — skipping Hook Machine; assembling directly`);
    await fireClipCompAssembly(card, jobId, { saveJobCard, onPublished });
    return {
      stage: card.stage,
      skippedHooks: true,
      clipHookTitles: card.clipHookTitles,
      clipHookCandidates: card.clipHookCandidates,
    };
  }

  const hookItems = hookItemsFromCard(card);
  console.log(`[clip-comp] ${jobId}: generating ${repurposeFast ? 'repurpose scene' : 'Gemini creative'} brief for ${orderedClipUrls.length} clips...`);
  const clipCompBrief = repurposeFast
    ? await buildRepurposeClipCompBrief(orderedClipUrls, hookItems, {
      log: (m) => console.log(`[clip-comp] ${jobId}${m}`),
      compCreative: card.compCreative || null,
    })
    : await generateClipCompCreativeBriefWithTimeout(orderedClipUrls, hookItems, {
      log: (m) => console.log(`[clip-comp] ${jobId}${m}`),
      compCreative: card.compCreative || null,
      onLateBrief: (lateBrief) => {
        try {
          if (!lateBrief?.clips?.length || lateBrief.fallbackBrief) return;
          if (card.hooksOperatorLocked || card.hooksConfirmedAt) return;
          if (!card.clipCompBrief?.fallbackBrief) return;
          card.clipHookTitles = lateBrief.clips.map((c) => c.hook);
          card.clipHookCandidates = lateBrief.clips.map((c) => c.hookCandidates || []);
          card.clipCompBrief = lateBrief;
          card.hookMachineFailed = false;
          if (typeof saveJobCard === 'function') saveJobCard(jobId, card);
          console.log(`[clip-comp] ${jobId}: ♻️ late brief salvaged — fallback hooks replaced with Hook Machine results`);
        } catch (err) {
          console.warn(`[clip-comp] ${jobId}: late brief salvage failed: ${err.message}`);
        }
      },
    });
  if (clipCompBrief.fallbackBrief) {
    console.warn(`[clip-comp] ${jobId}: using fallback brief (Gemini timeout or error)`);
  }
  const { isFallbackHook } = require('./hook_training/hook_validators');
  const { ensureHookCandidatePools } = require('./clip_comp_hooks');
  const clipHookTitles = clipCompBrief.clips.map((c) => c.hook);
  const clipHookCandidates = ensureHookCandidatePools(clipCompBrief.clips);
  const candidateCount = clipHookCandidates.reduce((n, pool) => n + ((pool && pool.length) || 0), 0);
  const onlyFallbackTitles = clipHookTitles.length > 0
    && clipHookTitles.every((h) => isFallbackHook(h))
    && candidateCount === 0;
  card.hookMachineFailed = !!(clipCompBrief.fallbackBrief || onlyFallbackTitles);
  if (card.hookMachineFailed) {
    const { normalizeHookLine } = require('./clip_comp_hooks');
    card.clipHookTitles = clipHookTitles.map((h, i) => {
      const trimmed = String(h || '').trim();
      if (trimmed) return trimmed;
      const clip = orderedClipUrls[i] || {};
      const item = hookItems[i] || {};
      const title = clip.title || item.title || item.headline || '';
      return normalizeHookLine(clip.displayName || clip.streamer, '', title)
        || (title ? String(title).slice(0, 48) : 'Watch This');
    });
    card.hookMachineNeedsReview = true;
  } else {
    card.clipHookTitles = clipHookTitles;
    card.hookMachineNeedsReview = false;
  }
  card.clipHookCandidates = clipHookCandidates;
  card.clipCompBrief = clipCompBrief;
  card.hooksPendingReassemble = false;

  if (autoConfirmHooks) {
    card.hooksConfirmedAt = new Date().toISOString();
    card.hooksOperatorLocked = true;
    if (typeof saveJobCard === 'function') saveJobCard(jobId, card);
    await fireClipCompAssembly(card, jobId, { saveJobCard, onPublished });
    console.log(`[clip-comp] ${jobId}: autoConfirmHooks — assembly started`);
    return { stage: card.stage, clipHookTitles: card.clipHookTitles, clipHookCandidates };
  }

  card.stage = 'hook_review';
  card.status = 'completed';
  card.hookReviewReadyAt = new Date().toISOString();
  if (typeof saveJobCard === 'function') saveJobCard(jobId, card);
  const readyMsg = card.hookMachineFailed
    ? 'hook_review — Hook Machine failed; type custom hook or REGEN HOOKS'
    : `hook_review — ${candidateCount} candidates ready; waiting for operator hook pick`;
  console.log(`[clip-comp] ${jobId}: ${readyMsg}`);
  return { stage: 'hook_review', clipHookTitles: card.clipHookTitles, clipHookCandidates };
}

async function fireClipCompAssembly(card, jobId, { saveJobCard, onPublished } = {}) {
  const port = process.env.PORT || 3000;
  const payload = buildAssemblePayload(card, jobId);
  card.stage = 'assembling';
  card.status = 'assembling';
  card.assemblyId = payload.assemblyId;
  card.hooksConfirmedAt = card.hooksConfirmedAt || new Date().toISOString();
  card.hooksPendingReassemble = false;
  card.hooksOperatorLocked = true;
  if (typeof saveJobCard === 'function') saveJobCard(jobId, card);
  const { c0AuthHeaders } = require('./c0_internal_fetch');
  await axios.post(`http://localhost:${port}/assemble`, payload, { timeout: 30000, headers: { ...c0AuthHeaders() } });
  const { startAssemblyCompletionPoll } = require('./assembly_card_persist');
  startAssemblyCompletionPoll(jobId, payload.assemblyId, card.contentType || 'twitch-short', { onPublished });
  return { assemblyId: payload.assemblyId };
}

module.exports = {
  clipCompClipCount,
  clipCompBurnedHooksEnabled,
  needsHookBeforeAssembly,
  buildAssemblePayload,
  hookItemsFromCard,
  runClipCompHookGeneration,
  fireClipCompAssembly,
};
