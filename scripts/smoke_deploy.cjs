#!/usr/bin/env node
'use strict';
/**
 * Post-deploy smoke: GET /health (ok) + one lightweight route (default /disk-usage).
 *
 * Env:
 *   SMOKE_BASE_URL | SMOKE_API — base URL, default http://127.0.0.1:3000
 *   SMOKE_SECOND_PATH — second GET path, default /disk-usage
 */
const axios = require('axios');

const base = (process.env.SMOKE_BASE_URL || process.env.SMOKE_API || 'http://127.0.0.1:3000').replace(/\/$/, '');
const secondPath = process.env.SMOKE_SECOND_PATH || '/disk-usage';
const path2 = secondPath.startsWith('/') ? secondPath : `/${secondPath}`;

async function main() {
  const h = await axios.get(`${base}/health`, { timeout: 20000, validateStatus: () => true });
  if (h.status !== 200 || !h.data || h.data.ok !== true) {
    console.error('SMOKE_FAIL /health', h.status, h.data);
    process.exit(1);
  }

  const d = await axios.get(`${base}${path2}`, { timeout: 20000, validateStatus: () => true });
  if (d.status !== 200 || !d.data || d.data.ok !== true) {
    console.error('SMOKE_FAIL', path2, d.status, d.data);
    process.exit(1);
  }

  console.log('SMOKE_OK', base, '/health', path2);
}

main().catch((e) => {
  console.error('SMOKE_FAIL', e.message);
  process.exit(1);
});
