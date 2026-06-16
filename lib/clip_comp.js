'use strict';
/**
 * lib/clip_comp.js — shared clip-compilation profile (CPD-935 / CPD-981 / CPD-1042)
 * Cherry-picked from cwn-c0 — C0_PORTABLE=1
 */

const { loadCustomerConfig, buildDesignSpec } = require('./job_spec');

function resolveClipCompVoiceKey(sourceContentType) {
  const base = String(sourceContentType || 'twitch-short').replace(/-short$/, '');
  if (['sports', 'nba', 'basketball', 'boxing', 'hockey', 'nhl'].some((t) => base.includes(t))) return 'sports';
  if (base.includes('news')) return 'news';
  return 'clips';
}

function resolveClipCompPublishContentType(jobContentType) {
  const allowed = ['twitch-short', 'news-short', 'sports-short'];
  return allowed.includes(jobContentType) ? jobContentType : 'twitch-short';
}

function resolveClipCompSourceContentType({ contentType, templateName } = {}) {
  const ct = String(contentType || '');
  if (['twitch-short', 'news-short', 'sports-short'].includes(ct)) return ct;
  const tn = String(templateName || '');
  if (/sports|nba|nhl|boxing|hockey|pillow|punch/i.test(tn)) return 'sports-short';
  if (/news|because the light/i.test(tn)) return 'news-short';
  return 'twitch-short';
}

function buildClipCompDesignSpec({ customerId = 'c0', sourceContentType = 'twitch-short', clipCount }) {
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

  return {
    ...base,
    sourceContentType,
    expectedClipCount: n,
    maxItems: n,
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
      hasTopBar: false,
      hasFlag: false,
      hasSidebar: false,
      hasTicker: false,
      hasLogo: true,
      logoPosition: 'top-blur-fold',
      logoSize: 220,
      resolvedContentType: voiceKey,
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
          clips: '#6441A5',
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

function buildClipCompDeliverySpec({ platforms = ['youtube'], scheduledAt = null } = {}) {
  return {
    platforms,
    scheduledAt: scheduledAt || null,
    visibility: 'private',
  };
}

function buildClipCompPublishOrder() {
  return { privacyStatus: 'private' };
}

function clipCompPublishPrivate(contentType) {
  const ct = String(contentType || '');
  return ct.includes('-short') || ct.endsWith('short');
}

/** Apply canonical clip-comp profile to a job spec (wizard or /generate-clip-comp). */
function applyClipCompProfileToJobSpec(jobSpec, opts = {}) {
  const {
    customerId,
    clipCount = 1,
    sourceContentType = 'twitch-short',
    platforms = ['youtube'],
    scheduledAt = null,
    clipsOnly = true,
  } = opts;

  jobSpec.clipsOnly = clipsOnly;
  jobSpec.designSpec = buildClipCompDesignSpec({ customerId, clipCount, sourceContentType });
  jobSpec.deliverySpec = buildClipCompDeliverySpec({ platforms, scheduledAt });
  jobSpec.order = jobSpec.order || {};
  jobSpec.order.publish = { ...(jobSpec.order.publish || {}), ...buildClipCompPublishOrder() };
  jobSpec.stageMap = {
    ...(jobSpec.stageMap || {}),
    script: { active: false },
    avatar: { active: false },
  };
  if (String(sourceContentType).includes('-short')) {
    jobSpec.contentType = sourceContentType;
  }
  return jobSpec;
}

module.exports = {
  buildClipCompDesignSpec,
  resolveClipCompVoiceKey,
  resolveClipCompPublishContentType,
  resolveClipCompSourceContentType,
  buildClipCompDeliverySpec,
  buildClipCompPublishOrder,
  clipCompPublishPrivate,
  applyClipCompProfileToJobSpec,
};
