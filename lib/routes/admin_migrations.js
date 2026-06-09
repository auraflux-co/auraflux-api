'use strict';
/**
 * lib/routes/admin_migrations.js — Run database migrations (SUPERADMIN only)
 * 
 * POST /api/admin/migrations/run/:version
 */

const fs = require('fs');
const path = require('path');
const router = require('express').Router();
const { requireAuth, requireRole, ROLES } = require('../auth');
const { query } = require('../db/postgres');

// POST /api/admin/migrations/run/:version
router.post('/api/admin/migrations/run/:version', requireAuth, requireRole(ROLES.SUPERADMIN), async (req, res) => {
  const { version } = req.params;
  
  const migrationFile = path.join(__dirname, '../../db/migrations', `${version}.sql`);
  
  if (!fs.existsSync(migrationFile)) {
    return res.status(404).json({ ok: false, error: `Migration file not found: ${version}` });
  }
  
  try {
    const sql = fs.readFileSync(migrationFile, 'utf8');
    await query(sql);
    
    res.json({
      ok: true,
      message: `Migration ${version} completed successfully`,
    });
  } catch (err) {
    console.error(`[admin-migrations] Failed to run ${version}:`, err);
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

// POST /api/admin/brand-profiles/seed
router.post('/api/admin/brand-profiles/seed', requireAuth, requireRole(ROLES.SUPERADMIN), async (req, res) => {
  const CUSTOMER_ID = req.auth.userId;
  
  const PROFILES = [
    { name: 'natashaughey', display: 'Natasha Hughey' },
    { name: 'martinezofwonkru', display: 'Martinez of Wonkru' },
    { name: 'thevarietygurl', display: 'The Variety Gurl' },
    { name: 'millkberry', display: 'Millkberry' },
    { name: 'lettucek', display: 'LettuceK' },
    { name: 'fuzzyness', display: 'Fuzzyness' },
    { name: 'hana', display: 'Hana' },
    { name: 'wanderbot', display: 'Wanderbot' },
    { name: 'somarcus', display: 'Somarcus' },
    { name: 'rockleesmile', display: 'RockLeeSmile' },
    { name: 'clintus', display: 'Clintus' },
    { name: 'ninuschk', display: 'Ninuschk' },
    { name: 'alluux', display: 'Alluux' },
    { name: 'patterrz', display: 'Patterrz' },
    { name: 'supermcgamer', display: 'SuperMCGamer' },
    { name: 't10nat', display: 'T10nat' },
    { name: 'guhrl', display: 'Guhrl' },
    { name: 'tenshi', display: 'Tenshi' },
    { name: 'bogur', display: 'Bogur' },
    { name: 'nixstah', display: 'Nixstah' },
  ];
  
  const created = [];
  const errors = [];
  
  for (let i = 0; i < PROFILES.length; i++) {
    const { name, display } = PROFILES[i];
    const isDefault = i === 0;
    
    try {
      const result = await query(
        `INSERT INTO brand_profiles (customer_id, profile_name, display_name, is_default, source_channels)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (customer_id, profile_name) DO UPDATE
         SET display_name = EXCLUDED.display_name, updated_at = NOW()
         RETURNING id, profile_name`,
        [CUSTOMER_ID, name, display, isDefault, JSON.stringify({ twitchLogin: name })]
      );
      created.push(result.rows[0]);
    } catch (err) {
      errors.push({ name, error: err.message });
    }
  }
  
  res.json({
    ok: true,
    created: created.length,
    errors: errors.length,
    profiles: created,
    ...(errors.length > 0 && { errors }),
  });
});

module.exports = router;
