'use strict';
/**
 * lib/sms/adapters/telnyx.js
 *
 * Telnyx adapter — implements the SMS adapter contract:
 *   sendSms({ to, from, body }) → { sid, status }
 *   validateWebhook(req)       → boolean
 *   parseInbound(req)          → { from, body } | null
 *   buildReply(text)           → { status, headers, body } to send as HTTP response
 *
 * Telnyx differences from Twilio:
 *   - Webhook payloads are JSON (not URL-encoded)
 *   - Signature verification uses Ed25519 with TELNYX_PUBLIC_KEY
 *   - Replies are fire-and-forget via API (no TwiML XML)
 *   - Delivery status uses event_type 'message.finalized'
 */

const { logError } = require('../../logger');

let _telnyx = null;
function getClient() {
  if (_telnyx) return _telnyx;
  const key = process.env.TELNYX_API_KEY;
  if (!key) return null;
  _telnyx = require('telnyx')(key);
  return _telnyx;
}

/**
 * Verify Telnyx Ed25519 webhook signature.
 * Header: telnyx-signature-ed25519   (base64 signature)
 * Header: telnyx-timestamp           (unix seconds)
 * Telnyx signs: timestamp + '|' + rawBody
 */
function validateWebhook(req) {
  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  if (!publicKey) return false;

  try {
    const telnyx = require('telnyx')(process.env.TELNYX_API_KEY || 'placeholder');
    telnyx.webhooks.constructEvent(
      req.rawBody || JSON.stringify(req.body),
      req.headers['telnyx-signature-ed25519'] || '',
      req.headers['telnyx-timestamp'] || '',
      publicKey,
      300, // 5-minute tolerance
    );
    return true;
  } catch {
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
 * Sends the reply as a separate API call and returns a simple 200 ACK.
 * @param {string} text — reply text to send
 * @param {{ from: string, to: string }} recipientInfo — swap from/to for reply
 * @returns {object} { status, headers, body }
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
  // Telnyx expects a 200 OK with empty body
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' };
}

module.exports = { validateWebhook, parseInbound, sendSms, buildReply };
