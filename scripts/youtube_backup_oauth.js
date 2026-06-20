#!/usr/bin/env node
'use strict';
/**
 * One-time OAuth for YOUTUBE_BACKUP_* — prints refresh token and optionally sets Doppler.
 *
 * Prerequisite: add to backup OAuth client redirect URIs:
 *   http://127.0.0.1:8765/callback
 *
 * Usage:
 *   bash scripts/doppler_run.sh node scripts/youtube_backup_oauth.js --set-doppler
 *   bash scripts/doppler_run.sh node scripts/youtube_backup_oauth.js --exchange-playground-code '4/0...' --set-doppler
 *
 * Playground: gear → use your own OAuth credentials (backup client) → authorize → copy Step 1 code.
 */

require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const axios = require('axios');
const { execSync } = require('child_process');
const { getProfileConfig } = require('../lib/services/youtube_api_profiles');

const PORT = 8765;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;

function buildAuthUrl(clientId) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/youtube',
    ].join(' '),
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(code, cfg) {
  const res = await axios.post('https://oauth2.googleapis.com/token', {
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
  });
  return res.data;
}

const PLAYGROUND_REDIRECT = 'https://developers.google.com/oauthplayground';

async function exchangePlaygroundCode(code, cfg) {
  const res = await axios.post('https://oauth2.googleapis.com/token', {
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: PLAYGROUND_REDIRECT,
    grant_type: 'authorization_code',
  });
  return res.data;
}

async function storeRefreshToken(refreshToken, setDoppler) {
  if (!refreshToken) throw new Error('no refresh_token');
  const test = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: getProfileConfig('backup').clientId,
    client_secret: getProfileConfig('backup').clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (!test.data.access_token) throw new Error('refresh token invalid for backup client');
  console.log('Backup refresh token verified.');
  if (setDoppler && process.env.DOPPLER_TOKEN) {
    execSync(`doppler secrets set YOUTUBE_BACKUP_REFRESH_TOKEN="${refreshToken}" --project auraflux --config prd --silent`, {
      stdio: 'inherit',
      env: process.env,
    });
    console.log('Stored YOUTUBE_BACKUP_REFRESH_TOKEN in Doppler prd.');
  }
}

async function main() {
  const setDoppler = process.argv.includes('--set-doppler');
  const cfg = getProfileConfig('backup');
  if (!cfg.clientId || !cfg.clientSecret) {
    console.error('Set YOUTUBE_BACKUP_CLIENT_ID and YOUTUBE_BACKUP_CLIENT_SECRET in Doppler first.');
    process.exit(1);
  }

  const codeIdx = process.argv.indexOf('--exchange-playground-code');
  if (codeIdx !== -1) {
    const code = process.argv[codeIdx + 1];
    if (!code) {
      console.error('Usage: --exchange-playground-code \'4/0...\'');
      process.exit(1);
    }
    const tokens = await exchangePlaygroundCode(decodeURIComponent(code), cfg);
    await storeRefreshToken(tokens.refresh_token, setDoppler);
    return;
  }

  const authUrl = buildAuthUrl(cfg.clientId);
  console.log('\nOpen this URL in your browser (ClipzWorld Google account):\n');
  console.log(authUrl);
  console.log(`\nWaiting for callback on ${REDIRECT} …\n`);

  const refreshToken = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, REDIRECT);
        if (u.pathname !== '/callback') {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const err = u.searchParams.get('error');
        if (err) {
          res.writeHead(400);
          res.end(`OAuth error: ${err}`);
          reject(new Error(err));
          server.close();
          return;
        }
        const code = u.searchParams.get('code');
        if (!code) {
          res.writeHead(400);
          res.end('missing code');
          reject(new Error('missing code'));
          server.close();
          return;
        }
        const tokens = await exchangeCode(code, cfg);
        if (!tokens.refresh_token) {
          res.writeHead(400);
          res.end('No refresh_token — revoke app at myaccount.google.com/permissions and retry');
          reject(new Error('no refresh_token'));
          server.close();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Backup YouTube authorized</h2><p>You can close this tab.</p>');
        resolve(tokens.refresh_token);
        server.close();
      } catch (e) {
        res.writeHead(500);
        res.end(String(e.message));
        reject(e);
        server.close();
      }
    });
    server.listen(PORT, '127.0.0.1');
    setTimeout(() => {
      server.close();
      reject(new Error('timeout — open the URL and authorize within 5 minutes'));
    }, 5 * 60_000);
  });

  await storeRefreshToken(refreshToken, setDoppler);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
