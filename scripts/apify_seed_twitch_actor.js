'use strict';
/**
 * apify_seed_twitch_actor.js — CPD-1224
 *
 * Fires one run of our published Twitch Clips Scraper Actor against the current
 * roster. Purpose is Store ranking: Apify's discovery algorithm weights total
 * run count + success rate, and brand-new actors start cold. A small daily run
 * seeds that signal with real, useful output (and the dataset is a live sample
 * for the Store listing).
 *
 * This does NOT touch the production clip path — the pipeline still fetches
 * clips via the Helix API in twitch_clips_fetch.js. This is purely the actor's
 * own on-platform run.
 *
 * Env:
 *   APIFY_API_TOKEN            — required (already used by kick/reddit adapters)
 *   APIFY_TWITCH_ACTOR_ID      — actor id (default: our published actor)
 *   APIFY_ACTOR_SEED_ENABLED   — must be '1' to actually fire (default off)
 *   APIFY_ACTOR_SEED_PERIOD    — 24h | 7d | 30d | all (default 7d)
 *   APIFY_ACTOR_SEED_MAX       — max clips per streamer (default 20)
 *
 * Run manually:  node scripts/apify_seed_twitch_actor.js --force
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const ACTOR_ID = process.env.APIFY_TWITCH_ACTOR_ID || 'Gi3czdW3XmyYHN6kb';
const APIFY_BASE = 'https://api.apify.com/v2';
const LOG_PATH = path.join(__dirname, '..', 'logs', 'apify_actor_seed.jsonl');

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch { /* logs dir optional */ }
  console.log('[apify-seed]', line);
}

function rosterLogins() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'streamers.json'), 'utf8');
  const roster = (JSON.parse(raw).roster) || [];
  return roster
    .filter((s) => s && s.active && s.twitchUsername)
    .map((s) => String(s.twitchUsername).toLowerCase());
}

async function main() {
  const force = process.argv.includes('--force');
  const enabled = process.env.APIFY_ACTOR_SEED_ENABLED === '1' || force;
  if (!enabled) {
    log({ skipped: 'APIFY_ACTOR_SEED_ENABLED != 1 (pass --force to override)' });
    return;
  }

  const token = process.env.APIFY_API_TOKEN;
  if (!token) { log({ error: 'APIFY_API_TOKEN not set' }); process.exitCode = 1; return; }

  const streamers = rosterLogins();
  if (!streamers.length) { log({ error: 'no active roster streamers' }); process.exitCode = 1; return; }

  const input = {
    streamers,
    period: process.env.APIFY_ACTOR_SEED_PERIOD || '7d',
    sort: 'views',
    maxClipsPerStreamer: Number(process.env.APIFY_ACTOR_SEED_MAX || 20),
    minDurationSeconds: 5,
  };

  // Fire-and-forget async run — registers a run (ranking signal) and produces a
  // fresh dataset sample. We don't block on completion.
  const url = `${APIFY_BASE}/acts/${ACTOR_ID}/runs?token=${encodeURIComponent(token)}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    log({ error: `run request failed: ${e.message}`, streamers: streamers.length });
    process.exitCode = 1;
    return;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log({ error: `apify ${res.status}: ${text.slice(0, 200)}`, streamers: streamers.length });
    process.exitCode = 1;
    return;
  }

  const body = await res.json();
  const run = body.data || {};
  log({
    ok: true,
    actorId: ACTOR_ID,
    runId: run.id,
    status: run.status,
    streamers: streamers.length,
    period: input.period,
    consoleUrl: run.id ? `https://console.apify.com/actors/${ACTOR_ID}/runs/${run.id}` : null,
  });
}

main().catch((e) => { log({ error: `unhandled: ${e.message}` }); process.exitCode = 1; });
