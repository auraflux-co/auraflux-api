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

const IGNORE_MESSAGE_SUBTYPES = new Set([
  'bot_message',
  'message_changed',
  'message_deleted',
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'ekm_access_denied',
]);

function extractEventText(event) {
  if (event?.text) return sanitizePlainText(event.text, 1500);
  const block = event?.blocks?.find((b) => b.type === 'rich_text');
  const el = block?.elements?.[0]?.elements?.[0];
  if (el?.text) return sanitizePlainText(el.text, 1500);
  return '';
}

async function findRecentThreadMappings(channel, limit = 2) {
  const { rows } = await db.query(
    `SELECT slack_thread_ts, from_number, to_number, brand_name
       FROM slack_sms_threads
      WHERE slack_channel = $1
        AND created_at > NOW() - INTERVAL '2 hours'
      ORDER BY created_at DESC
      LIMIT $2`,
    [channel, limit],
  );
  return rows;
}

async function lookupThreadMapping(channel, threadTs) {
  const { rows } = await db.query(
    `SELECT from_number, to_number, brand_name FROM slack_sms_threads
      WHERE slack_channel = $1 AND slack_thread_ts = $2 LIMIT 1`,
    [channel, threadTs],
  );
  return rows[0] || null;
}

async function sendThreadSms({ channel, threadTs, mapping, replyText }) {
  await sms.sendSms({
    to:   mapping.from_number,
    from: mapping.to_number,
    body: replyText,
  });

  if (botConfigured()) {
    await postMessage({
      channel,
      threadTs,
      text: `✅ Sent to ${mapping.from_number} from ${mapping.to_number}`,
    });
  }

  return { handled: true, to: mapping.from_number, from: mapping.to_number };
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
  if (!event || event.type !== 'message') {
    return { handled: false, reason: 'not_message' };
  }
  if (event.bot_id || (event.subtype && IGNORE_MESSAGE_SUBTYPES.has(event.subtype))) {
    return { handled: false, reason: 'bot_or_ignored_subtype', subtype: event.subtype || null };
  }

  const channel = event.channel;
  const smsChannel = getSmsChannelId();
  if (smsChannel && channel !== smsChannel) {
    return { handled: false, reason: 'wrong_channel', channel };
  }

  const replyText = extractEventText(event);
  if (!replyText) {
    return { handled: false, reason: 'empty_text' };
  }

  let threadTs = event.thread_ts;
  let mapping = null;

  if (threadTs && threadTs !== event.ts) {
    mapping = await lookupThreadMapping(channel, threadTs);
    if (!mapping) {
      console.warn('[slack_sms_reply] no mapping for thread', { channel, threadTs });
    }
  } else {
    // Common mistake: reply in channel instead of inside the thread.
    const recent = await findRecentThreadMappings(channel, 2);
    if (recent.length === 1) {
      threadTs = recent[0].slack_thread_ts;
      mapping = recent[0];
      console.log('[slack_sms_reply] channel reply routed to sole active thread', { channel, threadTs });
    } else if (recent.length > 1 && botConfigured()) {
      await postMessage({
        channel,
        threadTs: recent[0].slack_thread_ts,
        text: '⚠️ Multiple SMS threads are active — reply *inside* the specific thread to text that sender back.',
      });
      return { handled: false, reason: 'ambiguous_channel_reply' };
    } else if (botConfigured()) {
      const latest = recent[0];
      if (latest) {
        await postMessage({
          channel,
          threadTs: latest.slack_thread_ts,
          text: '⚠️ Reply *in the thread* on the inbound SMS message to send a text back (channel messages are not forwarded).',
        });
      }
      return { handled: false, reason: 'channel_reply_not_threaded' };
    }
    return { handled: false, reason: 'no_thread_ts' };
  }

  if (!mapping) {
    return { handled: false, reason: 'no_thread_mapping', channel, threadTs };
  }

  try {
    return await sendThreadSms({ channel, threadTs, mapping, replyText });
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
  findRecentThreadMappings,
  extractEventText,
  notifyInboundSmsWithReply,
  handleSlackMessageEvent,
};
