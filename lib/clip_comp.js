'use strict';
/**
 * lib/clip_comp.js — shared clip-compilation short profile (CPD-935 / CPD-981)
 *
 * Sports, news, and Twitch dashboard comps all POST /generate-clip-comp.
 * They share the same visual + feature contract: full-frame 9:16 blur-pad concat,
 * top-blur-fold logo, whisper captions, loudnorm, frame thumbnail, no avatar.
 *
 * Publish copy uses the job's source contentType (sports-short, news-short,
 * twitch-short) — NOT a forced twitch label — so GPT classifies metadata correctly.
 */

const { loadCustomerConfig, buildDesignSpec } = require('./job_spec');

/** Map dashboard contentType → voice/config key. */
function resolveClipCompVoiceKey(sourceContentType) {
  const base = String(sourceContentType || 'twitch-short').replace(/-short$/, '');
  if (['sports', 'nba', 'basketball', 'boxing', 'hockey', 'nhl'].some(t => base.includes(t))) return 'sports';
  if (base.includes('news')) return 'news';
  return 'clips';
}

/**
 * Publish contentType for clip comps — from job card type + actual clip sources (not Compose preset).
 * @param {string} jobContentType — e.g. sports-short, news-short, twitch-short
 * @param {object} [sourceSignals] — { clipCompBrief, streamers, items, clips, orderedClipUrls, segmentData }
 */
function resolveClipCompPublishContentType(jobContentType, sourceSignals = null) {
  if (sourceSignals && typeof sourceSignals === 'object') {
    const { resolvePublishContentType } = require('./publish_seo_context');
    return resolvePublishContentType({ jobContentType, ...sourceSignals });
  }
  const allowed = ['twitch-short', 'news-short', 'sports-short', 'youtube-short', 'twitch-vod-comp', 'news-vod-comp', 'sports-vod-comp'];
  return allowed.includes(jobContentType) ? jobContentType : 'twitch-short';
}

/**
 * Canonical designSpec for clips-only comp shorts.
 * @param {object} opts
 * @param {string} [opts.customerId='c0']
 * @param {string} [opts.sourceContentType='twitch-short']
 * @param {number} opts.clipCount — selected clips in this comp (typically 4)
 * @returns {object}
 */
function buildClipCompDesignSpec({
  customerId = 'c0',
  sourceContentType = 'twitch-short',
  clipCount,
  compCreative = null,
  compCreativePreset = null,
  streamerHint = null,
} = {}) {
  const { mergeCompCreative, compCreativeAssemblyFlags, compCreativeGate3Expectations } = require('./clip_comp_creative');
  const n = Math.max(1, Number(clipCount) || 1);
  const voiceKey = resolveClipCompVoiceKey(sourceContentType);
  const customerConfig = loadCustomerConfig(customerId);
  const base = buildDesignSpec(customerConfig, 'short-form', voiceKey === 'clips' ? 'clips' : voiceKey);

  const showNames = customerConfig?.designDefaults?.voice?.showName || {};
  const showName =
    showNames[voiceKey] ||
    base.voice?.showName ||
    base.chrome?.showName ||
    (voiceKey === 'sports' ? 'OTHER SIDE OF THE PILLOW' : voiceKey === 'news' ? 'BECAUSE THE LIGHT WAS ON' : 'TWITCH SOUP');

  const categoryDefaults = {
    clips: 'ON STREAM',
    sports: 'SPORTS HIGHLIGHTS',
    news: 'WORLD NEWS',
  };

  const sceneHeaders = Array.from({ length: n }, (_, i) => `CLIP_${i + 1}`);

  const resolvedCreative = mergeCompCreative({
    preset: compCreativePreset || compCreative?.preset,
    overrides: compCreative || undefined,
    streamerHint,
  });
  const gate3Chrome = compCreativeGate3Expectations(resolvedCreative);

  return {
    ...base,
    sourceContentType,
    expectedClipCount: n,
    maxItems: n,
    compCreative: resolvedCreative,
    compCreativeFlags: compCreativeAssemblyFlags(resolvedCreative),
    audio: {
      mixMode: 'source',
      avatarTrack: false,
      sourceTrack: true,
    },
    chrome: {
      ...base.chrome,
      skin: voiceKey === 'clips' ? 'twitch' : voiceKey,
      layout: 'clip-comp',
      splitTop: null,
      splitBottom: null,
      hasTopBar: gate3Chrome.hasTopBar,
      hasFlag: gate3Chrome.hasFlag,
      hasSidebar: gate3Chrome.hasSidebar,
      hasTicker: gate3Chrome.hasTicker,
      hasLogo: gate3Chrome.hasLogo,
      logoPosition: gate3Chrome.logoPosition,
      logoSize: gate3Chrome.logoSize,
      clipCompLayoutMode: gate3Chrome.clipCompLayoutMode,
      rankedOverlay: gate3Chrome.rankedOverlay,
      compCreativePreset: resolvedCreative.preset,
      resolvedContentType: voiceKey,
      // Hook title on each clip — bottom of sharp footage (transformative overlay)
      caption: {
        ...(base.chrome?.caption || {}),
        position: 'clip-comp-hook',
        align: 'center',
        fontsize: 56,
        font: base.chrome?.caption?.font || '/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf',
        useBox: true,
        textColor: '#FFFFFF',
        strokeColor: '#000000',
        strokeWidth: 4,
        boxOpacity: 0.82,
        boxBorderW: 14,
        yOffset: 16,
        maxLines: 2,
        colors: base.chrome?.caption?.colors || {
          news: '#c7af4f',
          clips: '#c7af4f',
          sports: '#1CE8FF',
        },
      },
    },
    voice: {
      ...(base.voice || {}),
      showName,
      categoryLabel: base.voice?.categoryLabel || base.chrome?.categoryLabel || categoryDefaults[voiceKey] || 'ON STREAM',
    },
    sceneStructure: {
      sceneHeaders,
      expectedSceneCount: n,
      expectedClipCount: n,
      templateId: `${voiceKey}-short`,
      scaffold: null,
      generatedAt: new Date().toISOString(),
    },
  };
}

/** @deprecated use resolveClipCompPublishContentType(jobContentType) */
const CLIP_COMP_ASSEMBLY_CONTENT_TYPE = 'twitch-short';

/** Editorial clip comps — hold Gate 5 until after live (raw source clips get flagged; publish from host-reaction Twitch cut). */
const POST_LIVE_PUBLISH_CONTENT_TYPES = new Set(['news-short', 'sports-short']);

function clipCompUsesPostLivePublishHold(contentType) {
  return POST_LIVE_PUBLISH_CONTENT_TYPES.has(String(contentType || '').toLowerCase());
}

function isClipCompPublishHeld(card) {
  if (!card) return false;
  if (card.postLivePublishReleased) return false;
  return card.deliverySpec?.publishHold === 'post_live'
    || card.publishHold === 'post_live'
    || clipCompUsesPostLivePublishHold(card.contentType);
}

function releaseClipCompPostLiveHold(card) {
  if (!card) return card;
  card.postLivePublishReleased = true;
  card.postLivePublishReleasedAt = new Date().toISOString();
  card.publishHold = null;
  if (card.deliverySpec) {
    card.deliverySpec.publishHold = null;
    delete card.deliverySpec.publishHoldReason;
  }
  return card;
}

/** Default delivery + publish privacy for clip comp jobs (review as private draft). */
function buildClipCompDeliverySpec({ platforms = ['youtube'], scheduledAt = null, contentType = null, compCreative = null } = {}) {
  const hold = clipCompUsesPostLivePublishHold(contentType);
  const delivery = {
    platforms,
    scheduledAt: scheduledAt || null,
    visibility: 'private',
    ...(hold ? {
      publishHold: 'post_live',
      publishHoldReason:
        'News/sports: raw source clips get copyright flags. Comp is for live prep + SEO only — publish the portrait cut from your Twitch show (you on camera reacting, like the avatar did), not this fetched-clip assembly.',
    } : {}),
  };
  if (compCreative?.delivery?.relatedVideoParentId) {
    delivery.relatedVideoParentId = compCreative.delivery.relatedVideoParentId;
  }
  if (compCreative?.delivery?.playlistSeries) {
    delivery.playlistSeries = compCreative.delivery.playlistSeries;
  }
  return delivery;
}

function buildClipCompPublishOrder() {
  return { privacyStatus: 'private' };
}

/** Clip comps always upload as private until operator promotes. */
function clipCompPublishPrivate(contentType) {
  const ct = String(contentType || '');
  return ct.includes('-short') || ct.endsWith('short');
}

/** Rob 2026-06-22 — multi-clip comp YouTube titles end with this phrase. */
const CLIP_COMP_TITLE_SUFFIX = ' and more...';

/**
 * Append comp suffix to YouTube title (before #Shorts if present).
 * @param {string} title
 * @param {{ clipCount?: number }} opts — suffix when clipCount >= 2
 */
function appendClipCompTitleSuffix(title, { clipCount = 0 } = {}) {
  if (!clipCount || clipCount < 2) return String(title || '').trim();
  let t = String(title || '').trim();
  if (!t) return t;
  const hadShorts = /\s+#Shorts\s*$/i.test(t);
  let core = t.replace(/\s+#Shorts\s*$/i, '').trim();
  if (/\band more\.{2,3}\s*$/i.test(core)) return t;
  core = `${core}${CLIP_COMP_TITLE_SUFFIX}`;
  return hadShorts ? `${core} #Shorts` : core;
}

module.exports = {
  buildClipCompDesignSpec,
  mergeCompCreative: (...args) => require('./clip_comp_creative').mergeCompCreative(...args),
  resolveClipCompVoiceKey,
  resolveClipCompPublishContentType,
  CLIP_COMP_ASSEMBLY_CONTENT_TYPE,
  buildClipCompDeliverySpec,
  buildClipCompPublishOrder,
  clipCompPublishPrivate,
  clipCompUsesPostLivePublishHold,
  isClipCompPublishHeld,
  releaseClipCompPostLiveHold,
  POST_LIVE_PUBLISH_CONTENT_TYPES,
  CLIP_COMP_TITLE_SUFFIX,
  appendClipCompTitleSuffix,
  isClipCompEditorialType(contentType) {
    const { isEditorialContentType } = require('./clip_comp_timeline');
    return isEditorialContentType(contentType);
  },
};
