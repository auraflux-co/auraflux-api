'use strict';
/**
 * lib/services/slack_slash_call.js — Slack /call slash command → Telnyx click-to-call.
 */

const { logError } = require('../error_logger');

function getAllowedUserIds() {
  const raw = process.env.SLACK_CALL_ALLOWED_USER_IDS || '';
  if (!raw.trim()) return null;
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * Normalize user input to E.164 (US default for 10-digit numbers).
 * @param {string} input
 * @returns {string|null}
 */
function normalizeDialNumber(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  if (raw.startsWith('+')) {
    const digits = raw.replace(/\D/g, '');
    return digits ? `+${digits}` : null;
  }

  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

function slackEphemeral(text) {
  return {
    response_type: 'ephemeral',
    text: String(text || '').slice(0, 3900),
  };
}

/**
 * Handle Slack slash command payload (application/x-www-form-urlencoded).
 * @param {Record<string, string>} body
 */
async function handleSlackCallCommand(body) {
  const command = (body?.command || '').trim().toLowerCase();
  if (command && command !== '/call') {
    return slackEphemeral(`Unknown command: ${command}`);
  }

  const allowed = getAllowedUserIds();
  if (allowed && body?.user_id && !allowed.has(body.user_id)) {
    return slackEphemeral('You are not authorized to place outbound calls.');
  }

  const to = normalizeDialNumber(body?.text);
  if (!to) {
    return slackEphemeral('Usage: `/call +15551234567` or `/call 5551234567`');
  }

  try {
    const { startOutboundClickToCall } = require('../services/telnyx_voice_control');
    const result = await startOutboundClickToCall({
      destination: to,
      slackUserId: body?.user_id,
    });
    return slackEphemeral(
      `📞 Ringing your phone (${result.operatorPhone}). Answer to connect to *${to}*.`,
    );
  } catch (err) {
    logError('[slack_slash_call] dial failed', err, { to, user: body?.user_id });
    return slackEphemeral(`❌ Call failed: ${err.message}`);
  }
}

module.exports = {
  normalizeDialNumber,
  handleSlackCallCommand,
  slackEphemeral,
};
