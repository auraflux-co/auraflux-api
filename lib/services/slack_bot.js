'use strict';
/**
 * lib/services/slack_bot.js — Slack Bot API + request verification (Events API).
 */

const crypto = require('crypto');
const axios = require('axios');
const { logError } = require('../error_logger');
const { escapeMrkdwn, sanitizePlainText } = require('./slack_webhook');

const SLACK_API = 'https://slack.com/api';

function getBotToken() {
  return process.env.SLACK_BOT_TOKEN || null;
}

function getSigningSecret() {
  return process.env.SLACK_SIGNING_SECRET || null;
}

function getSmsChannelId() {
  return process.env.SLACK_SMS_CHANNEL_ID || process.env.SLACK_TELNYX_CHANNEL_ID || null;
}

function botConfigured() {
  return !!(getBotToken() && getSmsChannelId());
}

function replyEnabled() {
  return botConfigured() && getSigningSecret();
}

/**
 * Verify Slack Events API request (v0 HMAC).
 */
function verifySlackRequest(req) {
  const secret = getSigningSecret();
  if (!secret) return false;

  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (!timestamp || !signature) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 60 * 5) return false;

  const raw = req.rawBody
    ? (Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody))
    : JSON.stringify(req.body);

  const base = `v0:${timestamp}:${raw}`;
  const expected = `v0=${crypto.createHmac('sha256', secret).update(base).digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Post a message via chat.postMessage. Returns { ok, ts, channel }.
 */
async function postMessage({ channel, text, blocks, threadTs }) {
  const token = getBotToken();
  if (!token) return { ok: false, error: 'no_bot_token' };

  const body = {
    channel: channel || getSmsChannelId(),
    text:    sanitizePlainText(text, 3900),
  };
  if (blocks?.length) body.blocks = blocks;
  if (threadTs) body.thread_ts = threadTs;

  try {
    const resp = await axios.post(`${SLACK_API}/chat.postMessage`, body, {
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      timeout: 10000,
    });
    if (!resp.data?.ok) {
      logError('[slack_bot] chat.postMessage failed', new Error(resp.data?.error || 'unknown'), {});
      return { ok: false, error: resp.data?.error };
    }
    return { ok: true, ts: resp.data.ts, channel: resp.data.channel };
  } catch (err) {
    logError('[slack_bot] chat.postMessage error', err);
    return { ok: false, error: err.message };
  }
}

function formatInboundBlocks({ from, to, body, brandName, code }) {
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
  lines.push('_Reply in this thread to send an SMS back._');

  return [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
  ];
}

module.exports = {
  getBotToken,
  getSigningSecret,
  getSmsChannelId,
  botConfigured,
  replyEnabled,
  verifySlackRequest,
  postMessage,
  formatInboundBlocks,
};
