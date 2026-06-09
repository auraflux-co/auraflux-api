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

module.exports = router;
