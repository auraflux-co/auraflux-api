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

module.exports = router;
