'use strict';
/**
 * Admin seeding endpoint (testing only)
 * POST /api/admin/seed/brands?secret=<ADMIN_SECRET>
 */

const router = require('express').Router();
const { createBrand, query } = require('../db/postgres');

const BRAND_NAMES = [
  'natashaughey',
  'martinezofwonkru',
  'thevarietygurl',
  'millkberry',
  'lettucek',
  'fuzzyness',
  'hana',
  'wanderbot',
  'somarcus',
  'rockleesmile',
  'clintus',
  'ninuschk',
  'alluux',
  'patterrz',
  'supermcgamer',
  't10nat',
  'guhrl',
  'tenshi',
  'bogur',
  'nixstah',
];

router.post('/api/admin/seed/brands', async (req, res) => {
  const secret = req.query.secret || req.body?.secret;
  const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change_me';
  
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  
  const accountId = req.query.account_id || req.body?.account_id;
  if (!accountId) {
    return res.status(400).json({ ok: false, error: 'account_id required' });
  }
  
  const created = [];
  const errors = [];
  
  for (const name of BRAND_NAMES) {
    try {
      const brand = await createBrand(accountId, name);
      created.push({ id: brand.id, name: brand.name });
    } catch (err) {
      errors.push({ name, error: err.message });
    }
  }
  
  res.json({
    ok: true,
    created: created.length,
    failed: errors.length,
    brands: created,
    ...(errors.length > 0 && { errors }),
  });
});

// POST /api/admin/reassign-brands - Reassign brands to correct account
router.post('/api/admin/reassign-brands', async (req, res) => {
  const secret = req.query.secret || req.body.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const OLD_ACCOUNT_ID = 'user_2kxLZH7ckSLZH3d6dCK3hVVqvHs';
  const NEW_ACCOUNT_ID = 'user_3DeZESHSt4pqQtkDuYJoGDicm2q'; // robert@auraflux.co

  try {
    const result = await query(
      `UPDATE brands 
       SET account_id = $1 
       WHERE account_id = $2 
       RETURNING id, name`,
      [NEW_ACCOUNT_ID, OLD_ACCOUNT_ID]
    );

    res.json({
      ok: true,
      updated: result.rows.length,
      brands: result.rows.map(r => r.name)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/brand-oauth-status - Return YouTube connection status for all brands
router.get('/api/admin/brand-oauth-status', async (req, res) => {
  try {
    const result = await query(
      `SELECT brand_id, platform_handle, platform_user_id, created_at
       FROM platform_oauth_tokens
       WHERE platform = 'youtube'
       ORDER BY created_at DESC`
    );
    // Key by brand_id — most recent token per brand
    const byBrand = {};
    for (const row of result.rows) {
      if (!byBrand[row.brand_id]) {
        byBrand[row.brand_id] = {
          connected: true,
          handle: row.platform_handle,
          platformUserId: row.platform_user_id,
          connectedAt: row.created_at,
        };
      }
    }
    res.json({ ok: true, brands: byBrand });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/debug-env - Check YouTube env vars for trailing spaces
router.get('/api/admin/debug-env', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const clientId = process.env.YOUTUBE_CLIENT_ID || '';
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET || '';

  res.json({
    ok: true,
    clientId: {
      value: clientId,
      length: clientId.length,
      hasTrailingSpace: clientId !== clientId.trim(),
      repr: JSON.stringify(clientId)
    },
    clientSecret: {
      length: clientSecret.length,
      hasTrailingSpace: clientSecret !== clientSecret.trim(),
      firstChars: clientSecret.substring(0, 10),
      lastChars: clientSecret.substring(clientSecret.length - 10)
    }
  });
});

module.exports = router;
