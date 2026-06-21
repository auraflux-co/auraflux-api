#!/usr/bin/env node
'use strict';
/**
 * Port 8765 — static assets only (ticker HTML, logos, tmp previews for assembly).
 *
 * **NOT the operator dashboard.** Use http://localhost:3000/ (cwn-c0 server.js).
 *
 * Dashboard paths redirect to :3000. Everything else serves ~/cwn-c0 static files.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const CANONICAL_DASHBOARD = process.env.CWN_DASHBOARD_URL || 'http://localhost:3000/';
const prodRoot = path.join(__dirname, '..');
const c0Root = process.env.C0_DASHBOARD_ROOT || path.join(os.homedir(), 'cwn-c0');
const staticRoot = fs.existsSync(path.join(c0Root, 'cwn_production.html')) ? c0Root : prodRoot;

const PORT = Number(process.env.BROADCAST_DASHBOARD_PORT || 8765);
const HOST = process.env.BROADCAST_DASHBOARD_HOST || '::';

const app = express();

const DASHBOARD_PATHS = ['/', '/cwn_production.html', '/broadcast'];
for (const p of DASHBOARD_PATHS) {
  app.get(p, (_req, res) => res.redirect(302, CANONICAL_DASHBOARD));
}

app.use(express.static(staticRoot));
app.use(express.static(prodRoot));

const server = app.listen(PORT, HOST, () => {
  console.log(`[static-8765] ticker/tools/assets — NOT the dashboard`);
  console.log(`[static-8765] dashboard → ${CANONICAL_DASHBOARD}`);
  console.log(`[static-8765] static root=${staticRoot}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[static-8765] Port ${PORT} in use — lsof -i :${PORT}`);
    process.exit(1);
  }
  throw err;
});
