'use strict';
/**
 * lib/routes/notifications.js — Notification API for the bell UI (CPD-307)
 *
 * GET    /notifications           — list unread + last 20 read
 * PATCH  /notifications/:id/read  — mark one read
 * PATCH  /notifications/read-all  — mark all read
 */

const router     = require('express').Router();
const { requireAuth } = require('../auth');
const { listNotifications, markRead, markAllRead } = require('../services/notifications');

// GET /notifications
router.get('/notifications', requireAuth, async (req, res) => {
  try {
    const rows = await listNotifications(req.user.id);
    res.json({
      ok:          true,
      notifications: rows.map((r) => ({
        id:        r.id,
        type:      r.type,
        title:     r.title,
        body:      r.body,
        actionUrl: r.action_url,
        read:      r.read,
        createdAt: r.created_at,
      })),
      unreadCount: rows.filter((r) => !r.read).length,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /notifications/read-all  (must come before /:id route)
router.patch('/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await markAllRead(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /notifications/:id/read
router.patch('/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ ok: false, error: 'invalid id' });
    await markRead(req.user.id, id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
