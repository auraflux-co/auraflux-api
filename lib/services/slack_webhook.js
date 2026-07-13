'use strict';
/**
 * lib/services/slack_webhook.js
 *
 * Safe Slack incoming-webhook posts. Avoids common 400 causes:
 * - missing top-level `text`
 * - invalid mrkdwn characters
 * - `style` on link buttons (not allowed)
 * - missing Content-Type header
 */

const axios = require('axios');
const { logError } = require('../error_logger');

/** Escape characters that break Slack mrkdwn. */
function escapeMrkdwn(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Strip control chars; keep common punctuation. */
function sanitizePlainText(str, maxLen = 2000) {
  return String(str || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, maxLen)
    .trim();
}

/**
 * Post to a Slack incoming webhook.
 * @param {string} webhookUrl
 * @param {{ text: string, blocks?: object[] }} payload
 * @returns {Promise<boolean>}
 */
async function postSlackWebhook(webhookUrl, { text, blocks }) {
  if (!webhookUrl) return false;

  const safeText = sanitizePlainText(text, 3900);
  if (!safeText) {
    console.warn('[slack_webhook] skipped — empty text');
    return false;
  }

  const body = { text: safeText };
  if (Array.isArray(blocks) && blocks.length) {
    body.blocks = blocks;
  }

  try {
    await axios.post(webhookUrl, body, {
      timeout: 8000,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      validateStatus: (s) => s >= 200 && s < 300,
    });
    return true;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data || err.message;
    logError('[slack_webhook] post failed', err, { status, detail: String(detail).slice(0, 200) });
    return false;
  }
}

/**
 * Link button — no `style` (Slack rejects style on url buttons → HTTP 400).
 */
function slackLinkButton(label, url) {
  return {
    type: 'button',
    text: { type: 'plain_text', text: sanitizePlainText(label, 75) || 'Open' },
    url: String(url || '').slice(0, 3000),
  };
}

module.exports = {
  escapeMrkdwn,
  sanitizePlainText,
  postSlackWebhook,
  slackLinkButton,
};
