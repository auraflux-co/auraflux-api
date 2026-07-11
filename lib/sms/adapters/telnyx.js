'use strict';
/**
 * lib/sms/adapters/telnyx.js
 *
 * Telnyx adapter — implements the SMS adapter contract:
 *   sendSms({ to, from, body }) → { sid, status }
 *   validateWebhook(req)       → Promise<boolean>
 *   parseInbound(req)          → { from, body } | null
 *   buildReply(text)           → { status, headers, body } to send as HTTP response
 *
 * Webhook verification uses the official Telnyx SDK (Ed25519) with req.rawBody
 * captured by express.json verify callback in server.js.
 */

const { TelnyxWebhook } = require('telnyx');
const { logError } = require('../../error_logger');

let _telnyx = null;
function getClient() {
  if (_telnyx) return _telnyx;
  const key = process.env.TELNYX_API_KEY;
  if (!key) return null;
  _telnyx = require('telnyx')(key);
  return _telnyx;
}

function _rawPayload(req) {
  if (req.rawBody) {
    return Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody);
  }
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  return JSON.stringify(req.body);
}

/**
 * Verify Telnyx Ed25519 webhook signature via official SDK.
 * Requires TELNYX_PUBLIC_KEY and req.rawBody from express.json verify callback.
 */
async function validateWebhook(req) {
  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  if (!publicKey) {
    console.warn('[telnyx] TELNYX_PUBLIC_KEY not set — rejecting webhook in production');
    return false;
  }

  try {
    const webhook = new TelnyxWebhook(publicKey);
    await webhook.verify(_rawPayload(req), req.headers);
    return true;
  } catch (err) {
    logError('[telnyx] webhook signature verification failed', err, {
      hasRawBody: !!req.rawBody,
      path: req.path,
    });
    return false;
  }
}

/**
 * Parse inbound SMS fields from Telnyx JSON webhook.
 * Returns { from, body } or null if event isn't an inbound message.
 */
function parseInbound(req) {
  const evt = req.body?.data;
  if (!evt || evt.event_type !== 'message.received') return null;
  const payload = evt.payload || {};
  const from = payload.from?.phone_number || null;
  const to   = payload.to?.[0]?.phone_number || null;
  const body = (payload.text || '').trim();
  if (!from || !body) return null;
  return { from, to, body };
}

/**
 * Send an SMS via Telnyx API.
 * @param {{ to: string, from: string, body: string }} opts
 * @returns {{ sid: string, status: string }}
 */
async function sendSms({ to, from: fromNumber, body }) {
  const client = getClient();
  if (!client) throw new Error('Telnyx client not initialised — TELNYX_API_KEY missing');

  const number = fromNumber || process.env.TELNYX_NUMBER;
  const msg = await client.messages.create({ from: number, to, text: body });
  return {
    sid:    msg.data?.id || msg.id,
    status: msg.data?.status || msg.status || 'queued',
  };
}

/**
 * Build the HTTP response for an inbound webhook (reply via API, not TwiML).
 */
async function buildReply(text, recipientInfo) {
  if (text && recipientInfo?.from) {
    const number = process.env.TELNYX_NUMBER;
    try {
      await sendSms({ to: recipientInfo.from, from: number, body: text });
    } catch (err) {
      logError('TELNYX_REPLY_FAIL', err, { to: recipientInfo.from });
    }
  }
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' };
}

module.exports = { validateWebhook, parseInbound, sendSms, buildReply };
