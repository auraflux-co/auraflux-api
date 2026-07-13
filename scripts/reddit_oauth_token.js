#!/usr/bin/env node
'use strict';
/**
 * One-time Reddit OAuth — prints refresh_token for .env
 *
 * 1. Create web app at reddit.com/prefs/apps — redirect http://localhost:8080
 * 2. Open the URL this script prints, approve, paste ?code= from redirect
 *
 *   node scripts/reddit_oauth_token.js
 *   node scripts/reddit_oauth_token.js YOUR_AUTH_CODE
 */

require('dotenv').config();

const https = require('https');
const readline = require('readline');

const CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
const REDIRECT = process.env.REDDIT_REDIRECT_URI || 'http://localhost:8080';
const UA = process.env.REDDIT_USER_AGENT || 'ClipzWorldNews:c0-reddit-desk:v1.0 (by /u/rgreggs78)';

function postToken(form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.reddit.com',
      path: '/api/v1/access_token',
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': UA,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env first');
    process.exit(1);
  }

  let code = process.argv[2];
  if (!code) {
    const state = Math.random().toString(36).slice(2);
    const url = `https://www.reddit.com/api/v1/authorize?client_id=${CLIENT_ID}&response_type=code&state=${state}&redirect_uri=${encodeURIComponent(REDIRECT)}&duration=permanent&scope=read`;
    console.log('\n1. Open this URL in a browser (logged in as your Reddit account):\n');
    console.log(url);
    console.log('\n2. After approve, copy the "code" query param from the redirect URL.\n');
    code = await new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('Paste code here: ', (answer) => { rl.close(); resolve(answer.trim()); });
    });
  }

  const tok = await postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
  });

  if (tok.error) {
    console.error('Token error:', tok.error, tok.error_description || '');
    process.exit(1);
  }

  console.log('\nAdd to .env:\n');
  console.log(`REDDIT_REFRESH_TOKEN=${tok.refresh_token}`);
  console.log('\n(access_token expires in', tok.expires_in, 'seconds — use refresh_token in production)\n');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
