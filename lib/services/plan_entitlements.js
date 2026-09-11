'use strict';
/**
 * Plan entitlement defaults — source of truth for Growth vs Operate/Pro limits.
 * Marketing /pricing claims must match these numbers.
 */
const PLAN_DEFAULTS = {
  growth: {
    credits_included: 30,
    overage_price_cents: 30,
    vod_hours_included: 40,
    max_channels: 3,
    queue_priority: 10, // lower = higher priority in BullMQ
    export_vertical_w: 1080,
    export_vertical_h: 1920,
    export_fps: 60,
    has_account_manager: false,
    caption_font_upload: false,
  },
  operate: {
    credits_included: 50,
    overage_price_cents: 25,
    vod_hours_included: null, // unlimited
    max_channels: null,
    queue_priority: 5,
    export_vertical_w: 1080,
    export_vertical_h: 1920,
    export_fps: 60,
    has_account_manager: true, // Pro Operator / Agency claim
    caption_font_upload: true,
  },
  guided: {
    credits_included: 200,
    overage_price_cents: 15,
    vod_hours_included: null,
    max_channels: null,
    queue_priority: 3,
    export_vertical_w: 1080,
    export_vertical_h: 1920,
    export_fps: 60,
    has_account_manager: true,
    caption_font_upload: true,
  },
  managed: {
    credits_included: 1000,
    overage_price_cents: 10,
    vod_hours_included: null,
    max_channels: null,
    queue_priority: 1,
    export_vertical_w: 1080,
    export_vertical_h: 1920,
    export_fps: 60,
    has_account_manager: true,
    caption_font_upload: true,
  },
  custom: {
    credits_included: 9999,
    overage_price_cents: 0,
    vod_hours_included: null,
    max_channels: null,
    queue_priority: 1,
    export_vertical_w: 1080,
    export_vertical_h: 1920,
    export_fps: 60,
    has_account_manager: true,
    caption_font_upload: true,
  },
};

function getPlanDefaults(tier) {
  const t = (tier || 'operate').toLowerCase();
  return PLAN_DEFAULTS[t] || PLAN_DEFAULTS.operate;
}

/** BullMQ: lower number = higher priority */
function queuePriorityForTier(tier) {
  return getPlanDefaults(tier).queue_priority ?? 10;
}

function exportProfileForTier(tier) {
  const d = getPlanDefaults(tier);
  return {
    width: d.export_vertical_w || 1080,
    height: d.export_vertical_h || 1920,
    fps: d.export_fps || 60,
  };
}

module.exports = {
  PLAN_DEFAULTS,
  getPlanDefaults,
  queuePriorityForTier,
  exportProfileForTier,
};
