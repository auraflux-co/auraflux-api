#!/usr/bin/env node
'use strict';
/**
 * Reddit → BTL desk spike — fetch video posts + OP + comments (no manual paste).
 *
 * Usage:
 *   node scripts/reddit_btl_spike.js
 *   node scripts/reddit_btl_spike.js PublicFreakout InstantKarma videos
 *   node scripts/reddit_btl_spike.js --post abc123
 *
 * Requires .env: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, and either
 * REDDIT_REFRESH_TOKEN or REDDIT_USERNAME + REDDIT_PASSWORD
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const RedditClient = require('../lib/clients/reddit_client');

const DEFAULT_SUBS = ['PublicFreakout', 'InstantKarma', 'Whatcouldgowrong', 'videos'];
const OUT_DIR = path.join(__dirname, '..', 'logs');

async function main() {
  const args = process.argv.slice(2);
  const postFlag = args.indexOf('--post');
  const client = new RedditClient();

  if (postFlag >= 0 && args[postFlag + 1]) {
    const postId = args[postFlag + 1];
    console.log(`[reddit_spike] Fetching post ${postId} + comments…`);
    const bundle = await client.buildPostBundle(postId, { commentLimit: 50 });
    writeOut(`reddit_post_${postId}.json`, bundle);
    printBundle(bundle);
    return;
  }

  const subs = args.filter((a) => !a.startsWith('--'));
  const subreddits = subs.length ? subs : DEFAULT_SUBS;
  const all = [];

  for (const sub of subreddits) {
    console.log(`[reddit_spike] /r/${sub}/top?t=week …`);
    try {
      let raw = await client.listSubreddit(sub, { sort: 'top', t: 'week', limit: 25 });
      if (!raw.length) {
        raw = await client.listSubreddit(sub, { sort: 'top', t: 'month', limit: 25 });
      }
      const picks = client.filterVideoCandidates(raw, { minScore: 500 });
      console.log(`  → ${picks.length} video candidates (score ≥ 500)`);
      for (const p of picks.slice(0, 3)) {
        try {
          const bundle = await client.buildPostBundle(p.id, { commentLimit: 30 });
          all.push(bundle);
          console.log(`  ✓ ${p.id} | ${p.score} | ${p.title.slice(0, 60)}…`);
        } catch (e) {
          console.warn(`  ✗ comments for ${p.id}: ${e.message}`);
          all.push({ ...p, topComments: [], commentError: e.message });
        }
        await sleep(700);
      }
    } catch (e) {
      console.warn(`  ✗ /r/${sub}: ${e.message}`);
    }
    await sleep(700);
  }

  writeOut('reddit_btl_candidates.json', { fetchedAt: new Date().toISOString(), posts: all });
  console.log(`\n[reddit_spike] ${all.length} bundles → logs/reddit_btl_candidates.json`);
  if (all[0]) {
    console.log('\n--- First candidate (for script test) ---');
    printBundle(all[0]);
  }
}

function writeOut(name, data) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const fp = path.join(OUT_DIR, name);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
  console.log(`[reddit_spike] wrote ${fp}`);
}

function printBundle(b) {
  console.log(`Title: ${b.title}`);
  console.log(`Sub: r/${b.subreddit} | Score: ${b.score} | Comments: ${b.numComments}`);
  console.log(`Video: ${b.videoUrl || b.url}`);
  if (b.selftext) console.log(`OP: ${b.selftext.slice(0, 200)}${b.selftext.length > 200 ? '…' : ''}`);
  console.log(`Top comments (${(b.topComments || []).length}):`);
  for (const c of (b.topComments || []).slice(0, 5)) {
    console.log(`  [${c.score}] u/${c.author}: ${c.body.slice(0, 120).replace(/\n/g, ' ')}…`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error('[reddit_spike] FAILED:', e.message);
  process.exit(1);
});
