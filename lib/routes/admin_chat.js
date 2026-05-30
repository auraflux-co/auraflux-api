'use strict';
/**
 * lib/routes/admin_chat.js — Superadmin: public chat inbox
 *
 * Exposes the marketing-site and app pre-sales chat sessions/messages
 * for superadmin review. Read-only; no reply capability (pre-sales AI handles replies).
 *
 * Auth: requireAuth + requireRole(ROLES.SUPERADMIN)
 *
 * GET  /api/admin/chat/sessions            list sessions (newest first)
 * GET  /api/admin/chat/sessions/:id        single session + messages
 * POST /api/admin/chat/sessions/:id/resolve mark resolved
 */

const express                        = require('express');
const router                         = express.Router();
const db                             = require('../db');
const { requireAuth, requireRole, ROLES } = require('../auth');

// ── GET /api/admin/chat/sessions ──────────────────────────────────────────────
router.get(
  '/api/admin/chat/sessions',
  requireAuth,
  requireRole(ROLES.SUPERADMIN),
  async (req, res) => {
    try {
      const limit    = Math.min(parseInt(req.query.limit  || '100', 10), 500);
      const offset   = parseInt(req.query.offset || '0', 10);
      const origin   = req.query.origin   || null;   // 'marketing' | 'app' | null = all
      const resolved = req.query.resolved;           // '1' | '0' | undefined = all
      const escalated = req.query.escalated;         // '1' | '0' | undefined = all

      const conds  = [];
      const params = [];

      if (origin) {
        params.push(origin);
        conds.push(`origin = $${params.length}`);
      }
      if (resolved === '1') {
        conds.push('resolved = TRUE');
      } else if (resolved === '0') {
        conds.push('resolved = FALSE');
      }
      if (escalated === '1') {
        conds.push('escalated = TRUE');
      }

      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      params.push(limit, offset);

      const { rows } = await db.query(
        `SELECT id, origin, visitor_ip, started_at, last_message_at,
                message_count, escalated, resolved, last_preview
         FROM   public_chat_sessions
         ${where}
         ORDER BY last_message_at DESC
         LIMIT  $${params.length - 1}
         OFFSET $${params.length}`,
        params
      );

      const { rows: [{ count }] } = await db.query(
        `SELECT COUNT(*)::int AS count FROM public_chat_sessions ${where}`,
        params.slice(0, -2)
      );

      return res.json({ ok: true, sessions: rows, total: count });
    } catch (err) {
      console.error('[admin/chat] list error:', err.message);
      return res.status(500).json({ ok: false, error: 'Failed to load sessions' });
    }
  }
);

// ── GET /api/admin/chat/sessions/:id ─────────────────────────────────────────
router.get(
  '/api/admin/chat/sessions/:id',
  requireAuth,
  requireRole(ROLES.SUPERADMIN),
  async (req, res) => {
    try {
      const { rows: [session] } = await db.query(
        `SELECT id, origin, visitor_ip, started_at, last_message_at,
                message_count, escalated, resolved, last_preview
         FROM   public_chat_sessions
         WHERE  id = $1`,
        [req.params.id]
      );
      if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

      const { rows: messages } = await db.query(
        `SELECT id, role, content, created_at
         FROM   public_chat_messages
         WHERE  session_id = $1
         ORDER  BY created_at ASC`,
        [req.params.id]
      );

      return res.json({ ok: true, session, messages });
    } catch (err) {
      console.error('[admin/chat] get session error:', err.message);
      return res.status(500).json({ ok: false, error: 'Failed to load session' });
    }
  }
);

// ── POST /api/admin/chat/sessions/:id/resolve ─────────────────────────────────
router.post(
  '/api/admin/chat/sessions/:id/resolve',
  requireAuth,
  requireRole(ROLES.SUPERADMIN),
  async (req, res) => {
    try {
      await db.query(
        `UPDATE public_chat_sessions SET resolved = TRUE WHERE id = $1`,
        [req.params.id]
      );
      return res.json({ ok: true });
    } catch (err) {
      console.error('[admin/chat] resolve error:', err.message);
      return res.status(500).json({ ok: false, error: 'Failed to resolve session' });
    }
  }
);

module.exports = router;
