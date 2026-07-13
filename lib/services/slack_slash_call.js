'use strict';
/**
 * lib/services/slack_slash_call.js — Slack /calling slash command → Telnyx click-to-call.
 */

const { logError } = require('../error_logger');
const { parseCallingArgs } = require('./telnyx_line_routing');

function getDialCommand() {
  return (process.env.SLACK_DIAL_COMMAND || '/calling').trim().toLowerCase();
}

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
  const dialCmd = getDialCommand();
  const command = (body?.command || '').trim().toLowerCase();
  if (command && command !== dialCmd) {
    return slackEphemeral(`Unknown command: ${command}`);
  }

  const allowed = getAllowedUserIds();
  if (allowed && body?.user_id && !allowed.has(body.user_id)) {
    return slackEphemeral('You are not authorized to place outbound calls.');
  }

  const parsed = parseCallingArgs(body?.text, normalizeDialNumber);
  if (!parsed) {
    return slackEphemeral(`Usage: \`${dialCmd} 437 +15551234567\` or \`${dialCmd} 571 +15551234567\``);
  }

  try {
    const { startOutboundCall } = require('../services/telnyx_voice_control');
    const result = await startOutboundCall({
      destination: parsed.to,
      from: parsed.from,
      slackUserId: body?.user_id,
    });
    return slackEphemeral(`📞 Dialing *${parsed.to}* from ${result.from}`);
  } catch (err) {
    logError('[slack_slash_call] dial failed', err, { to: parsed.to, from: parsed.from, user: body?.user_id });
    return slackEphemeral(`❌ Call failed: ${err.message}`);
  }
}

module.exports = {
  normalizeDialNumber,
  handleSlackCallCommand,
  slackEphemeral,
};
