#!/usr/bin/env node
'use strict';
/**
 * Reddit OAuth setup — print steps and optionally test credentials.
 *
 * Web app (recommended):
 *   1. Create app at https://www.reddit.com/prefs/apps → type "web app"
 *   2. Redirect URI: http://localhost:3000/reddit/oauth/callback
 *   3. Set REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET in .env
 *   4. pm2 running → open http://localhost:3000/reddit/oauth/authorize
 *   5. Copy REDDIT_REFRESH_TOKEN from callback page → set REDDIT_USE_PULLPUSH=0
 *
 * Script app (fallback — own account only):
 *   Set REDDIT_USERNAME + REDDIT_PASSWORD + CLIENT_ID/SECRET, REDDIT_USE_PULLPUSH=0
 *
 * Usage:
 *   node scripts/reddit_oauth_setup.js
 *   node scripts/reddit_oauth_setup.js --test
 */

require('dotenv').config();

const RedditClient = require('../lib/clients/reddit_client');

const REDIRECT = process.env.REDDIT_REDIRECT_URI || 'http://localhost:3000/reddit/oauth/callback';

function main() {
  const status = RedditClient.configStatus();
  console.log('\n=== Reddit desk auth status ===');
  console.log(JSON.stringify(status, null, 2));

  if (!process.env.REDDIT_CLIENT_ID) {
    console.log('\n1. Create app: https://www.reddit.com/prefs/apps');
    console.log('   Type: web app (or script for password grant on your account)');
    console.log('   Redirect URI (web app):', REDIRECT);
    console.log('2. Add to ~/cwn-c0/.env:');
    console.log('   REDDIT_CLIENT_ID=...');
    console.log('   REDDIT_CLIENT_SECRET=...');
    console.log('   REDDIT_USER_AGENT=ClipzWorldNews:c0-reddit-desk:v1.0 (by /u/YOUR_USERNAME)');
    console.log('3. Web app: visit http://localhost:3000/reddit/oauth/authorize');
    console.log('   Script app: set REDDIT_USERNAME + REDDIT_PASSWORD, then --test');
    return;
  }

  if (status.mode === 'pullpush') {
    console.log('\nPullPush mode active (REDDIT_USE_PULLPUSH=1 or missing refresh/password).');
    console.log('After OAuth: set REDDIT_USE_PULLPUSH=0 and redeploy.');
  }

  console.log('\nOAuth URL (auraflux must be running on :3000):');
  console.log('  http://localhost:3000/reddit/oauth/authorize');
  console.log('\nStatus probe:');
  console.log('  curl -s http://localhost:3000/reddit/status | python3 -m json.tool');

  if (process.argv.includes('--test')) {
    testFetch().catch((e) => {
      console.error('\nTest FAILED:', e.message);
      process.exit(1);
    });
  }
}

async function testFetch() {
  console.log('\nTesting /r/PublicFreakout top (OAuth if configured)…');
  const client = new RedditClient({ usePullpush: false });
  const t0 = Date.now();
  const raw = await client.listSubreddit('PublicFreakout', { sort: 'top', window: '24h', limit: 10 });
  const picks = client.filterVideoCandidates(raw, { minScore: 100 });
  console.log(`  ${picks.length} video posts in ${((Date.now() - t0) / 1000).toFixed(1)}s (source: ${client.usePullpush ? 'pullpush' : 'oauth'})`);
  if (picks[0]) {
    console.log(`  Sample: ${picks[0].id} | ${picks[0].score} | ${picks[0].title.slice(0, 60)}…`);
  }
}

main();
