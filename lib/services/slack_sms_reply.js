'use strict';
/**
 * lib/services/slack_sms_reply.js
 *
 * Two-way Telnyx SMS ↔ Slack:
 *   Inbound SMS → post to Slack channel (bot) → store thread mapping
 *   Thread reply in Slack → send SMS via Telnyx to original sender
 */

const db = require('../db/postgres');
const sms = require('../sms');
const { logError } = require('../error_logger');
const { sanitizePlainText, postSlackWebhook } = require('./slack_webhook');
const {
  botConfigured,
  replyEnabled,
  getSmsChannelId,
  postMessage,
  formatInboundBlocks,
} = require('./slack_bot');
const {
  shouldNotifyForNumber,
  extractVerificationCode,
  resolveWebhookUrl,
} = require('./telnyx_slack_notify');

async function saveThreadMapping({ channel, threadTs, from, to, brandName, body }) {
  await db.query(
    `INSERT INTO slack_sms_threads (slack_channel, slack_thread_ts, from_number, to_number, brand_name, last_inbound)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (slack_channel, slack_thread_ts)
     DO UPDATE SET from_number = EXCLUDED.from_number,
                   to_number = EXCLUDED.to_number,
                   brand_name = EXCLUDED.brand_name,
                   last_inbound = EXCLUDED.last_inbound`,
    [channel, threadTs, from, to, brandName || null, body?.slice(0, 500) || null],
  );
}

async function lookupThreadMapping(channel, threadTs) {
  const { rows } = await db.query(
    `SELECT from_number, to_number, brand_name FROM slack_sms_threads
      WHERE slack_channel = $1 AND slack_thread_ts = $2 LIMIT 1`,
    [channel, threadTs],
  );
  return rows[0] || null;
}

/**
 * Post inbound SMS to Slack and register thread for replies.
 */
async function notifyInboundSmsWithReply({ from, to, body, brandName }) {
  if (!shouldNotifyForNumber(to)) return { ok: false, skipped: true };

  const code = extractVerificationCode(body);
  const text = code
    ? `Inbound SMS${brandName ? ` (${brandName})` : ''}: code ${code}`
    : `Inbound SMS${brandName ? ` (${brandName})` : ''} from ${from}`;

  const blocks = formatInboundBlocks({ from, to, body, brandName, code });

  if (botConfigured()) {
    const channel = getSmsChannelId();
    const posted = await postMessage({ channel, text, blocks });
    if (posted.ok && posted.ts && replyEnabled()) {
      await saveThreadMapping({
        channel: posted.channel || channel,
        threadTs: posted.ts,
        from,
        to,
        brandName,
        body,
      });
    }
    return posted;
  }

  const webhookUrl = resolveWebhookUrl();
  if (!webhookUrl) return { ok: false, error: 'no_slack_config' };
  const ok = await postSlackWebhook(webhookUrl, { text, blocks });
  return { ok, webhookOnly: true };
}

/**
 * Handle Slack Events API message (thread reply → outbound SMS).
 */
async function handleSlackMessageEvent(event) {
  if (!event || event.type !== 'message') return { handled: false };
  if (event.bot_id || event.subtype === 'bot_message') return { handled: false };
  if (!event.thread_ts || event.thread_ts === event.ts) return { handled: false };

  const channel = event.channel;
  const threadTs = event.thread_ts;
  const replyText = sanitizePlainText(event.text, 1500);
  if (!replyText) return { handled: false };

  const smsChannel = getSmsChannelId();
  if (smsChannel && channel !== smsChannel) return { handled: false };

  const mapping = await lookupThreadMapping(channel, threadTs);
  if (!mapping) {
    return { handled: false, reason: 'no_thread_mapping' };
  }

  try {
    await sms.sendSms({
      to:   mapping.from_number,
      from: mapping.to_number,
      body: replyText,
    });

    if (botConfigured()) {
      await postMessage({
        channel,
        threadTs,
        text: `✅ Sent to ${mapping.from_number}`,
      });
    }

    return { handled: true, to: mapping.from_number, from: mapping.to_number };
  } catch (err) {
    logError('[slack_sms_reply] outbound SMS failed', err, { channel, threadTs });
    if (botConfigured()) {
      await postMessage({
        channel,
        threadTs,
        text: `❌ Failed to send SMS: ${err.message}`,
      });
    }
    return { handled: true, error: err.message };
  }
}

module.exports = {
  saveThreadMapping,
  lookupThreadMapping,
  notifyInboundSmsWithReply,
  handleSlackMessageEvent,
};
