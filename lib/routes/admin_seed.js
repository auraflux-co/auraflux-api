'use strict';
/**
 * Admin seeding endpoint (testing only)
 * POST /api/admin/seed/brands?secret=<ADMIN_SECRET>
 */

const router = require('express').Router();
const { createBrand, query } = require('../db/postgres');
const { requireAuth } = require('../auth');
const https = require('https');

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
// Only returns tokens belonging to brands owned by the authenticated customer.
router.get('/api/admin/brand-oauth-status', requireAuth, async (req, res) => {
  try {
    const customerId = req.auth?.userId || req.user?.id;
    if (!customerId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const result = await query(
      `SELECT t.brand_id, t.platform_handle, t.platform_user_id, t.updated_at AS connected_at
         FROM platform_oauth_tokens t
         JOIN brands b ON b.id = t.brand_id
        WHERE t.platform = 'youtube'
          AND b.account_id = $1
        ORDER BY t.updated_at DESC`,
      [customerId]
    );
    // Key by brand_id — most recent token per brand
    const byBrand = {};
    for (const row of result.rows) {
      if (!byBrand[row.brand_id]) {
        byBrand[row.brand_id] = {
          connected: true,
          handle: row.platform_handle,
          platformUserId: row.platform_user_id,
          connectedAt: row.connected_at,
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

// GET /api/admin/runpod-ping - Test RunPod API key validity via GraphQL whoami
router.get('/api/admin/runpod-ping', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.RUNPOD_API_KEY;
  if (!apiKey) {
    return res.json({ ok: false, error: 'RUNPOD_API_KEY not set' });
  }

  const body = JSON.stringify({ query: '{ myself { id email } }' });
  const options = {
    hostname: 'api.runpod.io',
    path: '/graphql',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Authorization: `Bearer ${apiKey}`,
    },
  };

  try {
    const result = await new Promise((resolve, reject) => {
      const req2 = https.request(options, (r) => {
        let data = '';
        r.on('data', (c) => { data += c; });
        r.on('end', () => {
          try { resolve({ status: r.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: r.statusCode, body: data }); }
        });
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    const ok = result.status === 200 && result.body?.data?.myself?.id;
    res.json({
      ok: !!ok,
      status: result.status,
      keyPrefix: `${apiKey.slice(0, 6)}...`,
      ...(ok ? { account: result.body.data.myself } : {}),
      ...(result.status !== 200 ? { error: result.body } : {}),
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

module.exports = router;
