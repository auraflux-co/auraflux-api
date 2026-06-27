#!/usr/bin/env node
'use strict';
/**
 * Reddit OAuth setup — print steps and optionally test credentials.
 *
 * RECOMMENDED — Script app (Reddit often rejects localhost:3000 redirect URLs):
 *   1. https://www.reddit.com/prefs/apps → "script" (personal use / your account)
 *   2. Redirect URI: http://localhost:8080  ← Reddit requires a value; script apps ignore it
 *   3. .env: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD
 *   4. REDDIT_USE_PULLPUSH=0 → deploy → curl http://localhost:3000/reddit/oauth/script-test
 *
 * Web app (refresh token — only if Reddit accepts your redirect URL):
 *   Redirect must match REDDIT_REDIRECT_URI exactly. Try:
 *   - http://127.0.0.1:3000/reddit/oauth/callback
 *   - http://localhost:8080/reddit/oauth/callback (+ set same in .env)
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

  console.log('\n── Script app (recommended) ──');
  console.log('1. reddit.com/prefs/apps → create → type: script');
  console.log('2. Redirect URI: http://localhost:8080  (dummy — not used for script apps)');
  console.log('3. .env: CLIENT_ID, CLIENT_SECRET, USERNAME, PASSWORD, REDDIT_USE_PULLPUSH=0');
  console.log('4. bash scripts/deploy_c0.sh');
  console.log('5. curl http://localhost:3000/reddit/oauth/script-test');

  console.log('\n── Web app (optional refresh token) ──');
  console.log('If Reddit rejects localhost:3000, try 127.0.0.1 or port 8080:');
  console.log('  REDDIT_REDIRECT_URI=' + REDIRECT);
  console.log('  Then: http://localhost:3000/reddit/oauth/authorize');

  if (!process.env.REDDIT_CLIENT_ID) {
    console.log('\n→ Add REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET from the app you created.');
    return;
  }

  if (status.mode === 'pullpush') {
    console.log('\nPullPush active — set REDDIT_USE_PULLPUSH=0 after credentials work.');
  }

  if (process.argv.includes('--test')) {
    testFetch().catch((e) => {
      console.error('\nTest FAILED:', e.message);
      process.exit(1);
    });
  }
}

async function testFetch() {
  console.log('\nTesting /r/PublicFreakout top (OAuth if USE_PULLPUSH=0)…');
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
