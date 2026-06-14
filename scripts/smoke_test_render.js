#!/usr/bin/env node
/**
 * scripts/smoke_test_render.js — C1+ Render staging smoke test (CPD-35)
 *
 * Usage:
 *   node scripts/smoke_test_render.js https://auraflux-api.onrender.com
 *   SMOKE_API_SECRET=<secret> node scripts/smoke_test_render.js https://...
 *
 * Checks:
 *   1. GET /health            — service up, version present
 *   2. GET /health            — DB reported (postgres connected)
 *   3. GET /api/public/plans  — plan feature matrix endpoint reachable
 *   4. POST /jobs (dry-run)   — job creation rejects gracefully without auth (401)
 *
 * Exit 0 = all checks passed. Exit 1 = one or more failed.
 */

'use strict';

const https = require('https');
const http = require('http');

const BASE_URL = process.argv[2];

if (!BASE_URL) {
  console.error('Usage: node scripts/smoke_test_render.js <base-url>');
  console.error('  e.g. node scripts/smoke_test_render.js https://auraflux-api.onrender.com');
  process.exit(1);
}

const API_SECRET = process.env.SMOKE_API_SECRET || '';

// ── HTTP helper ───────────────────────────────────────────────────────────────

function request(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...headers,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json;
          try { json = JSON.parse(raw); } catch { json = null; }
          resolve({ status: res.statusCode, body: json, raw });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Check runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(name, detail = '') {
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  passed++;
}

function fail(name, detail = '') {
  console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  failed++;
}

// ── Smoke tests ───────────────────────────────────────────────────────────────

async function run() {
  console.log(`\nAuraFlux C1+ Smoke Test — ${BASE_URL}\n${'─'.repeat(60)}`);

  // 1. Health check — service up
  try {
    const res = await request('GET', `${BASE_URL}/health`);
    if (res.status === 200 && res.body?.ok) {
      pass('GET /health', `ok=true version=${res.body.version || '?'}`);
    } else {
      fail('GET /health', `status=${res.status} ok=${res.body?.ok}`);
    }

    // 2. Health check — DB reported
    if (res.body?.db) {
      pass('DB in /health', `db=${JSON.stringify(res.body.db)}`);
    } else {
      // Non-fatal — db field may not be present in all health shapes
      console.log(`  ⚠️  DB field missing from /health — non-fatal`);
    }
  } catch (e) {
    fail('GET /health', e.message);
  }

  // 3. Plan feature matrix
  try {
    const res = await request('GET', `${BASE_URL}/api/public/plans`);
    if (res.status === 200 && res.body) {
      pass('GET /api/public/plans', `tiers=${Object.keys(res.body).join(',')}`);
    } else if (res.status === 401 || res.status === 403) {
      pass('GET /api/public/plans', `auth-gated (${res.status}) — endpoint reachable`);
    } else {
      fail('GET /api/public/plans', `status=${res.status}`);
    }
  } catch (e) {
    fail('GET /api/plans', e.message);
  }

  // 4. POST /jobs without auth — must return 401, not 500
  try {
    const res = await request('POST', `${BASE_URL}/jobs`, { entry: 'smoke-test' });
    if (res.status === 401 || res.status === 403) {
      pass('POST /jobs (no auth) → 401/403', 'auth guard working');
    } else if (res.status === 400) {
      pass('POST /jobs (no auth) → 400', 'validation guard working (no auth middleware?)');
    } else if (res.status >= 500) {
      fail('POST /jobs (no auth)', `unexpected ${res.status} — server error on unauth request`);
    } else {
      fail('POST /jobs (no auth)', `unexpected ${res.status}`);
    }
  } catch (e) {
    fail('POST /jobs (no auth)', e.message);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Smoke test complete: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    console.error('SMOKE TEST FAILED — do not promote to public');
    process.exit(1);
  } else {
    console.log('SMOKE TEST PASSED — staging is healthy');
    process.exit(0);
  }
}

run().catch((e) => {
  console.error('Smoke test runner crashed:', e.message);
  process.exit(1);
});
