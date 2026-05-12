'use strict';
/**
 * Credit cost calculator — CPD-115, CPD-128
 *
 * Anchor: 1 credit = 1 XS job = $0.07 AF production cost.
 * All rates × 10 multiplier applied. Duration baked into the total — customer
 * and Collab see credits per job, never credits per minute.
 *
 * Rate card (internal — base/Operate rates):
 *   Base job        : 10 cr  (always, no discount)
 *   TTS narration   :  1 cr/min  (S tier — ElevenLabs)
 *   WAN T2V         :  6 cr/min  (L tier — RunPod GPU)
 *   HeyGen Avatar IV: 120 cr/min (only avatar offering)
 *   Shoppable CTA   :  2 cr/min  (FFmpeg overlay + platform tag)
 *
 * Flat add-ons (per job, regardless of duration — no discount applied):
 *   Script generation   : 10 cr
 *   Web research        : 10 cr
 *   Content fetch       : 10 cr
 *   VectCut thumbnail   : 10 cr
 *   Narrative Clip      : 10 cr
 *   Imagen thumbnail    : 20 cr
 *
 * Plan-tier discounts (CPD-128 — applied to AI production rates only, not base/flat):
 *   Operate (diy)  : 1.00 (no discount)
 *   Guided  (dwy)  : 0.90 (10% off)
 *   Managed (dfy)  : 0.75 (25% off)
 *   Custom         : 0.70 (30% off)
 */

const RATES = {
  base:                10,
  tts_per_min:          1,
  wan_t2v_per_min:      6,
  heygen_per_min:     120,
  shoppable_per_min:    2,
  // flat add-ons — no tier discount applied
  script:              10,
  research:            10,
  content_fetch:       10,
  vectcut_thumbnail:   10,
  narrative_clip:      10,
  imagen_thumbnail:    20,
};

// CPD-128: plan-tier discount applied to AI production rates (not base or flat add-ons)
const TIER_DISCOUNT = {
  diy:    1.00,
  dwy:    0.90,
  dfy:    0.75,
  custom: 0.70,
};

/**
 * Calculate the credit cost for a job.
 *
 * @param {object} opts
 * @param {number}  opts.durationMins    — output video duration in minutes (required)
 * @param {string}  [opts.aiFeature]     — 'tts' | 'wan_t2v' | 'heygen' | null
 * @param {object}  [opts.addOns]        — map of flat add-on flags
 * @param {string}  [opts.planTier]      — 'diy' | 'dwy' | 'dfy' | 'custom' (CPD-128)
 *
 * @returns {{ credits: number, breakdown: object, discountFactor: number }}
 */
function calculateCreditCost({ durationMins = 1, aiFeature = null, addOns = {}, planTier = 'diy' }) {
  const dur      = Math.max(0.1, Number(durationMins) || 1);
  const discount = TIER_DISCOUNT[planTier] ?? 1.0;

  const ai = (rate) => Math.ceil(rate * dur * discount);

  const breakdown = {
    base:              RATES.base,  // no discount on base
    tts:               aiFeature === 'tts'    ? ai(RATES.tts_per_min)     : 0,
    wan_t2v:           aiFeature === 'wan_t2v' ? ai(RATES.wan_t2v_per_min) : 0,
    heygen:            aiFeature === 'heygen'  ? ai(RATES.heygen_per_min)  : 0,
    shoppable:         addOns.shoppable         ? ai(RATES.shoppable_per_min) : 0,
    // flat add-ons — no discount
    script:            addOns.script            ? RATES.script            : 0,
    research:          addOns.research          ? RATES.research          : 0,
    content_fetch:     addOns.content_fetch     ? RATES.content_fetch     : 0,
    vectcut_thumbnail: addOns.vectcut_thumbnail ? RATES.vectcut_thumbnail : 0,
    narrative_clip:    addOns.narrative_clip    ? RATES.narrative_clip    : 0,
    imagen_thumbnail:  addOns.imagen_thumbnail  ? RATES.imagen_thumbnail  : 0,
  };

  const credits = Object.values(breakdown).reduce((s, v) => s + v, 0);
  return { credits, breakdown, discountFactor: discount };
}

/**
 * Derive aiFeature and addOns from a job spec's addOns + sourceType.
 * Convenience helper for createJobSpec.
 *
 * @param {object} opts
 * @param {object}  opts.addOns       — job spec addOns block
 * @param {string}  opts.sourceType
 * @param {string}  opts.contentType
 * @param {string}  opts.planTier
 * @returns {{ aiFeature: string|null, addOns: object }}
 */
function deriveFeatures({ addOns = {}, sourceType = '', contentType = '', planTier = 'diy' }) {
  let aiFeature = null;
  if (addOns?.heygen?.active) {
    aiFeature = 'heygen';
  } else if (sourceType === 'wan_gen') {
    aiFeature = 'wan_t2v';
  } else if (addOns?.tts?.active) {
    aiFeature = 'tts';
  }

  const flatAddOns = {
    script:            !!(addOns?.script?.active !== false),  // script is default-on when stageMap.script.active
    research:          sourceType === 'research_query' || sourceType === 'site_scrape',
    content_fetch:     sourceType === 'url_list' || sourceType === 'site_scrape',
    shoppable:         !!(addOns?.shoppable?.active),
    vectcut_thumbnail: !!(addOns?.vectcutThumbnail?.active),
    narrative_clip:    contentType === 'show_commentary',
    imagen_thumbnail:  !!(addOns?.imagenThumbnail?.active) && planTier !== 'diy',
  };

  return { aiFeature, addOns: flatAddOns };
}

/**
 * Build a human-readable Collab credit summary string.
 * Never exposes per-minute rates — shows total credits and what's included.
 *
 * @param {number} credits
 * @param {object} breakdown
 * @param {number} [balance]  — customer's current credit balance (optional)
 * @returns {string}
 */
function buildCollabEstimate(credits, breakdown, balance) {
  const lines = [`This job will cost **${credits} credits**.`];

  const parts = [];
  if (breakdown.tts || breakdown.wan_t2v || breakdown.heygen || breakdown.shoppable) {
    const aiCost = breakdown.tts + breakdown.wan_t2v + breakdown.heygen + breakdown.shoppable;
    parts.push(`${breakdown.base} base + ${aiCost} AI production`);
  }
  const flatTotal = breakdown.script + breakdown.research + breakdown.content_fetch +
    breakdown.vectcut_thumbnail + breakdown.narrative_clip + breakdown.imagen_thumbnail;
  if (flatTotal > 0) parts.push(`${flatTotal} add-ons`);
  if (parts.length) lines.push(`Breakdown: ${parts.join(', ')}.`);

  if (balance !== undefined) {
    if (balance >= credits) {
      lines.push(`You have **${balance} credits** remaining — enough to proceed.`);
    } else {
      const needed = credits - balance;
      lines.push(`You have **${balance} credits** remaining. You need **${needed} more credits** to run this job. Top up to proceed.`);
    }
  }

  return lines.join(' ');
}

module.exports = { calculateCreditCost, deriveFeatures, buildCollabEstimate, RATES };
