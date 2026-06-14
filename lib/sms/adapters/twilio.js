'use strict';
/**
 * lib/sms/adapters/twilio.js — legacy Twilio adapter (kept for rollback).
 * Implements the same contract as the Telnyx adapter.
 */

let _client = null;
function getClient() {
  if (_client) return _client;
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  _client = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  return _client;
}

function validateWebhook(req) {
  const { TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_AUTH_TOKEN) return false;
  const twilio = require('twilio');
  const url = `${process.env.NEXT_PUBLIC_API_URL || 'https://auraflux-api.onrender.com'}/support/sms-webhook`;
  return twilio.validateRequest(TWILIO_AUTH_TOKEN, req.headers['x-twilio-signature'] || '', url, req.body || {});
}

function parseInbound(req) {
  const from = req.body?.From;
  const to   = req.body?.To || null;
  const body = req.body?.Body?.trim();
  if (!from || !body) return null;
  return { from, to, body };
}

async function sendSms({ to, from: fromNumber, body }) {
  const client = getClient();
  if (!client) throw new Error('Twilio client not initialised — TWILIO_ACCOUNT_SID/AUTH_TOKEN missing');
  const number = fromNumber || process.env.TWILIO_NUMBER;
  const msg = await client.messages.create({ from: number, to, body });
  return { sid: msg.sid, status: msg.status };
}

async function buildReply(text) {
  const MessagingResponse = require('twilio').twiml.MessagingResponse;
  const twiml = new MessagingResponse();
  if (text) twiml.message(text);
  return {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
    body: twiml.toString(),
  };
}

module.exports = { validateWebhook, parseInbound, sendSms, buildReply };
