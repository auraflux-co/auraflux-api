#!/usr/bin/env node
/**
 * HeyGen Poller — standalone process / Docker container
 *
 * Polls HeyGen video status for a single job, writes completed URLs back to
 * data/jobs.json, then POSTs to the CWN server's internal handoff endpoint
 * to trigger Gate 2 QA + assembly. No shared in-process state required.
 *
 * Usage:
 *   node bin/heygen-poller.js <jobId>
 *   or via Docker wrapper: bin/heygen-poller-docker <jobId>
 *
 * Environment:
 *   HEYGEN_API_KEY      — required
 *   CWN_SERVER_URL      — default http://localhost:3000
 *   JOBS_FILE           — default ./data/jobs.json
 *   POLL_INTERVAL_MS    — default 30000 (30s)
 *   MAX_POLL_MINUTES    — default 60
 */

'use strict';

require('dotenv').config();
// New Relic: load agent before other requires when license is set (Docker poller gets its own app name).
if (process.env.NEW_RELIC_LICENSE_KEY && !/^REPLACE/i.test(String(process.env.NEW_RELIC_LICENSE_KEY))) {
  process.env.NR_PIPELINE_SERVICE = process.env.NR_PIPELINE_SERVICE || 'auraflux-heygen-poller-docker';
  process.env.NEW_RELIC_APP_NAME = process.env.NEW_RELIC_APP_NAME || 'AuraFlux-HeyGenPoller';
  require('newrelic');
}
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const { nrPipelineEvent } = require(path.join(__dirname, '..', 'lib', 'nr_pipeline'));

// ── Config ───────────────────────────────────────────────────────────────────

const jobId            = process.argv[2];
const HEYGEN_API_KEY   = process.env.HEYGEN_API_KEY;
const CWN_SERVER_URL   = (process.env.CWN_SERVER_URL || 'http://localhost:3000').replace(/\/$/, '');
const JOBS_FILE        = process.env.JOBS_FILE || path.join(__dirname, '..', 'data', 'jobs.json');
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const MAX_POLL_MINUTES = parseInt(process.env.MAX_POLL_MINUTES || '60',    10);
const MAX_POLLS        = Math.floor((MAX_POLL_MINUTES * 60 * 1000) / POLL_INTERVAL_MS);

if (!jobId)          { console.error('[poller] Usage: heygen-poller.js <jobId>'); process.exit(1); }
if (!HEYGEN_API_KEY) { console.error('[poller] HEYGEN_API_KEY not set'); process.exit(1); }

// ── Job card helpers ─────────────────────────────────────────────────────────

function readCard() {
  const jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  return jobs[jobId] || null;
}

function writeCard(card) {
  const jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  jobs[jobId] = { ...card, savedAt: new Date().toISOString() };
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

// ── Build segmentData — mirrors server.js startHeyGenPoller ─────────────────

function buildSegmentData(card, sortedAvatarSegs) {
  const orderedClipUrls = card.orderedClipUrls || [];
  const segmentData     = [];
  let clipIdx           = 0;

  for (const avatarSeg of sortedAvatarSegs) {
    const seg = {
      url:   avatarSeg.video_url,
      label: avatarSeg.sceneName,
      type:  'avatar'
    };

    // Attach cardData for News STORY#_INTRO segments (chrome overlay)
    if ((card.contentType || 'twitch') === 'news' && /STORY(\d+)_INTRO/i.test(avatarSeg.sceneName)) {
      const storyMatch = avatarSeg.sceneName.match(/STORY(\d+)_INTRO/i);
      const storyIdx   = storyMatch ? parseInt(storyMatch[1], 10) - 1 : -1;
      const storyItem  = (card.newsItems || [])[storyIdx];
      if (storyItem) {
        seg.cardData = {
          title:        storyItem.title    || `Story ${storyIdx + 1}`,
          category:     storyItem.category || 'WORLD NEWS',
          storyId:      `story_${storyIdx + 1}`,
          imageUrl:     storyItem.thumbnailUrl || storyItem.imageUrl || null,
          heroImageUrl: storyItem.heroImageUrl || storyItem.thumbnailUrl || null,
          source:       storyItem.source || ''
        };
      }
    }

    segmentData.push(seg);

    // Insert source clip after SETUP (Twitch/News) or NARRATION (NBA) scenes
    const isClipTrigger = /SETUP/i.test(avatarSeg.sceneName) || /NARRATION/i.test(avatarSeg.sceneName);
    if (isClipTrigger && clipIdx < orderedClipUrls.length) {
      const clip = orderedClipUrls[clipIdx];
      clipIdx++;
      if (clip && (clip.url || clip.clipUrl)) {
        segmentData.push({
          url:     clip.clipUrl || clip.url || '',
          pageUrl: clip.pageUrl || '',
          label:   clip.label   || `CLIP_${clipIdx}`,
          type:    'source_clip',
          clipUrl: clip.clipUrl || clip.url || ''
        });
      } else {
        console.log(`[poller:${jobId}] null clip at index ${clipIdx - 1} — skipping`);
      }
    }
  }

  console.log(`[poller:${jobId}] Built segmentData: ${segmentData.length} entries (${sortedAvatarSegs.length} avatar + ${clipIdx} source_clips)`);
  return segmentData;
}

// ── Poll loop ────────────────────────────────────────────────────────────────

async function poll(videoJobs, pollCount) {
  if (pollCount > MAX_POLLS) {
    console.error(`[poller:${jobId}] ⏰ Timeout after ${MAX_POLL_MINUTES}min — giving up. POST /job/${jobId}/resubmit-heygen to retry.`);
    nrPipelineEvent('HeyGenDockerPollTimeout', {
      jobId,
      pollCount,
      maxPolls: MAX_POLLS,
      segmentCount: videoJobs.length
    });
    process.exit(1);
  }

  // Check all video IDs in parallel
  const statuses = await Promise.all(videoJobs.map(async (job) => {
    try {
      const resp = await axios.get(
        `https://api.heygen.com/v1/video_status.get?video_id=${job.video_id}`,
        { headers: { 'X-Api-Key': HEYGEN_API_KEY }, timeout: 10000 }
      );
      const data = resp.data?.data || {};
      return { video_id: job.video_id, sceneName: job.sceneName, sceneIndex: job.sceneIndex, status: data.status, video_url: data.video_url || null };
    } catch (e) {
      return { video_id: job.video_id, sceneName: job.sceneName, sceneIndex: job.sceneIndex, status: 'error', video_url: null };
    }
  }));

  const completed = statuses.filter(s => s.status === 'completed' && s.video_url);
  const failed    = statuses.filter(s => s.status === 'failed');
  const pending   = statuses.filter(s => s.status !== 'completed');

  console.log(`[poller:${jobId}] Poll ${pollCount}: ${completed.length}/${videoJobs.length} completed, ${pending.length} pending, ${failed.length} failed`);
  nrPipelineEvent('HeyGenDockerPollTick', {
    jobId,
    pollCount,
    completed: completed.length,
    pending: pending.length,
    failed: failed.length,
    total: videoJobs.length
  });

  // Write failed statuses back to card so resubmit guard can see terminal state
  if (failed.length > 0) {
    console.error(`[poller:${jobId}] ❌ ${failed.length} failed: ${failed.map(f => f.sceneName).join(', ')}`);
    try {
      const card = readCard();
      if (card?.heygen?.videoJobs) {
        failed.forEach(f => {
          const vj = card.heygen.videoJobs.find(v => v.video_id === f.video_id);
          if (vj) vj.status = 'failed';
        });
        writeCard(card);
      }
    } catch (e) {
      console.warn(`[poller:${jobId}] Could not write failed status: ${e.message}`);
    }

    // All terminal, none completed — stop now, don't block shutdown
    const TERMINAL = new Set(['completed', 'failed', 'error']);
    if (statuses.every(s => TERMINAL.has(s.status)) && completed.length === 0) {
      console.warn(`[poller:${jobId}] All segments terminal, 0 completed — stopping. POST /job/${jobId}/resubmit-heygen to retry.`);
      nrPipelineEvent('HeyGenDockerPollAllFailed', { jobId, pollCount });
      process.exit(2); // exit 2 = all-failed, distinct from timeout (1) and success (0)
    }
  }

  if (completed.length < videoJobs.length) {
    setTimeout(() => poll(videoJobs, pollCount + 1), POLL_INTERVAL_MS);
    return;
  }

  // ── All complete ─────────────────────────────────────────────────────────
  console.log(`[poller:${jobId}] ✅ All ${videoJobs.length} segments completed — building handoff`);

  const sortedAvatarSegs = [...completed].sort((a, b) => a.sceneIndex - b.sceneIndex);
  const card = readCard();
  nrPipelineEvent('HeyGenDockerSegmentsReady', {
    jobId,
    segmentCount: videoJobs.length,
    pollCount,
    contentType: card.contentType || 'twitch'
  });

  // Persist completed URLs to card
  card.heygen.videoJobs = statuses.map(s => ({
    ...(videoJobs.find(j => j.video_id === s.video_id) || {}),
    status:    s.status,
    video_url: s.video_url
  }));
  card.stage = 'all_sent';
  writeCard(card);

  const segmentData  = buildSegmentData(card, sortedAvatarSegs);
  const segmentUrls  = sortedAvatarSegs.map(s => s.video_url).filter(Boolean);
  const contentType  = card.contentType || 'twitch';

  // ── Handoff to server — triggers Gate 2 + assembly ──────────────────────
  try {
    await axios.post(
      `${CWN_SERVER_URL}/internal/heygen-complete`,
      { jobId, contentType, segmentUrls, segmentData },
      { timeout: 15000 }
    );
    console.log(`[poller:${jobId}] 📡 Handoff sent to ${CWN_SERVER_URL}/internal/heygen-complete — pipeline continues`);
    nrPipelineEvent('HeyGenDockerHandoffOk', { jobId, segmentCount: videoJobs.length });
    process.exit(0);
  } catch (e) {
    console.error(`[poller:${jobId}] Handoff POST failed: ${e.message}`);
    nrPipelineEvent('HeyGenDockerHandoffFail', { jobId, error: (e.message || '').slice(0, 500) });
    // Card is already saved with completed URLs — server can re-trigger from startup resume
    process.exit(3); // exit 3 = completed but handoff failed
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const card = readCard();
  if (!card) { console.error(`[poller] Job not found: ${jobId}`); process.exit(1); }

  const videoJobs = card.heygen?.videoJobs || [];
  if (!videoJobs.length) { console.error(`[poller] No videoJobs on card: ${jobId}`); process.exit(1); }

  console.log(`[poller:${jobId}] 🔄 Starting — ${videoJobs.length} segments, polling every ${POLL_INTERVAL_MS / 1000}s (max ${MAX_POLL_MINUTES}min)`);
  console.log(`[poller:${jobId}] Server handoff: ${CWN_SERVER_URL}/internal/heygen-complete`);
  nrPipelineEvent('HeyGenDockerPollStart', {
    jobId,
    segmentCount: videoJobs.length,
    pollIntervalMs: POLL_INTERVAL_MS,
    maxPollMinutes: MAX_POLL_MINUTES,
    contentType: card.contentType || 'twitch'
  });

  // First poll after 30s — give HeyGen time to begin processing
  setTimeout(() => poll(videoJobs, 1), POLL_INTERVAL_MS);
}

// Graceful shutdown — log and exit cleanly on SIGTERM (Docker stop)
process.on('SIGTERM', () => {
  console.log(`[poller:${jobId}] SIGTERM received — exiting cleanly (card already checkpointed)`);
  process.exit(0);
});

main().catch(e => {
  console.error(`[poller] Fatal: ${e.message}`);
  process.exit(1);
});
