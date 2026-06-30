'use strict';

// ── HeyGen Poller ─────────────────────────────────────────────────────────────
// Polls HeyGen until all segments complete, then emits heygen:all_complete.
// Also owns the startup resume logic that restarts in-flight pollers after a
// server crash or nodemon restart.

const path = require('path');
const axios = require('axios');

const { persistedJobs, saveJobCard, inferJobStage } = require('./job_card');
const { nrEvent } = require('./nr_events');
const pipelineBus = require('./pipeline_events');
const {
  shouldUseManualCheckpoint,
  useC0ImmediateManualHold,
  writeManualManifest,
  prefetchManualSourceClips,
  prepareC0ManualHoldAfterHeyGen,
} = require('./manual_segment_workflow');
const { sendScriptToHeyGen } = require('./script_gen');
const { saveHeyGenRender } = require('./db');

// ── Active poller registry ─────────────────────────────────────────────────────
// On SIGTERM we wait up to 35s for the current poll to finish so the job card
// is written to disk before exit. Startup resume picks up exactly where we left off.
const activePollers = new Map(); // jobId → { jobId, resolve, done }

function registerPoller(jobId) {
  let resolve;
  const done = new Promise((r) => {
    resolve = r;
  });
  activePollers.set(jobId, { jobId, resolve, done });
  return resolve; // caller calls resolve() when the poller exits cleanly
}

function unregisterPoller(jobId) {
  const entry = activePollers.get(jobId);
  if (entry) {
    entry.resolve();
    activePollers.delete(jobId);
  }
}

// ── startHeyGenPoller() ────────────────────────────────────────────────────────
// Auto-poll HeyGen until all segments complete, then auto-assemble.
// Implements the fully-automatic pipeline: Portal 1 → HeyGen render → heygen:all_complete.
async function startHeyGenPoller(jobId, card) {
  const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
  const HEYGEN_SIM_MODE = process.env.HEYGEN_SIM_MODE === 'true';
  if (!HEYGEN_API_KEY && !HEYGEN_SIM_MODE) {
    console.error(`[heygen-poller:${jobId}] No HEYGEN_API_KEY — cannot poll`);
    return;
  }

  const videoJobs = card.heygen?.videoJobs || [];
  if (!videoJobs.length) {
    console.error(`[heygen-poller:${jobId}] No videoJobs in card — cannot poll`);
    return;
  }

  // Sim mode / pre-completed jobs: skip external polling, emit directly.
  const allAlreadyComplete = videoJobs.every((vj) => vj.status === 'completed' && vj.video_url);
  if (allAlreadyComplete) {
    console.log(
      `[heygen-poller:${jobId}] ⏭️ All segments already completed — emitting heygen:all_complete`
    );
    try {
      pipelineBus.emit('heygen:poll_terminal', {
        jobId,
        outcome: 'skipped_external_poll',
        reason: 'all_segments_already_complete',
      });
    } catch (_e) {
      /* non-fatal */
    }

    const sortedAvatarSegs = [...videoJobs]
      .filter((vj) => vj.video_url)
      .sort((a, b) => (a.sceneIndex ?? 0) - (b.sceneIndex ?? 0));
    const avatarByName = {};
    for (const seg of sortedAvatarSegs) avatarByName[seg.sceneName] = seg;

    const orderedClipUrls = card.orderedClipUrls || [];
    const scriptScenes = card.script?.scenes || [];
    const segmentData = [];
    let clipIdx = 0;

    if (scriptScenes.length > 0) {
      for (const scene of scriptScenes) {
        if (scene.type === 'source_clip') {
          const clip = orderedClipUrls[clipIdx++];
          if (clip && (clip.url || clip.clipUrl)) {
            segmentData.push({
              url: clip.clipUrl || clip.url || '',
              pageUrl: clip.pageUrl || '',
              label: clip.label || scene.name || `CLIP_${clipIdx}`,
              type: 'source_clip',
              clipUrl: clip.clipUrl || clip.url || '',
              clipTimingTargets: Array.isArray(clip.clipTimingTargets)
                ? clip.clipTimingTargets
                : [],
              clipTimingFormat: clip.clipTimingFormat || 'none',
            });
          }
        } else {
          const sceneKey = scene.name || scene.id;
          const avatarSeg = avatarByName[sceneKey];
          if (avatarSeg && avatarSeg.video_url) {
            segmentData.push({
              url: avatarSeg.video_url,
              label: avatarSeg.sceneName,
              type: 'avatar',
            });
            if (scene.hasClipInsert) {
              const clip = orderedClipUrls[clipIdx++];
              if (clip && (clip.url || clip.clipUrl)) {
                segmentData.push({
                  url: clip.clipUrl || clip.url || '',
                  pageUrl: clip.pageUrl || '',
                  label: clip.label || `${sceneKey}_CLIP`,
                  type: 'source_clip',
                  clipUrl: clip.clipUrl || clip.url || '',
                  clipTimingTargets: Array.isArray(clip.clipTimingTargets)
                    ? clip.clipTimingTargets
                    : [],
                  clipTimingFormat: clip.clipTimingFormat || 'none',
                });
              }
            }
          }
        }
      }
    } else {
      for (const s of sortedAvatarSegs)
        segmentData.push({ url: s.video_url, label: s.sceneName, type: 'avatar' });
    }

    const updatedCard = persistedJobs[jobId] || card;
    updatedCard.heygen = updatedCard.heygen || {};
    updatedCard.heygen.videoJobs = videoJobs;
    updatedCard.stage = 'all_sent';
    saveJobCard(jobId, updatedCard);

    if (shouldUseManualCheckpoint(updatedCard)) {
      const man = writeManualManifest(jobId, updatedCard, segmentData);
      const {
        dir,
        manifestPath,
        manifest,
        overlaysDir,
        overlaysReadme,
        copiedPreviews,
        operatorGuideDir,
      } = man;
      let prefetch = { logPath: path.join(dir, 'source_clip_prefetch.log') };
      try {
        prefetch = await prefetchManualSourceClips(dir, segmentData, { jobId });
      } catch (e) {
        console.error(
          `[heygen-poller:${jobId}] source clip prefetch failed (non-fatal): ${e.message}`
        );
      }
      updatedCard.stage = 'awaiting_manual_segments';
      updatedCard.manualSegments = {
        enabled: true,
        status: 'awaiting_upload',
        manualDir: dir,
        manifestPath,
        operatorGuideDir,
        sourceClipPrefetchLogPath: prefetch.logPath,
        overlaysDir,
        overlaysReadme,
        overlayPreviewCopies: copiedPreviews || [],
        segmentCount: manifest.segments.length,
        requestedAt: new Date().toISOString(),
      };
      saveJobCard(jobId, updatedCard);
      console.log(
        `[heygen-poller:${jobId}] 🛑 c0 manual checkpoint — ${dir} — resume POST /job/${jobId}/manual-segments/resume`
      );
      unregisterPoller(jobId);
      return;
    }

    const segmentUrls = sortedAvatarSegs.map((s) => s.video_url).filter(Boolean);
    pipelineBus.emit('heygen:all_complete', {
      jobId,
      contentType: card.contentType || 'twitch',
      segmentUrls,
      card: updatedCard,
      segmentData,
    });
    return;
  }

  const POLL_INTERVAL_MS = 30000;
  const MAX_POLL_MINUTES = 60;
  const MAX_POLLS = (MAX_POLL_MINUTES * 60 * 1000) / POLL_INTERVAL_MS;
  let pollCount = 0;

  // STUCK detection: fire an alarm if no new completions after N consecutive polls.
  // Default 15 polls = 7.5 minutes with no progress = STUCK (override via env).
  const STUCK_POLLS = (() => {
    const raw = process.env.HEYGEN_STUCK_POLLS;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 15;
  })();
  let lastCompletedCount = 0;
  let stuckConsecutivePolls = 0;

  const pollerDone = registerPoller(jobId);

  // Record render start time in job card for Portal 2 STUCK detection
  try {
    const liveCard = persistedJobs[jobId] || card;
    if (!liveCard.state?.renderStartedAt) {
      liveCard.state = liveCard.state || {};
      liveCard.state.renderStartedAt = new Date().toISOString();
      saveJobCard(jobId, liveCard);
    }
  } catch (_e) { /* non-fatal */ }

  console.log(
    `[heygen-poller:${jobId}] 🔄 Starting — polling ${videoJobs.length} segments every 30s (max ${MAX_POLL_MINUTES}min)`
  );
  nrEvent('HeyGenPollStart', {
    jobId,
    executionMode: 'inline',
    segmentCount: videoJobs.length,
    contentType: card.contentType || 'twitch',
    maxPollMinutes: MAX_POLL_MINUTES,
  });

  // Seed pending rows in heygen_renders table (fire-and-forget, non-fatal)
  for (const vj of videoJobs) {
    if (vj.video_id) saveHeyGenRender(jobId, vj.video_id, vj.sceneName, 'pending', {}).catch(() => {});
  }

  const poll = async () => {
    pollCount++;
    if (pollCount > MAX_POLLS) {
      console.error(`[heygen-poller:${jobId}] ⏰ Timeout after ${MAX_POLL_MINUTES}min — giving up`);
      nrEvent('HeyGenPollTimeout', {
        jobId,
        pollCount,
        segmentCount: videoJobs.length,
        contentType: card.contentType || 'twitch',
      });
      try {
        pipelineBus.emit('heygen:poll_terminal', {
          jobId,
          outcome: 'timeout',
          reason: 'max_polls_exceeded',
        });
      } catch (_e) {}
      unregisterPoller(jobId);
      return;
    }

    try {
      const statuses = await Promise.all(
        videoJobs.map(async (job) => {
          try {
            const resp = await axios.get(
              `https://api.heygen.com/v1/video_status.get?video_id=${job.video_id}`,
              { headers: { 'X-Api-Key': HEYGEN_API_KEY }, timeout: 10000 }
            );
            const data = resp.data?.data || {};
            return {
              video_id: job.video_id,
              sceneName: job.sceneName,
              sceneIndex: job.sceneIndex,
              status: data.status,
              video_url: data.video_url || null,
            };
          } catch (_e) {
            return {
              video_id: job.video_id,
              sceneName: job.sceneName,
              sceneIndex: job.sceneIndex,
              status: 'error',
              video_url: null,
            };
          }
        })
      );

      const completed = statuses.filter((s) => s.status === 'completed' && s.video_url);
      const pending = statuses.filter((s) => s.status !== 'completed');
      const failed = statuses.filter((s) => s.status === 'failed');

      // Detect silent placeholder renders (source_clip scenes incorrectly submitted to HeyGen)
      const silentSuspects = completed.filter((s) => {
        const name = (s.sceneName || '').toUpperCase();
        return (
          name.includes('_CLIP') &&
          !name.includes('_CLIP1') &&
          !name.includes('_CLIP2') &&
          !name.includes('_CLIP3') &&
          !name.includes('SETUP') &&
          !name.includes('REACTION') &&
          !name.includes('RECAP')
        );
      });
      if (silentSuspects.length > 0) {
        console.warn(
          `[heygen-poller:${jobId}] ⚠️  SILENT RENDER DETECTED: ${silentSuspects.map((s) => s.sceneName).join(', ')} — source_clip scenes submitted to HeyGen, will be excluded from assembly`
        );
      }

      // Persist completed/failed statuses to DB (fire-and-forget, non-fatal)
      for (const s of statuses) {
        if (s.status === 'completed' || s.status === 'failed') {
          saveHeyGenRender(
            jobId,
            s.video_id,
            s.sceneName,
            s.status,
            s.status === 'completed' ? { videoUrl: s.video_url } : {}
          ).catch(() => {});
        }
      }

      console.log(
        `[heygen-poller:${jobId}] Poll ${pollCount}: ${completed.length}/${videoJobs.length} completed, ${pending.length} pending, ${failed.length} failed`
      );
      nrEvent('HeyGenPollTick', {
        jobId,
        pollCount,
        completed: completed.length,
        pending: pending.length,
        failed: failed.length,
        total: videoJobs.length,
        contentType: card.contentType || 'twitch',
      });
      try {
        pipelineBus.emit('heygen:poll_tick', {
          jobId,
          attempt: pollCount,
          allComplete: completed.length === videoJobs.length,
          pending: pending.length,
          failed: failed.length,
          total: videoJobs.length,
        });
      } catch (_e) {}

      if (failed.length > 0) {
        console.error(
          `[heygen-poller:${jobId}] ❌ ${failed.length} segment(s) failed: ${failed.map((f) => f.sceneName).join(', ')} — keep polling (HeyGen sometimes recovers)`
        );
      }

      // ── STUCK detection ──────────────────────────────────────────────────────
      if (completed.length === lastCompletedCount) {
        stuckConsecutivePolls++;
        if (stuckConsecutivePolls >= STUCK_POLLS) {
          const stuckMsg = `[heygen-poller:${jobId}] ⚠️  STUCK ALARM — ${stuckConsecutivePolls} consecutive polls with no progress. ${completed.length}/${videoJobs.length} complete. Pending: ${pending.map((p) => p.sceneName).join(', ')}`;
          console.error(stuckMsg);
          nrEvent('HeyGenPollStuck', {
            jobId,
            stuckConsecutivePolls,
            completedCount: completed.length,
            totalCount: videoJobs.length,
            pendingScenes: pending.map((p) => p.sceneName),
          });
          try {
            pipelineBus.emit('heygen:stuck', {
              jobId,
              stuckConsecutivePolls,
              completedCount: completed.length,
              totalCount: videoJobs.length,
              pendingScenes: pending.map((p) => p.sceneName),
            });
          } catch (_e) {}
          // Reset so alarm fires again after another STUCK_POLLS interval (not every poll)
          stuckConsecutivePolls = 0;
        }
      } else {
        stuckConsecutivePolls = 0;
      }
      lastCompletedCount = completed.length;

      if (completed.length < videoJobs.length) {
        setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }

      // All segments complete — build segmentData and hand off to pipeline bus
      console.log(
        `[heygen-poller:${jobId}] ✅ All ${videoJobs.length} segments completed — building segmentData`
      );

      const sortedAvatarSegs = [...completed].sort((a, b) => a.sceneIndex - b.sceneIndex);
      const avatarByName = {};
      for (const seg of sortedAvatarSegs) avatarByName[seg.sceneName] = seg;

      const orderedClipUrls = card.orderedClipUrls || [];
      const scriptScenes = card.script?.scenes || [];
      const segmentData = [];
      let clipIdx = 0;

      if (scriptScenes.length > 0) {
        for (const scene of scriptScenes) {
          if (scene.type === 'source_clip') {
            const clip = orderedClipUrls[clipIdx++];
            if (clip && (clip.url || clip.clipUrl)) {
              segmentData.push({
                url: clip.clipUrl || clip.url || '',
                pageUrl: clip.pageUrl || '',
                label: clip.label || scene.name || `CLIP_${clipIdx}`,
                type: 'source_clip',
                clipUrl: clip.clipUrl || clip.url || '',
                clipTimingTargets: Array.isArray(clip.clipTimingTargets)
                  ? clip.clipTimingTargets
                  : [],
                clipTimingFormat: clip.clipTimingFormat || 'none',
              });
            }
          } else {
            const sceneKey = scene.name || scene.id;
            const avatarSeg =
              avatarByName[sceneKey] ||
              Object.values(avatarByName).find((v) => v.sceneName === sceneKey);
            if (avatarSeg && avatarSeg.video_url) {
              segmentData.push({
                url: avatarSeg.video_url,
                label: avatarSeg.sceneName,
                type: 'avatar',
              });
              if (scene.hasClipInsert) {
                const clip = orderedClipUrls[clipIdx++];
                if (clip && (clip.url || clip.clipUrl)) {
                  segmentData.push({
                    url: clip.clipUrl || clip.url || '',
                    pageUrl: clip.pageUrl || '',
                    label: clip.label || `${sceneKey}_CLIP`,
                    type: 'source_clip',
                    clipUrl: clip.clipUrl || clip.url || '',
                    clipTimingTargets: Array.isArray(clip.clipTimingTargets)
                      ? clip.clipTimingTargets
                      : [],
                    clipTimingFormat: clip.clipTimingFormat || 'none',
                  });
                }
              }
            }
          }
        }
      } else {
        for (const s of sortedAvatarSegs)
          segmentData.push({ url: s.video_url, label: s.sceneName, type: 'avatar' });
      }

      // Attach cardData to INTRO segments
      for (const avatarSeg of sortedAvatarSegs) {
        const seg = segmentData.find((s) => s.label === avatarSeg.sceneName && s.type === 'avatar');
        if (!seg) continue;
        const _sceneName = avatarSeg.sceneName || '';
        const _ct = card.contentType || 'twitch';
        if (_ct === 'news' && /STORY(\d+)_INTRO/i.test(_sceneName)) {
          const m = _sceneName.match(/STORY(\d+)_INTRO/i);
          const storyIdx = m ? parseInt(m[1], 10) - 1 : -1;
          const item = (card.newsItems || [])[storyIdx];
          if (item)
            seg.cardData = {
              title: item.title || `Story ${storyIdx + 1}`,
              category: 'WORLD NEWS',
              storyId: `story_${storyIdx + 1}`,
              imageUrl: item.thumbnailUrl || item.imageUrl || null,
              heroImageUrl: item.heroImageUrl || item.thumbnailUrl || null,
              source: item.source || '',
            };
        } else if (_ct === 'nba' && /GAME(\d+)[_ ].*INTRO/i.test(_sceneName)) {
          const gm = _sceneName.match(/GAME(\d+)/i);
          const gameIdx = gm ? parseInt(gm[1], 10) - 1 : 0;
          const rawName = _sceneName
            .replace(/^GAME\d+[_ ]/i, '')
            .replace(/[_ ]INTRO$/i, '')
            .replace(/_/g, ' ');
          const nbaItem = (card.nbaItems || [])[gameIdx];
          seg.cardData = {
            title: nbaItem?.title || nbaItem?.matchup || rawName || `Game ${gameIdx + 1}`,
            matchup: nbaItem?.matchup || rawName || `Game ${gameIdx + 1}`,
            category: 'NBA GAME',
            storyId: `game_${gameIdx + 1}`,
            gameId: nbaItem?.gameId || null,
          };
        } else if (_ct === 'twitch' && /[_ ]INTRO$/i.test(_sceneName)) {
          const namePart = _sceneName
            .replace(/[_ ]INTRO$/i, '')
            .replace(/_/g, ' ')
            .toLowerCase();
          const streamer =
            (card.streamers || []).find(
              (s) =>
                (s.displayName || '').toLowerCase() === namePart ||
                (s.twitchUsername || '').toLowerCase() === namePart
            ) || (card.streamers || [])[0];
          if (streamer)
            seg.cardData = {
              title: streamer.displayName || namePart,
              category: 'ON STREAM',
              storyId: `streamer_${namePart.replace(/\s+/g, '_')}`,
              fact: [streamer.origin, streamer.fact].filter(Boolean).join(' · ').slice(0, 60),
              imageUrl: streamer.profileImage || null,
              twitchUsername: streamer.twitchUsername || streamer.username || null,
            };
        }
      }

      console.log(
        `[heygen-poller:${jobId}] Built segmentData: ${segmentData.length} segments (${sortedAvatarSegs.length} avatar + ${clipIdx} clips)`
      );

      const updatedCard = persistedJobs[jobId] || card;
      updatedCard.heygen = updatedCard.heygen || {};
      updatedCard.heygen.videoJobs = statuses.map((s) => ({
        ...(videoJobs.find((j) => j.video_id === s.video_id) || {}),
        status: s.status,
        video_url: s.video_url,
      }));
      updatedCard.stage = 'all_sent';
      saveJobCard(jobId, updatedCard);

      if (shouldUseManualCheckpoint(updatedCard)) {
        const man = writeManualManifest(jobId, updatedCard, segmentData);
        const {
          dir,
          manifestPath,
          manifest,
          overlaysDir,
          overlaysReadme,
          copiedPreviews,
          operatorGuideDir,
        } = man;
        let prefetch = { logPath: path.join(dir, 'source_clip_prefetch.log') };
        try {
          prefetch = await prefetchManualSourceClips(dir, segmentData, { jobId });
        } catch (e) {
          console.error(`[heygen-poller:${jobId}] prefetch failed (non-fatal): ${e.message}`);
        }
        updatedCard.stage = 'awaiting_manual_segments';
        updatedCard.manualSegments = {
          enabled: true,
          status: 'awaiting_upload',
          manualDir: dir,
          manifestPath,
          operatorGuideDir,
          sourceClipPrefetchLogPath: prefetch.logPath,
          overlaysDir,
          overlaysReadme,
          overlayPreviewCopies: copiedPreviews || [],
          segmentCount: manifest.segments.length,
          requestedAt: new Date().toISOString(),
        };
        saveJobCard(jobId, updatedCard);
        try {
          pipelineBus.emit('heygen:poll_terminal', {
            jobId,
            outcome: 'manual_checkpoint_waiting',
            reason: 'c0_manual_segment_hold',
          });
        } catch (_e) {}
        console.log(
          `[heygen-poller:${jobId}] 🛑 manual checkpoint — ${dir} — resume POST /job/${jobId}/manual-segments/resume`
        );
        unregisterPoller(jobId);
        return;
      }

      const segmentUrls = sortedAvatarSegs.map((s) => s.video_url).filter(Boolean);
      nrEvent('HeyGenSegmentsReady', {
        jobId,
        contentType: card.contentType || 'twitch',
        segmentCount: videoJobs.length,
        segmentUrlCount: segmentUrls.length,
      });
      try {
        pipelineBus.emit('heygen:poll_terminal', {
          jobId,
          outcome: 'all_segments_ready',
          reason: null,
        });
      } catch (_e) {}
      pipelineBus.emit('heygen:all_complete', {
        jobId,
        contentType: card.contentType || 'twitch',
        segmentUrls,
        card: updatedCard,
        segmentData,
      });
      unregisterPoller(jobId);
      console.log(
        `[heygen-poller:${jobId}] 📡 heygen:all_complete emitted — Portal 2 + assembly handed off`
      );
    } catch (pollErr) {
      console.error(`[heygen-poller:${jobId}] Poll error: ${pollErr.message} — retrying in 30s`);
      setTimeout(poll, POLL_INTERVAL_MS);
    }
  };

  setTimeout(poll, POLL_INTERVAL_MS);
}

// ── resumeInFlightPollers() ────────────────────────────────────────────────────
// Call once at server startup (after job cards are loaded) to restart pollers
// that were active when the server last exited.
function resumeInFlightPollers() {
  const MAX_RESUME_POLLERS = 2;
  let resumed = 0;

  const candidates = Object.entries(persistedJobs).filter(([jobId, card]) => {
    if ((card.status || '') === 'dismissed') return false;
    const stage = card.stage || inferJobStage(card);
    if (stage === 'assembled' || stage === 'published' || stage === 'gate5_forced') return false;
    if (stage !== 'all_sent') return false;
    const videoJobs = card.heygen?.videoJobs || [];
    if (!videoJobs.length) return false;
    if (activePollers.has(jobId)) return false;
    return true;
  });

  if (candidates.length > MAX_RESUME_POLLERS) {
    console.warn(
      `[startup-resume] ⚠️  ${candidates.length} jobs eligible — capping at ${MAX_RESUME_POLLERS}. Remaining ${candidates.length - MAX_RESUME_POLLERS} need manual re-trigger from dashboard.`
    );
  }

  for (const [jobId, card] of candidates.slice(0, MAX_RESUME_POLLERS)) {
    const videoJobs = card.heygen?.videoJobs || [];
    if (videoJobs.every((vj) => vj.status === 'completed' && vj.video_url)) {
      console.log(
        `[startup-resume:${jobId}] All segments already completed — emitting heygen:all_complete`
      );
      const contentType = card.contentType || 'twitch';
      const formType = card.formType || 'compilation';
      const segmentUrls = videoJobs.filter((vj) => vj.video_url).map((vj) => vj.video_url);
      setTimeout(() => {
        try {
          pipelineBus.emit('heygen:poll_terminal', {
            jobId,
            outcome: 'all_segments_ready',
            reason: 'startup_resume_card_complete',
          });
        } catch (_e) {}
        pipelineBus.emit('heygen:all_complete', {
          jobId,
          contentType,
          formType,
          segmentUrls,
          card,
          segmentData: null,
        });
      }, 2000);
    } else {
      console.log(
        `[startup-resume:${jobId}] Resuming poller (${videoJobs.length} segments, not all complete)`
      );
      startHeyGenPoller(jobId, card).catch((e) =>
        console.error(`[startup-resume:${jobId}] Poller error: ${e.message}`)
      );
    }
    resumed++;
  }

  if (resumed > 0)
    console.log(
      `[startup-resume] Resumed ${resumed} in-flight job(s) (cap: ${MAX_RESUME_POLLERS})`
    );

  // Resume script_ready jobs (Portal 1 passed but HeyGen not yet submitted)
  const scriptReadyCandidates = Object.values(persistedJobs).filter((card) => {
    if ((card.status || '') === 'dismissed') return false;
    const stage = card.stage || inferJobStage(card);
    if (stage !== 'script_ready') return false;
    const script = card.script?.raw || card.script;
    if (!script || (typeof script === 'string' && script.length < 10)) return false;
    return (card.heygen?.videoJobs || []).length === 0;
  });

  if (scriptReadyCandidates.length > 0) {
    const MAX_SCRIPT_READY_RESUME = MAX_RESUME_POLLERS;
    console.log(
      `[startup-resume] ${scriptReadyCandidates.length} script_ready job(s) — auto-sending to HeyGen (cap: ${MAX_SCRIPT_READY_RESUME})`
    );
    const toResume = scriptReadyCandidates.slice(0, MAX_SCRIPT_READY_RESUME);

    (async () => {
      for (const card of toResume) {
        const jobId = card.jobId || card.id || card.scriptJobId;
        if (!jobId) {
          console.warn('[startup-resume:script_ready] Card has no jobId — skipping');
          continue;
        }
        const contentType = card.contentType || 'twitch';
        const script = card.script?.raw || (typeof card.script === 'string' ? card.script : null);
        if (!script) {
          console.warn(`[startup-resume:${jobId}] No script in card — skipping`);
          continue;
        }

        try {
          const format = contentType.includes('-short') ? 'portrait' : 'landscape';
          console.log(`[startup-resume:${jobId}] Sending to HeyGen (${contentType}, ${format})`);
          const heygenResult = await sendScriptToHeyGen(script, { contentType, format, jobId });
          if (heygenResult?.videoJobs?.length) {
            card.heygen = heygenResult;
            if (useC0ImmediateManualHold(card)) {
              const prep = await prepareC0ManualHoldAfterHeyGen(jobId, card);
              card.stage = 'awaiting_manual_segments';
              card.manualSegments = prep.manualSegments;
              saveJobCard(jobId, card);
              console.log(
                `[startup-resume:${jobId}] ✅ c0 immediate manual hold (${heygenResult.videoJobs.length} scenes sent) — ${prep.manualSegments.manualDir}`
              );
            } else {
              card.stage = 'all_sent';
              saveJobCard(jobId, card);
              console.log(
                `[startup-resume:${jobId}] ✅ Sent ${heygenResult.videoJobs.length} scenes to HeyGen`
              );
              startHeyGenPoller(jobId, card).catch((e) =>
                console.error(`[startup-resume:${jobId}] Poller error: ${e.message}`)
              );
            }
          } else {
            console.warn(`[startup-resume:${jobId}] HeyGen returned no videoJobs — skipping`);
          }
        } catch (e) {
          console.error(`[startup-resume:${jobId}] HeyGen send failed: ${e.message}`);
        }
      }
    })().catch((e) => console.error('[startup-resume:script_ready] Async error:', e.message));
  }
}

module.exports = {
  activePollers,
  registerPoller,
  unregisterPoller,
  startHeyGenPoller,
  resumeInFlightPollers,
};
