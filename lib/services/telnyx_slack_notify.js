'use strict';
/**
 * lib/services/telnyx_slack_notify.js
 *
 * Relay Telnyx SMS + voice events to Slack incoming webhooks.
 * Telnyx must POST to auraflux-api — NOT directly to Slack (payload shapes differ).
 */

const { escapeMrkdwn, sanitizePlainText, postSlackWebhook, slackLinkButton } = require('./slack_webhook');

const VOICE_EVENTS = new Set([
  'call.initiated',
  'call.answered',
  'call.hangup',
  'call.machine.detection.ended',
  'call.machine.greeting.ended',
  'call.bridged',
  'call.speak.ended',
  'call.dtmf.received',
]);

function resolveWebhookUrl() {
  return process.env.SLACK_TELNYX_WEBHOOK_URL
    || process.env.SLACK_SUPPORT_WEBHOOK_URL
    || null;
}

/** Optional comma-separated E.164 numbers — if set, only notify for these `to` lines. */
function getWatchedNumbers() {
  const raw = process.env.SLACK_TELNYX_NUMBERS || process.env.SLACK_TELNYX_NOTIFY_NUMBERS || '';
  if (!raw.trim()) return null;
  return raw.split(',').map((n) => n.trim()).filter(Boolean);
}

function shouldNotifyForNumber(toNumber) {
  const watched = getWatchedNumbers();
  if (!watched) return true;
  if (!toNumber) return false;
  const norm = String(toNumber).trim();
  return watched.some((w) => w === norm || w.replace(/\D/g, '') === norm.replace(/\D/g, ''));
}

function extractVerificationCode(body) {
  const m = String(body || '').match(/\b(\d{4,8})\b/);
  return m ? m[1] : null;
}

/**
 * @param {{ from: string, to: string, body: string, brandName?: string|null, inboxUrl?: string|null }} opts
 */
async function notifyInboundSms({ from, to, body, brandName, inboxUrl }) {
  const webhookUrl = resolveWebhookUrl();
  if (!webhookUrl || !shouldNotifyForNumber(to)) return false;

  const code = extractVerificationCode(body);
  const safeBody = escapeMrkdwn(sanitizePlainText(body, 500));
  const safeFrom = escapeMrkdwn(from || 'unknown');
  const safeTo = escapeMrkdwn(to || 'unknown');
  const label = brandName ? escapeMrkdwn(brandName) : safeTo;

  const lines = [
    `*Inbound SMS* → ${label}`,
    `*To:* ${safeTo}`,
    `*From:* ${safeFrom}`,
    `*Message:* ${safeBody}`,
  ];
  if (code) lines.push(`*Code:* \`${code}\``);

  const text = code
    ? `Inbound SMS to ${label}: code ${code}`
    : `Inbound SMS to ${label} from ${from}`;

  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') },
    },
  ];

  if (inboxUrl) {
    blocks.push({
      type: 'actions',
      elements: [slackLinkButton('Open SMS Inbox', inboxUrl)],
    });
  }

  return postSlackWebhook(webhookUrl, { text, blocks });
}

/**
 * Parse Telnyx voice webhook body.
 * @returns {{ eventType: string, from: string, to: string, direction: string, state?: string }|null}
 */
function parseVoiceEvent(req) {
  const evt = req.body?.data;
  if (!evt?.event_type || !VOICE_EVENTS.has(evt.event_type)) return null;
  const p = evt.payload || {};
  return {
    eventType: evt.event_type,
    from:      p.from || p.caller_id_number || '',
    to:        p.to || p.called_number || '',
    direction: p.direction || '',
    state:     p.state || p.hangup_cause || '',
    callControlId: p.call_control_id || null,
  };
}

/**
 * @param {{ eventType: string, from: string, to: string, direction?: string, state?: string }} evt
 */
async function notifyVoiceEvent(evt) {
  const webhookUrl = resolveWebhookUrl();
  if (!webhookUrl || !shouldNotifyForNumber(evt.to)) return false;

  const safeFrom = escapeMrkdwn(evt.from || 'unknown');
  const safeTo = escapeMrkdwn(evt.to || 'unknown');
  const safeType = escapeMrkdwn(evt.eventType.replace(/\./g, ' '));
  const safeDir = escapeMrkdwn(evt.direction || '');
  const safeState = evt.state ? escapeMrkdwn(String(evt.state)) : '';

  const lines = [
    `*Telnyx call:* ${safeType}`,
    `*To:* ${safeTo}`,
    `*From:* ${safeFrom}`,
  ];
  if (safeDir) lines.push(`*Direction:* ${safeDir}`);
  if (safeState) lines.push(`*State:* ${safeState}`);

  const text = `Telnyx ${evt.eventType}: ${evt.from} → ${evt.to}`;
  return postSlackWebhook(webhookUrl, {
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }],
  });
}

module.exports = {
  resolveWebhookUrl,
  getWatchedNumbers,
  shouldNotifyForNumber,
  extractVerificationCode,
  notifyInboundSms,
  parseVoiceEvent,
  notifyVoiceEvent,
  VOICE_EVENTS,
};
