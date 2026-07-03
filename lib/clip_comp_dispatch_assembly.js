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

/** True when operator must pick/confirm hooks before the first FFmpeg burn. */
function needsHookBeforeAssembly(card = {}) {
  if (!card.clipsOnly) return false;
  if (card.stage === 'hook_review') return true;
  return !card.assembledAt && !card.driveUrl && !(card.burnedHookTitles || []).length;
}

function buildAssemblePayload(card = {}, jobId) {
  const orderedClipUrls = card.orderedClipUrls || [];
  const segmentData = orderedClipUrls.map((c, i) => ({
    url: c.clipUrl || c.url || '',
    pageUrl: c.pageUrl || '',
    label: c.label || `CLIP_${i + 1}`,
    type: 'source_clip',
    clipUrl: c.clipUrl || c.url || '',
    pillarboxFilter: c.pillarboxFilter != null ? c.pillarboxFilter : null,
    orientation: c.orientation || 'landscape',
    trimStart: c.trimStart,
    trimEnd: c.trimEnd,
    postLiveVod: c.postLiveVod,
    clipTimingTargets: [],
    clipTimingFormat: 'none',
  }));
  const retryNum = card._assemblyRetryCount || 1;
  const assemblyId = `asm_${jobId}_r${retryNum}`;
  const contentType = card.contentType || 'twitch-short';
  const clipCompBrief = card.clipCompBrief || null;
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
    publishContentType: resolveClipCompPublishContentType(contentType),
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
  const clipHookTitles = clipCompBrief.clips.map((c) => c.hook);
  const clipHookCandidates = clipCompBrief.clips.map((c) => c.hookCandidates || []);
  card.clipHookTitles = clipHookTitles;
  card.clipHookCandidates = clipHookCandidates;
  card.clipCompBrief = clipCompBrief;
  card.hooksPendingReassemble = false;

  if (autoConfirmHooks) {
    card.hooksConfirmedAt = new Date().toISOString();
    card.hooksOperatorLocked = true;
    if (typeof saveJobCard === 'function') saveJobCard(jobId, card);
    await fireClipCompAssembly(card, jobId, { saveJobCard, onPublished });
    console.log(`[clip-comp] ${jobId}: autoConfirmHooks — assembly started`);
    return { stage: card.stage, clipHookTitles, clipHookCandidates };
  }

  card.stage = 'hook_review';
  card.status = 'completed';
  card.hookReviewReadyAt = new Date().toISOString();
  if (typeof saveJobCard === 'function') saveJobCard(jobId, card);
  console.log(`[clip-comp] ${jobId}: hook_review — ${clipHookCandidates[0]?.length || 0} candidates ready; waiting for operator hook pick`);
  return { stage: 'hook_review', clipHookTitles, clipHookCandidates };
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
  await axios.post(`http://localhost:${port}/assemble`, payload, { timeout: 30000 });
  const { startAssemblyCompletionPoll } = require('./assembly_card_persist');
  startAssemblyCompletionPoll(jobId, payload.assemblyId, card.contentType || 'twitch-short', { onPublished });
  return { assemblyId: payload.assemblyId };
}

module.exports = {
  clipCompClipCount,
  needsHookBeforeAssembly,
  buildAssemblePayload,
  hookItemsFromCard,
  runClipCompHookGeneration,
  fireClipCompAssembly,
};
