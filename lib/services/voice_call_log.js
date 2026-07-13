'use strict';
/**
 * voice_call_log — persist inbound/outbound call events for operator phone.
 */

const { query } = require('../db');
const { postMessage, botConfigured } = require('./slack_bot');

async function createCall({
  direction,
  fromNumber,
  toNumber,
  auraLine,
  callControlId,
  callSessionId,
  status = 'ringing',
  agentClerkId,
  slackUserId,
  metadata = {},
}) {
  const { rows } = await query(
    `INSERT INTO voice_call_log
       (direction, from_number, to_number, aura_line, call_control_id, call_session_id,
        status, agent_clerk_id, slack_user_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING *`,
    [
      direction,
      fromNumber || null,
      toNumber || null,
      auraLine || null,
      callControlId || null,
      callSessionId || null,
      status,
      agentClerkId || null,
      slackUserId || null,
      JSON.stringify(metadata || {}),
    ],
  );
  return rows[0];
}

async function updateCallByControlId(callControlId, patch) {
  if (!callControlId) return null;
  const fields = [];
  const vals = [];
  let i = 1;

  const map = {
    status: 'status',
    agentClerkId: 'agent_clerk_id',
    answeredAt: 'answered_at',
    endedAt: 'ended_at',
    metadata: 'metadata',
  };

  for (const [key, col] of Object.entries(map)) {
    if (patch[key] === undefined) continue;
    if (key === 'metadata') {
      fields.push(`${col} = $${i}::jsonb`);
      vals.push(JSON.stringify(patch.metadata));
    } else if (key === 'answeredAt' || key === 'endedAt') {
      fields.push(`${col} = $${i}`);
      vals.push(patch[key]);
    } else {
      fields.push(`${col} = $${i}`);
      vals.push(patch[key]);
    }
    i += 1;
  }

  if (!fields.length) return null;
  vals.push(callControlId);
  const { rows } = await query(
    `UPDATE voice_call_log SET ${fields.join(', ')}
      WHERE call_control_id = $${i}
      RETURNING *`,
    vals,
  );
  return rows[0] || null;
}

async function finalizeCallByControlId(callControlId, { missedReason } = {}) {
  if (!callControlId) return null;
  const { rows } = await query(
    `UPDATE voice_call_log SET
       status = CASE WHEN answered_at IS NOT NULL THEN 'completed' ELSE 'missed' END,
       ended_at = NOW()
     WHERE call_control_id = $1
       AND ended_at IS NULL
     RETURNING *`,
    [callControlId],
  );
  const row = rows[0] || null;
  if (row && row.status === 'missed' && missedReason) {
    await notifyMissedCall({
      fromNumber: row.from_number,
      toNumber: row.to_number,
      reason: missedReason,
    });
  }
  return row;
}

async function listRecentCalls(limit = 50) {
  const { rows } = await query(
    `SELECT id, call_control_id, direction, from_number, to_number, aura_line,
            status, agent_clerk_id, started_at, answered_at, ended_at
       FROM voice_call_log
      ORDER BY started_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows;
}

async function notifyMissedCall({ fromNumber, toNumber, reason }) {
  if (!botConfigured()) return;
  const channel = process.env.SLACK_SMS_CHANNEL_ID;
  if (!channel) return;
  const text = `📵 Missed call to *${toNumber || 'unknown'}* from *${fromNumber || 'unknown'}*`
    + (reason ? ` — ${reason}` : '');
  await postMessage({ channel, text }).catch(() => {});
}

module.exports = {
  createCall,
  updateCallByControlId,
  finalizeCallByControlId,
  listRecentCalls,
  notifyMissedCall,
};
