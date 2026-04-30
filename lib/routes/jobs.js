'use strict';

// ── Job lifecycle routes ───────────────────────────────────────────────────────
// GET  /jobs
// DELETE /job/:id
// POST /job/:id/rollback
// POST /job/:id/advance
// POST /job/:id/manual-segments/resume
// POST /job/:id/dismiss
// POST /job/:id/stuck
// POST /job/:id/qa-confirm-generate
// GET  /job-spec/:jobId
// GET  /content-type-status

const fs = require('fs');
const router = require('express').Router();

const {
  persistedJobs,
  stuckPatternLog,
  saveJobCard,
  inferJobStage,
  markJobStuck,
} = require('../job_card');
const { assemblyJobs } = require('../assembly');
const pipelineBus = require('../pipeline_events');
const { logError } = require('../error_logger');
const { validateJobId, validateBodySize } = require('../validation');
const { apiLimit } = require('../rateLimiter');
const { updateJobPublishSchedule } = require('../db');
const { requireAuth } = require('../auth');

// Detect current pipeline stage from card fields (fallback for legacy cards)
function detectStage(card) {
  if (!card) return 'unknown';
  if (card.publishRecord && card.publishRecord.publishedAt) return 'published';
  if (card.assembledAt || card.finalUrl) return 'assembled';
  // card.heygen is a C0 data structure — C1+ will use card.videoJobs instead
  if (card.heygen?.videoJobs?.length || card.videoJobs?.length) return 'all_sent';
  const script = card.script;
  if (script && (script.raw || typeof script === 'string') && (script.raw || script).length > 10)
    return 'script_ready';
  return 'unknown';
}

// GET /jobs — return in-flight job cards for dashboard recovery
const IN_FLIGHT_STAGES = new Set([
  'script_ready',
  'all_sent',
  'awaiting_manual_segments',
  'assembling',
]);

router.get('/jobs', async (req, res) => {
  const actionableJobs = Object.values(persistedJobs)
    .filter((job) => {
      if ((job.status || '') === 'dismissed') return false;
      return IN_FLIGHT_STAGES.has(job.stage || inferJobStage(job));
    })
    .sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));

  const { getJobBySpec } = require('../db');
  const { buildGateStatusSnapshot } = require('../job_spec_contracts');

  const jobsWithGateStatus = await Promise.all(
    actionableJobs.map(async (job) => {
      const candidates = [job.jobSpecId, job.scriptJobId, job.id].filter(Boolean);
      let spec = null;
      for (const id of candidates) {
        try {
          spec = await getJobBySpec(id);
          if (spec) break;
        } catch (_e) {}
      }
      return { ...job, gateStatus: spec ? buildGateStatusSnapshot(spec) : null };
    })
  );

  res.json({ ok: true, count: jobsWithGateStatus.length, jobs: jobsWithGateStatus });
});

// DELETE /job/:id
router.delete('/job/:id', (req, res) => {
  const jobId = req.params.id;
  if (!persistedJobs[jobId]) return res.json({ ok: false, error: 'Job not found: ' + jobId });
  delete persistedJobs[jobId];
  // Fire-and-forget Postgres delete
  const { deleteJob } = require('../db');
  if (typeof deleteJob === 'function') deleteJob(jobId).catch(() => {});
  console.log(`[jobs] Deleted job: ${jobId}`);
  res.json({ ok: true, deleted: jobId });
});

// POST /job/:id/rollback
router.post('/job/:id/rollback', apiLimit, validateJobId, (req, res) => {
  const jobId = req.params.id;
  const card = persistedJobs[jobId];
  if (!card) return res.json({ ok: false, error: 'Job not found: ' + jobId });

  const before = card.stage || detectStage(card);

  if (before === 'published') {
    delete card.publishRecord;
    delete card._gate3Approved;
    card.stage = 'assembled';
    saveJobCard(jobId, card);
    logError('PIPELINE_ROLLBACK', 'Job rolled back: published → assembled', {
      jobId,
      before: 'published',
      after: 'assembled',
      at: new Date().toISOString(),
    });
    try {
      pipelineBus.emit('job:rollback', {
        jobId,
        before: 'published',
        after: 'assembled',
        message: 'Publish record cleared — re-approve to re-publish.',
      });
    } catch (_e) {}
    return res.json({
      ok: true,
      jobId,
      before: 'published',
      after: 'assembled',
      message: 'Publish record cleared — re-approve to re-publish.',
    });
  }

  if (before === 'assembled') {
    delete card.assembledAt;
    delete card.finalUrl;
    delete card.outputPath;
    delete card.gate5;
    delete card._gate5Done;
    delete card._gate5Running;
    delete card._gate3Approved;
    delete card._gate3Rejected;
    // C0: card.heygen.videoJobs — C1+: card.videoJobs
    if (card.heygen?.videoJobs)
      card.heygen.videoJobs.forEach((vj) => {
        vj._url = null;
      });
    if (card.videoJobs)
      card.videoJobs.forEach((vj) => {
        vj._url = null;
      });
    Object.keys(assemblyJobs).forEach((asmId) => {
      if (assemblyJobs[asmId]?.sourceJobId === jobId) {
        delete assemblyJobs[asmId];
        console.log(`[rollback] ${jobId}: cleared assembly dedup lock for asmId=${asmId}`);
      }
    });
    card.stage = 'all_sent';
    saveJobCard(jobId, card);
    logError('PIPELINE_ROLLBACK', 'Job rolled back: assembled → all_sent', {
      jobId,
      before: 'assembled',
      after: 'all_sent',
      at: new Date().toISOString(),
    });
    try {
      pipelineBus.emit('job:rollback', {
        jobId,
        before: 'assembled',
        after: 'all_sent',
        message: 'Assembly cleared — click REFRESH IDs then ASSEMBLE again.',
      });
    } catch (_e) {}
    return res.json({
      ok: true,
      jobId,
      before: 'assembled',
      after: 'all_sent',
      message: 'Assembly cleared — click REFRESH IDs then ASSEMBLE again.',
    });
  }

  if (before === 'all_sent') {
    // C0: clears HeyGen video IDs — C1+ equivalent: clears generated video segment IDs
    if (card.heygen?.videoJobs)
      card.heygen.videoJobs.forEach((vj) => {
        delete vj.video_id;
      });
    if (card.videoJobs)
      card.videoJobs.forEach((vj) => {
        delete vj.video_id;
      });
    delete card.gate2;
    card.stage = 'script_ready';
    saveJobCard(jobId, card);
    logError('PIPELINE_ROLLBACK', 'Job rolled back: all_sent → script_ready', {
      jobId,
      before: 'all_sent',
      after: 'script_ready',
      at: new Date().toISOString(),
    });
    try {
      pipelineBus.emit('job:rollback', {
        jobId,
        before: 'all_sent',
        after: 'script_ready',
        message: 'Segment IDs cleared — edit script and re-send to video generation.',
      });
    } catch (_e) {}
    return res.json({
      ok: true,
      jobId,
      before: 'all_sent',
      after: 'script_ready',
      message: 'Segment IDs cleared — edit script and re-send to video generation.',
    });
  }

  return res.json({ ok: false, error: `Job is at stage "${before}" — nothing to roll back to.` });
});

// POST /job/:id/advance
router.post('/job/:id/advance', apiLimit, validateJobId, (req, res) => {
  const jobId = req.params.id;
  const card = persistedJobs[jobId];
  if (!card) return res.json({ ok: false, error: 'Job not found: ' + jobId });

  const stage = card.stage || detectStage(card);

  if (stage === 'script_ready') {
    card.gate1 = card.gate1 || {};
    card.gate1.outcome = 'force_pass';
    card.gate1.score = card.gate1.score || 0;
    card.gate1.forcedAt = new Date().toISOString();
    card.stage = 'gate1_forced';
    saveJobCard(jobId, card);
    logError('PIPELINE_ADVANCE', 'Job force-advanced: script_ready → gate1_forced', {
      jobId,
      before: 'script_ready',
      after: 'gate1_forced',
      at: new Date().toISOString(),
    });
    try {
      pipelineBus.emit('job:advance', {
        jobId,
        from: 'script_ready',
        to: 'gate1_forced',
        message: 'Portal 1 force-passed — video generation is now unlocked.',
      });
    } catch (_e) {}
    return res.json({
      ok: true,
      jobId,
      before: 'script_ready',
      after: 'gate1_forced',
      message: 'Portal 1 force-passed — video generation is now unlocked.',
    });
  }

  if (stage === 'all_sent') {
    // C0: card.heygen.videoJobs — C1+: card.videoJobs
    const videoJobs = card.heygen?.videoJobs || card.videoJobs || [];
    let forced = 0;
    videoJobs.forEach((vj) => {
      if (!vj._url && vj.video_id) {
        vj._forcedComplete = true;
        forced++;
      }
    });
    card.gate2 = card.gate2 || {};
    card.gate2.outcome = 'force_pass';
    card.gate2.forcedAt = new Date().toISOString();
    card.stage = 'gate2_forced';
    saveJobCard(jobId, card);
    logError('PIPELINE_ADVANCE', 'Job force-advanced: all_sent → gate2_forced', {
      jobId,
      before: 'all_sent',
      after: 'gate2_forced',
      at: new Date().toISOString(),
    });
    try {
      pipelineBus.emit('job:advance', {
        jobId,
        from: 'all_sent',
        to: 'gate2_forced',
        message: `Portal 2 force-passed — ${forced} segment(s) marked. Click REFRESH IDs to get real URLs, then ASSEMBLE.`,
      });
    } catch (_e) {}
    return res.json({
      ok: true,
      jobId,
      before: 'all_sent',
      after: 'gate2_forced',
      message: `Portal 2 force-passed — ${forced} segment(s) marked. Click REFRESH IDs to get real URLs, then ASSEMBLE.`,
    });
  }

  if (stage === 'assembled') {
    card.gate5 = card.gate5 || {};
    card.gate5.score = card.gate5.score || 0;
    card.gate5.outcome = 'force_pass';
    card.gate5.forcedAt = new Date().toISOString();
    card._gate5Done = true;
    card.stage = 'gate5_forced';
    saveJobCard(jobId, card);
    logError('PIPELINE_ADVANCE', 'Job force-advanced: assembled → gate5_forced', {
      jobId,
      before: 'assembled',
      after: 'gate5_forced',
      at: new Date().toISOString(),
    });
    try {
      pipelineBus.emit('job:advance', {
        jobId,
        from: 'assembled',
        to: 'gate5_forced',
        message: 'Portal 5 force-passed — APPROVE & UPLOAD button is now unlocked.',
      });
    } catch (_e) {}
    return res.json({
      ok: true,
      jobId,
      before: 'assembled',
      after: 'gate5_forced',
      message: 'Portal 5 force-passed — APPROVE & UPLOAD button is now unlocked.',
    });
  }

  return res.json({ ok: false, error: `Job is at stage "${stage}" — cannot advance further.` });
});

// POST /job/:id/manual-segments/resume
router.post('/job/:id/manual-segments/resume', apiLimit, validateJobId, (req, res) => {
  const jobId = req.params.id;
  const card = persistedJobs[jobId];
  if (!card) return res.status(404).json({ ok: false, error: `Job not found: ${jobId}` });

  let stage = card.stage || inferJobStage(card);
  if (stage === 'published') {
    return res
      .status(400)
      .json({ ok: false, error: 'Job is published — POST /job/:id/rollback first, then resume.' });
  }

  if (stage === 'assembled' || stage === 'gate5_forced') {
    delete card.assembledAt;
    delete card.finalUrl;
    delete card.outputPath;
    delete card.gate5;
    delete card._gate5Done;
    delete card._gate5Running;
    delete card._gate3Approved;
    delete card._gate3Rejected;
    // C0: card.heygen.videoJobs — C1+: card.videoJobs
    if (card.heygen?.videoJobs)
      card.heygen.videoJobs.forEach((vj) => {
        vj._url = null;
      });
    if (card.videoJobs)
      card.videoJobs.forEach((vj) => {
        vj._url = null;
      });
    Object.keys(assemblyJobs).forEach((asmId) => {
      if (assemblyJobs[asmId]?.sourceJobId === jobId) {
        delete assemblyJobs[asmId];
        console.log(
          `[manual-segments/resume] ${jobId}: cleared assembly dedup lock for asmId=${asmId}`
        );
      }
    });
    card.stage = 'all_sent';
    saveJobCard(jobId, card);
    stage = 'all_sent';
    console.log(
      `[manual-segments/resume] ${jobId}: cleared prior assembly — continuing to Portal 2 + assemble`
    );
  }

  if (stage !== 'awaiting_manual_segments' && stage !== 'all_sent') {
    return res.status(400).json({
      ok: false,
      error: `Job is at stage "${stage}" — expected awaiting_manual_segments or all_sent`,
    });
  }

  // C0: card.heygen.videoJobs — C1+: card.videoJobs
  const segmentUrls = (card.heygen?.videoJobs || card.videoJobs || [])
    .filter((vj) => vj.status === 'completed' && vj.video_url)
    .map((vj) => vj.video_url);

  card.manualSegments = {
    ...(card.manualSegments || {}),
    status: 'resume_requested',
    resumedAt: new Date().toISOString(),
  };
  card.stage = 'all_sent';
  saveJobCard(jobId, card);

  try {
    pipelineBus.emit('heygen:all_complete', {
      jobId,
      contentType: card.contentType || 'general',
      segmentUrls,
      card,
      segmentData: null,
    });
    return res.json({
      ok: true,
      jobId,
      message: 'Resume accepted — Portal 2 + assembly handoff emitted.',
      segmentCount: segmentUrls.length,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// POST /job/:id/dismiss
router.post('/job/:id/dismiss', apiLimit, validateJobId, (req, res) => {
  const { id } = req.params;
  const card = persistedJobs[id];
  if (!card) return res.status(404).json({ error: 'Job not found', id });
  saveJobCard(id, { ...card, status: 'dismissed' });
  res.json({ ok: true, id, status: 'dismissed' });
});

// POST /job/:id/stuck
router.post('/job/:id/stuck', apiLimit, validateJobId, (req, res) => {
  const { id } = req.params;
  const { gate, reason, detail = {} } = req.body;
  if (!gate || !reason) return res.status(400).json({ error: 'gate and reason required' });
  if (!persistedJobs[id]) return res.status(404).json({ error: 'Job not found', id });
  markJobStuck(id, gate, reason, detail);
  res.json({ ok: true, id, gate, reason });
});

// POST /job/:id/qa-confirm-generate
router.post('/job/:id/qa-confirm-generate', apiLimit, validateJobId, (req, res) => {
  const { id } = req.params;
  try {
    const { markConfirmed } = require('../qa_generate_confirm');
    markConfirmed(id, { source: 'qa_confirm_endpoint' });
    res.json({ ok: true, jobId: id, status: 'confirmed' });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// GET /job-spec/:jobId
router.get('/job-spec/:jobId', async (req, res) => {
  try {
    const { getJobSpec } = require('../job_spec');
    const {
      buildGateStatusSnapshot,
      validateGateContractConsistency,
    } = require('../job_spec_contracts');
    const spec = await getJobSpec(req.params.jobId);
    if (!spec) return res.status(404).json({ error: 'Job spec not found' });
    res.json({
      ok: true,
      jobSpec: spec,
      gateStatus: buildGateStatusSnapshot(spec),
      gateContractValidation: validateGateContractConsistency(spec),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /content-type-status
router.get('/content-type-status', (req, res) => {
  const disabled = global.disabledContentTypes || {};
  const stuckCounts = {};
  for (const [contentType, timestamps] of Object.entries(stuckPatternLog)) {
    stuckCounts[contentType] = timestamps.length;
  }
  res.json({ ok: true, disabled, stuckCounts, threshold: 3, windowHours: 24 });
});

// PUT /jobs/:id/schedule — set or update publish schedule (CPD-48)
router.put('/jobs/:id/schedule', requireAuth, apiLimit, async (req, res) => {
  const { id } = req.params;
  const { publishMode, scheduledPublishAt } = req.body;

  if (!publishMode || !['immediate', 'scheduled'].includes(publishMode)) {
    return res.status(400).json({ error: 'publishMode must be "immediate" or "scheduled"' });
  }

  if (publishMode === 'scheduled') {
    if (!scheduledPublishAt) {
      return res.status(400).json({ error: 'scheduledPublishAt required when publishMode is "scheduled"' });
    }
    const ts = typeof scheduledPublishAt === 'number' ? scheduledPublishAt : Date.parse(scheduledPublishAt);
    if (isNaN(ts)) {
      return res.status(400).json({ error: 'scheduledPublishAt must be a valid ISO date or epoch ms' });
    }
    const minTs = Date.now() + 30 * 60 * 1000;       // 30 min from now
    const maxTs = Date.now() + 60 * 24 * 60 * 60 * 1000; // 60 days from now
    if (ts < minTs) {
      return res.status(400).json({ error: 'scheduledPublishAt must be at least 30 minutes in the future' });
    }
    if (ts > maxTs) {
      return res.status(400).json({ error: 'scheduledPublishAt must be within 60 days' });
    }
    try {
      await updateJobPublishSchedule(id, 'scheduled', ts);
      return res.json({ ok: true, jobId: id, publishMode: 'scheduled', scheduledPublishAt: new Date(ts).toISOString() });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // publishMode = 'immediate' — clear schedule
  try {
    await updateJobPublishSchedule(id, 'immediate', null);
    return res.json({ ok: true, jobId: id, publishMode: 'immediate', scheduledPublishAt: null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
