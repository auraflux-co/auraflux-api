'use strict';
/**
 * lib/routes/app_content.js — CPD-490: App CMS API routes
 *
 * Routes:
 *   GET  /api/admin/app-content          — all overrides (public, 5-min cache)
 *   GET  /api/admin/app-content/:page    — overrides for one page key
 *   POST /api/admin/app-content          — upsert an override (superadmin only)
 *   DELETE /api/admin/app-content/:page/:key — reset to default (superadmin only)
 */

const router = require('express').Router();
const { requireAuth, requireRole, ROLES } = require('../auth');
const { query } = require('../db/postgres');

const auth       = [requireAuth, requireRole({ minLevel: ROLES.CUSTOMER })];
const superAdmin = [requireAuth, requireRole({ minLevel: ROLES.SUPERADMIN })];

// Simple in-process cache — invalidated on write
let _cache     = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 min

function _invalidate() { _cache = null; _cacheTime = 0; }

// ── GET /api/admin/app-content ────────────────────────────────────────────────
// Returns all overrides as { [page_key]: { [key]: value } }
// Cached 5 min — used by Next.js app at runtime to override JSON defaults.

router.get('/api/admin/app-content', async (req, res) => {
  try {
    if (_cache && Date.now() - _cacheTime < CACHE_TTL) {
      return res.json({ ok: true, content: _cache, cached: true });
    }
    const rows = await query('SELECT page_key, key, value FROM app_content ORDER BY page_key, key');
    const content = {};
    for (const row of rows.rows) {
      if (!content[row.page_key]) content[row.page_key] = {};
      content[row.page_key][row.key] = row.value;
    }
    _cache = content;
    _cacheTime = Date.now();
    return res.json({ ok: true, content });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/admin/app-content/:page ─────────────────────────────────────────
router.get('/api/admin/app-content/:page', async (req, res) => {
  try {
    const rows = await query(
      'SELECT key, value, updated_by, updated_at FROM app_content WHERE page_key = $1 ORDER BY key',
      [req.params.page],
    );
    return res.json({ ok: true, page: req.params.page, overrides: rows.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/admin/app-content ───────────────────────────────────────────────
// Body: { page_key, key, value }
router.post('/api/admin/app-content', superAdmin, async (req, res) => {
  const { page_key, key, value } = req.body || {};
  if (!page_key || !key || value === undefined) {
    return res.status(400).json({ ok: false, error: 'page_key, key, and value are required' });
  }
  try {
    await query(
      `INSERT INTO app_content (page_key, key, value, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (page_key, key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [page_key, key, String(value), req.user?.id || 'superadmin'],
    );
    _invalidate();
    return res.json({ ok: true, page_key, key, value });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── DELETE /api/admin/app-content/:page/:key ──────────────────────────────────
// Resets a key back to its JSON default by removing the DB override.
router.delete('/api/admin/app-content/:page/:key', superAdmin, async (req, res) => {
  try {
    await query(
      'DELETE FROM app_content WHERE page_key = $1 AND key = $2',
      [req.params.page, req.params.key],
    );
    _invalidate();
    return res.json({ ok: true, reset: true, page: req.params.page, key: req.params.key });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
