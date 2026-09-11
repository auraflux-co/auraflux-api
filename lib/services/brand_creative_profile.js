'use strict';

/**
 * Merge brand.creative_profile into composition / design defaults.
 * Gate: brand.creative_profile
 */

function mergeBrandCreativeProfile(compCreative = {}, profile = {}) {
  if (!profile || typeof profile !== 'object') return { ...compCreative };
  const out = JSON.parse(JSON.stringify(compCreative || {}));

  if (profile.captionStyle) {
    out.captions = { ...(out.captions || {}), style: profile.captionStyle };
  }
  if (profile.audioBed) {
    out.audio = { ...(out.audio || {}), musicBed: profile.audioBed };
  }
  if (profile.colors) {
    out.look = {
      ...(out.look || {}),
      brandColors: profile.colors,
    };
  }
  if (profile.fonts) {
    out.typography = { ...(out.typography || {}), ...profile.fonts };
  }
  if (profile.logoWatermarkUrl) {
    out.watermark = {
      ...(out.watermark || {}),
      url: profile.logoWatermarkUrl,
      enabled: true,
    };
  }
  return out;
}

function normalizeCreativeProfile(input = {}) {
  const p = input && typeof input === 'object' ? input : {};
  return {
    fonts: p.fonts && typeof p.fonts === 'object' ? p.fonts : {},
    colors: p.colors && typeof p.colors === 'object' ? p.colors : {},
    logoWatermarkUrl: typeof p.logoWatermarkUrl === 'string' ? p.logoWatermarkUrl : null,
    captionStyle: typeof p.captionStyle === 'string' ? p.captionStyle : null,
    audioBed: typeof p.audioBed === 'string' ? p.audioBed : null,
  };
}

module.exports = {
  mergeBrandCreativeProfile,
  normalizeCreativeProfile,
};
