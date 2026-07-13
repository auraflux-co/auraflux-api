'use strict';
/**
 * lib/routes/voice_phone.js — WebRTC phone API (superadmin operators).
 */

const router = require('express').Router();
const { requireAuth, requireRole, ROLES } = require('../auth');
const { logError } = require('../error_logger');
const { getLines } = require('../services/telnyx_line_routing');
const {
  createLoginToken,
  touchPresence,
  clearPresence,
  getOnlineAgents,
  phonePageUrl,
} = require('../services/telnyx_webrtc');
const { listRecentCalls } = require('../services/voice_call_log');

const superadmin = [requireAuth, requireRole({ minLevel: ROLES.SUPERADMIN })];

// GET /api/phone/lines — caller ID lines for dial UI
router.get('/api/phone/lines', ...superadmin, (req, res) => {
  const { ca, us } = getLines();
  res.json({
    ok: true,
    lines: [
      { key: '437', label: 'CA 437', number: ca },
      { key: '571', label: 'US 571', number: us },
    ],
  });
});

// GET /api/phone/token — short-lived Telnyx WebRTC JWT
router.get('/api/phone/token', ...superadmin, async (req, res) => {
  try {
    const clerkUserId = req.auth?.userId || req.user?.id;
    if (!clerkUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const displayName = req.auth?.sessionClaims?.name
      || req.auth?.sessionClaims?.email
      || clerkUserId;

    const tokenData = await createLoginToken(clerkUserId, displayName);
    res.json({ ok: true, ...tokenData });
  } catch (err) {
    logError('[voice_phone] token', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/phone/presence — heartbeat while phone page is open
router.post('/api/phone/presence', ...superadmin, async (req, res) => {
  try {
    const clerkUserId = req.auth?.userId || req.user?.id;
    if (!clerkUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const status = String(req.body?.status || 'online').toLowerCase();
    const displayName = req.body?.displayName || null;

    if (status === 'offline') {
      await clearPresence(clerkUserId);
      return res.json({ ok: true, status: 'offline' });
    }

    const row = await touchPresence(clerkUserId, { status: 'online', displayName });
    if (!row) {
      return res.status(400).json({
        ok: false,
        error: 'No WebRTC credential — fetch token first',
      });
    }
    res.json({ ok: true, status: row.status, lastSeenAt: row.last_seen_at });
  } catch (err) {
    logError('[voice_phone] presence', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/phone/agents — who's online (for debug / UI badge)
router.get('/api/phone/agents', ...superadmin, async (req, res) => {
  try {
    const agents = await getOnlineAgents();
    res.json({
      ok: true,
      agents: agents.map((a) => ({
        clerkUserId: a.clerk_user_id,
        displayName: a.display_name,
        status: a.status,
        lastSeenAt: a.last_seen_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/phone/calls — recent call log
router.get('/api/phone/calls', ...superadmin, async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const calls = await listRecentCalls(limit);
    res.json({ ok: true, calls });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/phone/config — public-ish config for phone UI
router.get('/api/phone/config', ...superadmin, (req, res) => {
  res.json({
    ok: true,
    phonePageUrl: phonePageUrl(),
    heartbeatSec: 15,
  });
});

module.exports = router;
