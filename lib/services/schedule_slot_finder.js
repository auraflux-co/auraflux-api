'use strict';
/**
 * lib/services/schedule_slot_finder.js — CPD-873
 *
 * Finds the next available publish slot for a brand+platform combination
 * based on the brand's saved publish_schedule_prefs, and enforces the
 * frequency cap implied by how many weekly slots are configured.
 *
 * Exports:
 *   findNextPublishSlot(brandId, platform, opts)  → { scheduledPublishAt, slot } | null
 *   autoSlotApprovedJob(spec, jobId)              → void — mutates spec + writes DB row
 */

const { query } = require('../db/postgres');

/** How far ahead (in days) we scan for an available slot before giving up. */
const MAX_LOOKAHEAD_DAYS = 60;

// ── findNextPublishSlot ────────────────────────────────────────────────────────

/**
 * Find the next publish slot for a brand on a given platform.
 *
 * Algorithm:
 *  1. Load publish_schedule_prefs for the brand from client_plans.
 *  2. For the target platform, build a list of upcoming slot datetimes.
 *  3. Walk forward from `fromDate`, checking each slot's week against the
 *     frequency cap (# of already-scheduled/published jobs in that week).
 *  4. Return the first slot that is under the cap, or null if none found
 *     within MAX_LOOKAHEAD_DAYS.
 *
 * @param {string}  brandId   — UUID of the brand
 * @param {string}  platform  — 'youtube' | 'tiktok' | 'instagram'
 * @param {object}  [opts]
 * @param {Date}    [opts.fromDate=new Date()]  — earliest acceptable slot
 * @param {string}  [opts.clientId]             — fallback if no brand-specific prefs
 * @returns {Promise<{ scheduledPublishAt: number, slot: {day:number, time:string} } | null>}
 */
async function findNextPublishSlot(brandId, platform, opts = {}) {
  const fromDate = opts.fromDate instanceof Date ? opts.fromDate : new Date();

  // ── Load prefs ──
  let prefs = {};
  try {
    const whereClause = brandId
      ? 'brand_id = $1 AND active = TRUE'
      : 'client_id = $1 AND active = TRUE';
    const param = brandId || opts.clientId;
    if (!param) return null;

    const result = await query(
      `SELECT publish_schedule_prefs FROM client_plans WHERE ${whereClause} LIMIT 1`,
      [param]
    );
    prefs = result.rows[0]?.publish_schedule_prefs || {};
  } catch (err) {
    console.warn(`[slot_finder] failed to load prefs for brand ${brandId}: ${err.message}`);
    return null;
  }

  const platformSlots = prefs[platform];
  if (!Array.isArray(platformSlots) || platformSlots.length === 0) {
    return null;  // no schedule configured for this platform
  }

  // Validate slot shapes
  const validSlots = platformSlots.filter(
    (s) => Number.isInteger(s.day) && s.day >= -1 && s.day <= 6 &&
           typeof s.time === 'string' && /^\d{2}:\d{2}$/.test(s.time)
  );
  if (validSlots.length === 0) return null;

  // Frequency cap: number of slots configured per week (implicit cap)
  const slotsPerWeek = validSlots.filter((s) => s.day === -1).length > 0
    ? 7 // daily slots → no weekly cap beyond what's scheduled
    : validSlots.filter((s) => s.day >= 0 && s.day <= 6).length;

  const deadline = new Date(fromDate.getTime() + MAX_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

  // ── Walk forward through slots ──
  let probe = new Date(fromDate);

  while (probe < deadline) {
    for (const slot of validSlots) {
      const candidate = _nextOccurrence(slot, probe);
      if (!candidate || candidate >= deadline) continue;
      if (candidate < fromDate) continue;

      // Check frequency cap for the week containing this candidate
      const { weekStart, weekEnd } = _weekBoundsMs(candidate);
      const alreadyScheduled = await _countScheduledInWindow(brandId, platform, weekStart, weekEnd);

      if (alreadyScheduled < slotsPerWeek) {
        return {
          scheduledPublishAt: candidate.getTime(),
          slot,
        };
      }
    }
    // Advance probe by 1 week
    probe = new Date(probe.getTime() + 7 * 24 * 60 * 60 * 1000);
  }

  return null;  // no slot found within lookahead window
}

// ── autoSlotApprovedJob ────────────────────────────────────────────────────────

/**
 * After a job is graded as passed, check whether it can be auto-slotted for
 * publish based on the brand's schedule prefs.
 *
 * If a slot is found:
 *   - Sets spec.order.publish.scheduledPublishAt to the slot timestamp (ms)
 *   - Sets spec.status = 'ready_to_publish'
 *   - Writes publish_mode + scheduled_publish_at to the jobs DB row
 *   - Logs the assignment for the operator
 *
 * If no slot is found (no prefs, cap hit, or DB error):
 *   - Leaves spec untouched — caller (runJobComplete) will keep status='complete'
 *     and the job lands in the Review Queue.
 *
 * Non-fatal: all errors are caught and logged; never throws.
 *
 * @param {object} spec    — job spec (mutated in-place)
 * @param {string} jobId
 */
async function autoSlotApprovedJob(spec, jobId) {
  let logErr;
  try { logErr = require('../utils/logger').logError; } catch { logErr = () => {}; }

  // Determine target platforms
  const platforms = Array.isArray(spec.order?.publish?.platforms)
    ? spec.order.publish.platforms
    : [];
  if (platforms.length === 0) return;

  const brandId  = spec.brandId  || null;
  const clientId = spec.customerId || null;
  if (!brandId && !clientId) return;

  let slotResult = null;
  let slotPlatform = null;

  for (const platform of platforms) {
    try {
      const found = await findNextPublishSlot(brandId, platform, { clientId });
      if (found) {
        slotResult   = found;
        slotPlatform = platform;
        break;
      }
    } catch (err) {
      logErr('CPD873_SLOT_FIND_ERROR', err, { jobId, platform });
    }
  }

  if (!slotResult) {
    console.log(
      `[slot_finder] ${jobId}: no schedule prefs configured or cap hit — ` +
      `job will land in Review Queue`
    );
    return;
  }

  // Persist to spec
  if (!spec.order) spec.order = {};
  if (!spec.order.publish) spec.order.publish = {};
  spec.order.publish.scheduledPublishAt = slotResult.scheduledPublishAt;
  spec.status = 'ready_to_publish';

  if (!spec.state) spec.state = {};
  spec.state.autoSlottedAt       = new Date().toISOString();
  spec.state.autoSlottedPlatform = slotPlatform;
  spec.state.autoSlotReasoning   = {
    slot:     slotResult.slot,
    platform: slotPlatform,
    slottedAt: new Date().toISOString(),
  };

  // Write scheduling metadata to the jobs row
  try {
    const { updateJobPublishSchedule } = require('../db/postgres');
    await updateJobPublishSchedule(jobId, 'scheduled', slotResult.scheduledPublishAt);
    console.log(
      `[slot_finder] ${jobId}: auto-slotted for ${slotPlatform} at ` +
      `${new Date(slotResult.scheduledPublishAt).toISOString()} ` +
      `(day=${slotResult.slot.day}, time=${slotResult.slot.time})`
    );
  } catch (err) {
    logErr('CPD873_UPDATE_SCHEDULE_FAIL', err, { jobId });
    // Roll back spec changes if DB write failed
    spec.status = 'complete';
    delete spec.order.publish.scheduledPublishAt;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Compute the next occurrence of a slot at or after `fromDate`.
 * Returns a Date object or null.
 *
 * @param {{ day: number, time: string }} slot  day=−1 means daily
 * @param {Date} fromDate
 */
function _nextOccurrence(slot, fromDate) {
  const [hh, mm] = slot.time.split(':').map(Number);
  if (isNaN(hh) || isNaN(mm)) return null;

  if (slot.day === -1) {
    // Daily: next occurrence of this time on or after fromDate
    const candidate = new Date(fromDate);
    candidate.setHours(hh, mm, 0, 0);
    if (candidate <= fromDate) {
      // Time already passed today — move to tomorrow
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(hh, mm, 0, 0);
    }
    return candidate;
  }

  // Specific weekday (0=Sun … 6=Sat)
  const candidate = new Date(fromDate);
  candidate.setHours(hh, mm, 0, 0);
  const currentDay = candidate.getDay();
  let daysAhead = (slot.day - currentDay + 7) % 7;
  if (daysAhead === 0 && candidate <= fromDate) daysAhead = 7;
  candidate.setDate(candidate.getDate() + daysAhead);
  candidate.setHours(hh, mm, 0, 0);
  return candidate;
}

/**
 * Return the Monday-00:00:00 → Sunday-23:59:59 bounds (as ms) for the week
 * containing `date`.
 */
function _weekBoundsMs(date) {
  const d    = new Date(date);
  const day  = d.getDay();                     // 0=Sun … 6=Sat
  const diff = (day === 0 ? -6 : 1 - day);     // shift to Monday
  const mon  = new Date(d);
  mon.setDate(d.getDate() + diff);
  mon.setHours(0, 0, 0, 0);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  sun.setHours(23, 59, 59, 999);
  return { weekStart: mon.getTime(), weekEnd: sun.getTime() };
}

/**
 * Count already-scheduled or recently-published jobs for a brand+platform
 * within a time window (ms timestamps).
 */
async function _countScheduledInWindow(brandId, platform, windowStartMs, windowEndMs) {
  if (!brandId) return 0;
  try {
    const sql = `
      SELECT COUNT(*) AS cnt
      FROM   jobs
      WHERE  brand_id            = $1
      AND    status               IN ('ready_to_publish', 'published')
      AND    scheduled_publish_at >= $2
      AND    scheduled_publish_at <= $3
    `;
    const { rows } = await query(sql, [brandId, windowStartMs, windowEndMs]);
    return parseInt(rows[0]?.cnt || '0', 10);
  } catch {
    return 0;  // non-fatal — assume under cap if DB fails
  }
}

module.exports = {
  findNextPublishSlot,
  autoSlotApprovedJob,
  _nextOccurrence,   // exported for tests
  _weekBoundsMs,     // exported for tests
};
