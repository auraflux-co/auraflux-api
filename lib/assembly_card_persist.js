'use strict';

const fs = require('fs');
const path = require('path');
const { persistedJobs, saveJobCard } = require('./job_card');
const { assemblyJobs } = require('./assembly');
const { nrEvent, nrAssemblyComplete } = require('./nr_events');
const pipelineBus = require('./pipeline_events');
const logger = require('./logger');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');

function localPreviewUrlFromAsm(asmJob) {
  const port = process.env.PORT || 3000;
  if (asmJob?.filename) {
    return `http://localhost:${port}/download/${asmJob.filename}`;
  }
  if (asmJob?.outputPath && fs.existsSync(asmJob.outputPath)) {
    return `http://localhost:${port}/download/${path.basename(asmJob.outputPath)}`;
  }
  return null;
}

function buildGate3CardFields(asmJob) {
  const g3a = asmJob.gate3aResult || {};
  const concerns = Array.isArray(g3a.concerns) ? g3a.concerns : [];
  const deductions = (g3a.deductions || []).map((d) => d.reason).filter(Boolean);
  const ffmpegIssue = g3a.ffmpegAlarm?.issue || asmJob.qaReport || '';
  const reportLines = [ffmpegIssue, ...concerns, ...deductions].filter(Boolean);
  const score = asmJob.qaScore ?? asmJob.gate3aScore ?? g3a.score ?? null;
  const qaOutcome = asmJob.qaOutcome || null;
  return {
    score,
    outcome: qaOutcome === 'fail' ? 'fail' : (qaOutcome || g3a.outcome || 'unknown'),
    gate3aScore: asmJob.gate3aScore ?? g3a.score ?? null,
    gate3aOutcome: asmJob.gate3aOutcome ?? g3a.outcome ?? null,
    report: reportLines.join('\n') || asmJob.qaReport || '',
    concerns,
    deductions,
    ffmpegAlarm: g3a.ffmpegAlarm || null,
    sampleFindings: g3a.sampleFindings || null,
    checkedAt: new Date().toISOString(),
  };
}

function applyAssemblyOutputs(finalCard, asmJob) {
  if (asmJob.outputPath) finalCard.outputPath = asmJob.outputPath;
  if (asmJob.filename) finalCard.filename = asmJob.filename;
  const preview = asmJob.driveUrl || asmJob.localUrl || localPreviewUrlFromAsm(asmJob);
  if (preview) {
    if (preview.includes('/download/')) {
      finalCard.localPreviewUrl = preview;
      if (!finalCard.driveUrl) finalCard.finalUrl = preview;
    } else if (!finalCard.driveUrl) {
      finalCard.finalUrl = preview;
    }
    if (asmJob.driveUrl) finalCard.driveUrl = asmJob.driveUrl;
  }
  if (asmJob.qaScore !== undefined || asmJob.gate3aScore !== undefined || asmJob.gate3aResult) {
    finalCard.gate3 = buildGate3CardFields(asmJob);
    finalCard.qaOutcome = asmJob.qaOutcome || finalCard.gate3.outcome;
  }
  if (asmJob.publishCopy) {
    finalCard.publishCopy = asmJob.publishCopy;
    finalCard.state = finalCard.state || {};
    finalCard.state.savedOutputs = {
      ...(finalCard.state.savedOutputs || {}),
      publishCopy: asmJob.publishCopy,
      driveUrl: asmJob.driveUrl || finalCard.state.savedOutputs?.driveUrl || null,
    };
  }
}

/**
 * Persist terminal assembly state onto the job card (success, gate3 fail, or ffmpeg fail).
 */
function persistAssemblyTerminalState(jobId, asmJob, { contentType, assemblyId, onPublished } = {}) {
  if (!jobId || !asmJob) return null;
  const finalCard = persistedJobs[jobId];
  if (!finalCard) return null;

  applyAssemblyOutputs(finalCard, asmJob);

  const isSuccess = asmJob.status === 'done' || asmJob.status === 'manual_review';
  const isGate3Fail = asmJob.status === 'failed' && asmJob.qaOutcome === 'fail';

  if (isSuccess) {
    finalCard.assembledAt = finalCard.assembledAt || new Date().toISOString();
    const holdStages = new Set(['awaiting_review', 'metadata_review', 'music_review']);
    if (!holdStages.has(finalCard.stage)) {
      finalCard.stage = 'assembled';
    }
    if (asmJob.qaOutcome === 'pass' || asmJob.qaOutcome === 'manual_review') {
      finalCard.stage = finalCard.stage === 'awaiting_review' ? finalCard.stage : 'assembled';
    }
    if (asmJob.publishResult) {
      finalCard.publishRecord = { publishedAt: new Date().toISOString(), ...asmJob.publishResult };
      finalCard.stage = 'published';
      if (typeof onPublished === 'function') {
        try { onPublished(jobId); } catch (_e) { /* non-fatal */ }
      }
    }
    finalCard.status = 'completed';
  } else if (isGate3Fail) {
    finalCard.status = 'gate3_failed';
    finalCard.stage = finalCard.stage || 'heygen_done';
    if (!finalCard.gate3) {
      finalCard.gate3 = {
        score: asmJob.qaScore ?? null,
        outcome: 'fail',
        report: asmJob.qaReport || 'Gate 3 hard fail',
        checkedAt: new Date().toISOString(),
      };
    }
    finalCard.qaOutcome = 'fail';
  } else if (asmJob.status === 'failed') {
    finalCard.status = 'failed';
    finalCard.assemblyError = asmJob.error || 'FFmpeg assembly failed';
  }

  saveJobCard(jobId, finalCard);

  if (isSuccess || isGate3Fail) {
    const cid = finalCard.customerId || 'c0';
    const durMs = asmJob.duration != null ? Math.round(Number(asmJob.duration) * 1000) : null;
    if (isSuccess) {
      nrAssemblyComplete(jobId, cid, contentType, assemblyId, durMs, asmJob.sizeMB ?? null, asmJob.qaScore ?? null);
    }
    nrEvent('PipelineRunTerminal', {
      jobId,
      assemblyId,
      contentType,
      customerId: cid,
      stage: finalCard.stage,
      gate3Score: asmJob.qaScore ?? null,
      gate3Outcome: asmJob.qaOutcome || null,
      hasDriveUrl: !!(asmJob.driveUrl || finalCard.finalUrl),
    });
    try {
      pipelineBus.emit('gate3:complete', { jobId, score: asmJob.qaScore, outcome: asmJob.qaOutcome });
    } catch (_e) { /* non-fatal */ }
  }

  logger.info(
    {
      jobId,
      stage: finalCard.stage,
      status: finalCard.status,
      gate3Score: asmJob.qaScore || null,
      driveUrl: asmJob.driveUrl || finalCard.localPreviewUrl || null,
    },
    isGate3Fail ? 'Assembly gate3 fail persisted' : 'Assembly completion persisted'
  );

  return finalCard;
}

function startAssemblyCompletionPoll(jobId, assemblyId, contentType, hooks = {}) {
  const ASM_POLL_INTERVAL = 15000;
  const ASM_POLL_MAX = 120;
  let asmPollCount = 0;

  const poll = () => {
    asmPollCount++;
    const asmJob = assemblyJobs[assemblyId];
    if (!asmJob) {
      if (asmPollCount < ASM_POLL_MAX) setTimeout(poll, ASM_POLL_INTERVAL);
      return;
    }
    const isDone =
      asmJob.status === 'done' ||
      asmJob.status === 'manual_review' ||
      asmJob.status === 'failed';
    if (!isDone && asmPollCount < ASM_POLL_MAX) {
      setTimeout(poll, ASM_POLL_INTERVAL);
      return;
    }
    if (isDone) {
      persistAssemblyTerminalState(jobId, asmJob, { contentType, assemblyId, onPublished: hooks.onPublished });
    } else {
      logger.warn({ jobId, asmStatus: asmJob.status }, 'Assembly poll timed out — card not updated');
      nrEvent('AssemblyPersistSkipped', {
        jobId,
        assemblyId,
        contentType,
        asmStatus: asmJob.status || 'unknown',
        error: (asmJob.error || 'poll_timeout').slice(0, 500),
      });
    }
  };

  setTimeout(poll, ASM_POLL_INTERVAL);
}

function reconcileCreativeDesignSpec(job) {
  if (!job?.clipsOnly || !job?.compCreative?.preset) return job;
  const dsPreset = job.designSpec?.compCreative?.preset
    || job.designSpec?.chrome?.compCreativePreset
    || null;
  if (dsPreset === job.compCreative.preset) return job;
  try {
    const { buildClipCompDesignSpec } = require('./clip_comp');
    const clipCount = (job.orderedClipUrls || []).length
      || job.designSpec?.expectedClipCount
      || job.clipHookTitles?.length
      || 5;
    job.designSpec = buildClipCompDesignSpec({
      clipCount,
      sourceContentType: job.contentType || 'twitch-short',
      compCreative: job.compCreative,
      compCreativePreset: job.compCreative.preset,
      streamerHint: job.streamers?.[0] || job.compCreative?.hooks?.rankedList?.streamer || null,
    });
    job.whisperCaptionsExpected = job.compCreative?.captions?.whisper !== false
      && job.compCreative?.hooks?.mode !== 'hook_only';
  } catch (_e) { /* non-fatal */ }
  return job;
}

/** Fix cards stuck at status=assembling after Gate 3 fail (no active assembly job). */
function enrichFromRunMetrics(job) {
  if (!job?.id) return job;
  try {
    const metricFiles = fs.readdirSync(OUTPUT_DIR).filter(
      (f) => f.startsWith('run_metrics_asm_') && f.includes(job.id) && f.endsWith('.json')
    );
    if (!metricFiles.length) return job;
    metricFiles.sort();
    const data = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, metricFiles.pop()), 'utf8'));
    const g3 = (data.stages || []).find((s) => s.stage === 'Gate 3 QA');
    if (!g3) return job;

    const isAuxAssemblyMp4 = (f) => /_(logo|tickered|cold_open|credits_outro|with_logo)(_\d+)?\.mp4$/i.test(f);
    let matches = fs.readdirSync(OUTPUT_DIR).filter(
      (f) => f.includes(job.id) && f.endsWith('.mp4') && !/_cap\.mp4$/i.test(f) && !isAuxAssemblyMp4(f)
    );
    if (!matches.length) {
      matches = fs.readdirSync(OUTPUT_DIR).filter(
        (f) => f.includes(job.id) && f.endsWith('.mp4') && !isAuxAssemblyMp4(f)
      );
    }
    if (matches.length) {
      // Prefer newest valid final output — not largest (partial _logo.mp4 can be bigger + unplayable).
      matches.sort((a, b) => fs.statSync(path.join(OUTPUT_DIR, b)).mtimeMs - fs.statSync(path.join(OUTPUT_DIR, a)).mtimeMs);
      job.outputPath = path.join(OUTPUT_DIR, matches[0]);
      job.filename = matches[0];
      const port = process.env.PORT || 3000;
      job.localPreviewUrl = `http://localhost:${port}/download/${matches[0]}`;
      if (!job.driveUrl) job.finalUrl = job.localPreviewUrl;
    }

    job.gate3 = {
      score: g3.score ?? g3.gate3aScore ?? null,
      outcome: g3.outcome === 'pass' ? 'pass' : (g3.outcome || 'fail'),
      gate3aScore: g3.gate3aScore ?? null,
      gate3aOutcome: g3.gate3aOutcome || null,
      report: g3.outcome === 'pass'
        ? `Gate 3 passed (${g3.score ?? g3.gate3aScore}/100)`
        : (job.gate3?.report || `Gate 3 ${g3.outcome || 'fail'} (${g3.score ?? 'n/a'}/100)`),
      checkedAt: data.completedAt || new Date().toISOString(),
    };
    job.qaOutcome = g3.outcome === 'pass' ? 'pass' : (g3.outcome === 'manual_review' ? 'manual_review' : 'fail');

    if (g3.outcome === 'pass') {
      job.status = 'completed';
      job.assembledAt = job.assembledAt || data.completedAt || new Date().toISOString();
      if (!['awaiting_review', 'metadata_review', 'publish_scheduled', 'published'].includes(job.stage)) {
        job.stage = 'assembled';
      }
    } else if (g3.outcome === 'manual_review') {
      job.status = 'completed';
      job.assembledAt = job.assembledAt || data.completedAt || new Date().toISOString();
      if (!['awaiting_review', 'metadata_review', 'publish_scheduled', 'published'].includes(job.stage)) {
        job.stage = 'awaiting_review';
      }
    } else if (job.status === 'assembling') {
      job.status = 'gate3_failed';
    }
  } catch (_e) { /* non-fatal */ }
  return job;
}

function reconcileStuckAssemblingJob(job) {
  job = reconcileCreativeDesignSpec(enrichFromRunMetrics({ ...job }));
  if (!job || job.status !== 'assembling') return job;

  const asmId = job.assemblyId;
  const asmJob = asmId ? assemblyJobs[asmId] : null;
  if (asmJob && !['done', 'failed', 'cancelled'].includes(asmJob.status)) {
    return job;
  }

  let outputPath = job.outputPath;
  if (!outputPath && job.filename) outputPath = path.join(OUTPUT_DIR, job.filename);
  if (!outputPath && job.id) {
    try {
      const isAuxAssemblyMp4 = (f) => /_(logo|tickered|cold_open|credits_outro|with_logo)(_\d+)?\.mp4$/i.test(f);
      let matches = fs.readdirSync(OUTPUT_DIR).filter(
        (f) => f.includes(job.id) && f.endsWith('.mp4') && !/_cap\.mp4$/i.test(f) && !isAuxAssemblyMp4(f)
      );
      if (!matches.length) {
        matches = fs.readdirSync(OUTPUT_DIR).filter(
          (f) => f.includes(job.id) && f.endsWith('.mp4') && !isAuxAssemblyMp4(f)
        );
      }
      if (matches.length) {
        matches.sort((a, b) => {
          const ma = fs.statSync(path.join(OUTPUT_DIR, a)).mtimeMs;
          const mb = fs.statSync(path.join(OUTPUT_DIR, b)).mtimeMs;
          return mb - ma;
        });
        outputPath = path.join(OUTPUT_DIR, matches[0]);
      }
    } catch (_e) { /* non-fatal */ }
  }
  if (!outputPath || !fs.existsSync(outputPath)) return job;

  job.outputPath = outputPath;
  job.filename = path.basename(outputPath);
  const port = process.env.PORT || 3000;
  job.localPreviewUrl = `http://localhost:${port}/download/${job.filename}`;
  job.finalUrl = job.localPreviewUrl;
  job.status = 'gate3_failed';
  job.qaOutcome = job.qaOutcome || 'fail';
  if (!job.gate3) {
    job.gate3 = {
      score: null,
      outcome: 'fail',
      report: 'Assembly finished but Gate 3 Gemini QA did not run (server restart or poll timeout). MP4 is on disk — preview it, then use RE-ASSEMBLE FROM FILES only if you need a fresh Gate 3 pass (no QA spec change required).',
      checkedAt: new Date().toISOString(),
    };
  } else if (job.gate3.outcome === 'fail' && !job.gate3.score && String(job.gate3.report || '').includes('stuck in assembling')) {
    job.gate3.report = 'Assembly finished but Gate 3 Gemini QA did not run (server restart or poll timeout). MP4 is on disk — preview it, then RE-ASSEMBLE FROM FILES only if you need a fresh Gate 3 pass.';
  }
  return job;
}

module.exports = {
  persistAssemblyTerminalState,
  startAssemblyCompletionPoll,
  reconcileStuckAssemblingJob,
  reconcileCreativeDesignSpec,
  localPreviewUrlFromAsm,
  buildGate3CardFields,
};
