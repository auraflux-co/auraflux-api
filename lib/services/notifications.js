'use strict';
/**
 * lib/services/notifications.js — DB-backed notification helper (CPD-307)
 *
 * createNotification() is the single write point. Call it fire-and-forget
 * from any server-side trigger (pipeline, publish, billing, OAuth, scheduler).
 * It never throws — errors are logged but never surfaced to callers.
 *
 * Type registry:
 *   job_ready          — job complete / staged, user must review
 *   job_failed         — job reached terminal failure
 *   job_held           — job paused, needs user input
 *   job_published      — job successfully published to a platform
 *   credits_low        — balance < 10% of monthly allowance
 *   credits_exhausted  — balance = 0
 *   credit_pack_purchased — credit pack added via Stripe
 *   platform_connected — OAuth account linked
 *   platform_expired   — OAuth token could not be refreshed
 *   scheduled_missed   — scheduled job didn't fire
 *   template_failed    — recurring template job failed
 *   operator_note      — operator left a comment (guided/managed)
 *   support_resolved   — support session closed
 */

const { query } = require('../db');

/**
 * Write a notification row. Fire-and-forget safe — never throws.
 *
 * @param {string} customerId
 * @param {object} opts
 * @param {string} opts.type       — one of the type keys above
 * @param {string} opts.title      — short headline (max ~60 chars)
 * @param {string} [opts.body]     — optional detail line
 * @param {string} [opts.actionUrl] — URL to navigate to on click
 */
async function createNotification(customerId, { type, title, body = null, actionUrl = null }) {
  if (!customerId || !type || !title) return;
  try {
    await query(
      `INSERT INTO notifications (customer_id, type, title, body, action_url)
       VALUES ($1, $2, $3, $4, $5)`,
      [customerId, type, title, body, actionUrl]
    );
  } catch (err) {
    console.error('[notifications] createNotification failed:', err.message, { customerId, type });
  }
}

/**
 * Fetch notifications for a customer — unread first, then up to 20 read.
 * @param {string} customerId
 * @returns {Promise<Array>}
 */
async function listNotifications(customerId) {
  const { rows } = await query(
    `(SELECT id, type, title, body, action_url, read, created_at
        FROM notifications
       WHERE customer_id = $1 AND read = FALSE
       ORDER BY created_at DESC)
     UNION ALL
     (SELECT id, type, title, body, action_url, read, created_at
        FROM notifications
       WHERE customer_id = $1 AND read = TRUE
       ORDER BY created_at DESC
       LIMIT 20)`,
    [customerId]
  );
  return rows;
}

/**
 * Mark a single notification as read.
 * @param {string} customerId
 * @param {number} notifId
 */
async function markRead(customerId, notifId) {
  await query(
    'UPDATE notifications SET read = TRUE WHERE id = $1 AND customer_id = $2',
    [notifId, customerId]
  );
}

/**
 * Mark all notifications as read for a customer.
 * @param {string} customerId
 */
async function markAllRead(customerId) {
  await query(
    'UPDATE notifications SET read = TRUE WHERE customer_id = $1 AND read = FALSE',
    [customerId]
  );
}

module.exports = { createNotification, listNotifications, markRead, markAllRead };
