'use strict';
/**
 * lib/voice/adapters/telnyx.js — Telnyx Programmable Voice outbound dial.
 */

const { Telnyx } = require('telnyx');
const { logError } = require('../../error_logger');

let _client = null;
function getClient() {
  if (_client) return _client;
  const key = process.env.TELNYX_API_KEY;
  if (!key) return null;
  _client = new Telnyx(key);
  return _client;
}

function getConnectionId() {
  return process.env.TELNYX_VOICE_CONNECTION_ID
    || process.env.TELNYX_CALL_CONTROL_APP_ID
    || null;
}

function getFromNumber() {
  return process.env.TELNYX_VOICE_FROM_NUMBER
    || process.env.TELNYX_NUMBER
    || process.env.SUPPORT_SMS_NUMBER
    || null;
}

/**
 * Place an outbound call via Telnyx Call Control.
 * @param {{ to: string, from?: string, connectionId?: string }} opts
 * @returns {{ callControlId: string, callSessionId?: string }}
 */
async function dial({ to, from, connectionId }) {
  const client = getClient();
  if (!client) throw new Error('Telnyx client not initialised — TELNYX_API_KEY missing');

  const conn = connectionId || getConnectionId();
  if (!conn) throw new Error('TELNYX_VOICE_CONNECTION_ID not configured');

  const caller = from || getFromNumber();
  if (!caller) throw new Error('TELNYX_VOICE_FROM_NUMBER not configured');

  try {
    const resp = await client.calls.dial({
      connection_id: conn,
      from: caller,
      to,
    });
    return {
      callControlId: resp.data?.call_control_id || null,
      callSessionId: resp.data?.call_session_id || null,
      from: caller,
      to,
    };
  } catch (err) {
    const detail = err?.error?.errors?.[0]?.detail || err.message;
    logError('[telnyx_voice] dial failed', err, { to, from: caller, connectionId: conn });
    throw new Error(detail || 'Telnyx dial failed');
  }
}

module.exports = { dial, getConnectionId, getFromNumber };
