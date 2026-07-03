'use strict';
/**
 * main.js — Apify Actor entrypoint for the Twitch Clips Scraper.
 *
 * Monetization: pay-per-event via the default dataset-item event
 * (`apify-default-dataset-item`) — each clip pushed = one billable result.
 */

const { Actor, log } = require('apify');
const { fetchStreamerClips } = require('./twitch_gql');

const PER_STREAMER_DELAY_MS = 400;

async function run() {
  const input = (await Actor.getInput()) || {};
  const streamers = Array.isArray(input.streamers) ? input.streamers : [];
  if (!streamers.length) {
    throw new Error('Input "streamers" must be a non-empty array of Twitch logins or channel URLs.');
  }

  const opts = {
    period: input.period || '7d',
    sort: input.sort || 'views',
    limit: input.maxClipsPerStreamer || 25,
    minDurationSeconds: input.minDurationSeconds || 0,
    maxDurationSeconds: input.maxDurationSeconds || 0,
    minViews: input.minViews || 0,
  };

  let totalClips = 0;
  const misses = [];

  for (const streamer of streamers) {
    let result;
    try {
      result = await fetchStreamerClips(streamer, opts);
    } catch (e) {
      log.warning(`Fetch failed for "${streamer}": ${e.message}`);
      misses.push({ streamer: String(streamer), error: e.message });
      continue;
    }

    if (!result.found) {
      log.warning(`Skipping "${streamer}": ${result.error}`);
      misses.push({ streamer: result.streamer, error: result.error });
      continue;
    }

    if (result.clips.length) {
      await Actor.pushData(result.clips.map((c) => ({
        ...c,
        scrapedAt: new Date().toISOString(),
        period: opts.period,
        sort: opts.sort,
      })));
      totalClips += result.clips.length;
    }
    log.info(`${result.streamer}: ${result.clips.length} clips`);

    // Be polite to the unauthenticated endpoint.
    if (streamers.length > 1) {
      await new Promise((r) => setTimeout(r, PER_STREAMER_DELAY_MS));
    }
  }

  await Actor.setValue('RUN_SUMMARY', {
    streamersRequested: streamers.length,
    streamersFailed: misses,
    clipsPushed: totalClips,
    options: opts,
  });

  if (!totalClips && misses.length === streamers.length) {
    throw new Error(`No clips found — all ${streamers.length} streamer(s) failed: `
      + misses.map((m) => `${m.streamer} (${m.error})`).join(', '));
  }

  log.info(`Done — ${totalClips} clips across ${streamers.length - misses.length}/${streamers.length} streamers.`);
}

Actor.main(run);
