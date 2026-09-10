'use strict';
/**
 * API invite gate + /v1 Peaks wrappers
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const { isApiAccessApproved, requireApiInviteApproved } = require('../lib/auth/api_invite');

test('isApiAccessApproved: approved + superadmin', () => {
  assert.equal(isApiAccessApproved({ apiAccess: 'approved' }), true);
  assert.equal(isApiAccessApproved({ apiAccess: 'Approved' }), true);
  assert.equal(isApiAccessApproved({ role: 'superadmin' }), true);
  assert.equal(isApiAccessApproved({ apiAccess: null }), false);
  assert.equal(isApiAccessApproved({ apiAccess: 'pending' }), false);
  assert.equal(isApiAccessApproved(null), false);
});

test('requireApiInviteApproved returns 403 api_invite_required', async () => {
  const app = express();
  app.post('/keys', (req, _res, next) => {
    req.user = { id: 'u1', planTier: 'operate', apiAccess: null };
    next();
  }, requireApiInviteApproved, (_req, res) => res.json({ ok: true }));

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/keys`, { method: 'POST' });
  const body = await res.json();
  assert.equal(res.status, 403);
  assert.equal(body.error, 'api_invite_required');
  server.close();
});

test('requireApiInviteApproved allows approved users', async () => {
  const app = express();
  app.post('/keys', (req, _res, next) => {
    req.user = { id: 'u1', planTier: 'operate', apiAccess: 'approved' };
    next();
  }, requireApiInviteApproved, (_req, res) => res.json({ ok: true }));

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/keys`, { method: 'POST' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  server.close();
});

test('developer_peaks router mounts expected paths', () => {
  const peaks = require('../lib/routes/developer_peaks');
  const paths = [];
  peaks.stack.forEach((layer) => {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
      paths.push(`${methods.join(',').toUpperCase()} ${layer.route.path}`);
    }
  });
  assert.ok(paths.some((p) => p.includes('/peaks/vods')));
  assert.ok(paths.some((p) => p.includes('/peaks/analyze')));
  assert.ok(paths.some((p) => p.includes('/peaks/sessions/:id/segments')));
  assert.ok(paths.some((p) => p.includes('/peaks/stage')));
  assert.ok(paths.some((p) => p.includes('/peaks/kick')));
  assert.ok(paths.some((p) => p.includes('/peaks/twitch-ccv')));
  assert.ok(paths.some((p) => p.includes('/peaks/presets')));
});

test('listComposePresets returns C1–C11 keys', () => {
  const { listComposePresets } = require('../lib/routes/content_library');
  const presets = listComposePresets();
  const keys = presets.map((p) => p.key);
  assert.ok(keys.includes('fableflow_speed'));
  assert.ok(keys.includes('classic_blur_pad'));
  assert.ok(presets.some((p) => p.code === 'C9'));
  assert.ok(presets.length >= 11);
});
