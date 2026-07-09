'use strict';

const fs = require('fs');
const path = require('path');
const { persistedJobs, saveJobCard } = require('./job_card');
const { assemblyJobs } = require('./assembly');
const { nrEvent, nrAssemblyComplete } = require('./nr_events');
const pipelineBus = require('./pipeline_events');
const logger = require('./logger');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');

/** Strip hardcoded localhost host — dashboard may load from 127.0.0.1 (CORP blocks cross-host video). */
function normalizeStoredPreviewUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.startsWith('/download/')) return url;
  try {
    const u = new URL(url);
    if (u.pathname.startsWith('/download/')) return `${u.pathname}${u.search}`;
  } catch { /* ignore */ }
  return url;
}

function localPreviewUrlFromAsm(asmJob) {
  if (asmJob?.filename) {
    return `/download/${asmJob.filename}`;
  }
  if (asmJob?.outputPath && fs.existsSync(asmJob.outputPath)) {
    return `/download/${path.basename(asmJob.outputPath)}`;
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
  // CPD-1223: always refresh localPreviewUrl from this run's output file. When a run
  // had an R2 driveUrl the local URL was left untouched, so the dashboard (which
  // prefers localPreviewUrl) kept serving a previous run's file (r26 0-clip 3:18
  // avatar-only build shown while driveUrl already pointed at the full r27).
  const localFromRun = localPreviewUrlFromAsm(asmJob);
  if (localFromRun) finalCard.localPreviewUrl = localFromRun;
  if (preview) {
    if (preview.includes('/download/')) {
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
    const keepStaleDriveUrl = asmJob.qaOutcome !== 'fail' || !!asmJob.driveUrl;
    finalCard.state.savedOutputs = {
      ...(finalCard.state.savedOutputs || {}),
      publishCopy: asmJob.publishCopy,
      driveUrl: asmJob.driveUrl
        || (keepStaleDriveUrl ? finalCard.state.savedOutputs?.driveUrl : null)
        || null,
    };
    if (asmJob.qaOutcome === 'fail' && !asmJob.driveUrl) {
      delete finalCard.driveUrl;
    }
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
  const ASM_STALL_MS = 5 * 60 * 1000;
  let asmPollCount = 0;

  const poll = () => {
    asmPollCount++;
    const asmJob = assemblyJobs[assemblyId];

    if (asmJob && asmJob.status === 'running') {
      if (asmJob._pollLastPct == null) asmJob._pollLastPct = asmJob.pct;
      if (asmJob.pct !== asmJob._pollLastPct) {
        asmJob._pollLastPct = asmJob.pct;
        asmJob.lastProgressAt = Date.now();
      }
      const lastAt = asmJob.lastProgressAt || asmJob.startedAt || Date.now();
      const stallMs = (asmJob.pct != null && asmJob.pct >= 40) ? 15 * 60 * 1000 : ASM_STALL_MS;
      if (Date.now() - lastAt > stallMs && !asmJob._stallFailed) {
        asmJob._stallFailed = true;
        asmJob.status = 'failed';
        asmJob.error = `Assembly stalled — no progress for ${Math.round(stallMs / 60000)} minutes`;
        logger.warn({ jobId, assemblyId, lastProgressAt: lastAt }, asmJob.error);
        persistAssemblyTerminalState(jobId, asmJob, { contentType, assemblyId, onPublished: hooks.onPublished });
        return;
      }
    }

    if (!asmJob) {
      if (asmPollCount >= 4) {
        const card = global.persistedJobsRef?.[jobId];
        if (card && (card.status === 'assembling' || card.assemblyId === assemblyId)) {
          logger.warn({ jobId, assemblyId }, 'Assembly job missing from memory — marking failed');
          persistAssemblyTerminalState(
            jobId,
            { status: 'failed', error: 'Assembly job lost (server restart or crash during run)' },
            { contentType, assemblyId, onPublished: hooks.onPublished },
          );
          return;
        }
      }
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
      asmJob.status = 'failed';
      asmJob.error = asmJob.error || 'Assembly poll timed out after 30 minutes';
      logger.warn({ jobId, assemblyId, asmStatus: asmJob.status }, 'Assembly poll timed out — marking failed');
      persistAssemblyTerminalState(jobId, asmJob, { contentType, assemblyId, onPublished: hooks.onPublished });
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
      job.localPreviewUrl = `/download/${matches[0]}`;
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
    } else {
      if (job.localPreviewUrl || job.outputPath) {
        job.assembledAt = job.assembledAt || data.completedAt || new Date().toISOString();
        job.status = job.status === 'assembling' ? 'gate3_failed' : (job.status || 'gate3_failed');
        if (!['awaiting_review', 'metadata_review', 'publish_scheduled', 'published'].includes(job.stage)) {
          job.stage = 'awaiting_review';
        }
      } else if (job.status === 'assembling') {
        job.status = 'gate3_failed';
      }
    }
  } catch (_e) { /* non-fatal */ }
  return job;
}

const GATE3_MANUAL_REVIEW_REPORT = 'Assembly finished but Gate 3 Gemini QA did not run (server restart or poll timeout). MP4 is on disk — preview it. If it looks good, use APPROVE & PUBLISH; only RE-ASSEMBLE FROM FILES if you need a fresh Gate 3 pass.';

function isAuxAssemblyMp4(f) {
  return /_(logo|tickered|cold_open|credits_outro|with_logo)(_\d+)?\.mp4$/i.test(f);
}

function findJobFinalOutputPath(job) {
  if (!job) return null;
  let outputPath = job.outputPath;
  if (outputPath && fs.existsSync(outputPath)) return outputPath;
  if (job.filename) {
    outputPath = path.join(OUTPUT_DIR, job.filename);
    if (fs.existsSync(outputPath)) return outputPath;
  }
  const jobId = job.id || job.jobId;
  if (!jobId) return null;
  try {
    let matches = fs.readdirSync(OUTPUT_DIR).filter(
      (f) => f.includes(jobId) && f.endsWith('.mp4') && !/_cap\.mp4$/i.test(f) && !isAuxAssemblyMp4(f)
    );
    if (!matches.length) {
      matches = fs.readdirSync(OUTPUT_DIR).filter(
        (f) => f.includes(jobId) && f.endsWith('.mp4') && !isAuxAssemblyMp4(f)
      );
    }
    if (!matches.length) return null;
    matches.sort((a, b) => {
      const ma = fs.statSync(path.join(OUTPUT_DIR, a)).mtimeMs;
      const mb = fs.statSync(path.join(OUTPUT_DIR, b)).mtimeMs;
      return mb - ma;
    });
    outputPath = path.join(OUTPUT_DIR, matches[0]);
    return fs.existsSync(outputPath) ? outputPath : null;
  } catch (_e) {
    return null;
  }
}

function wireAssemblyOutputToJob(job, outputPath) {
  job.outputPath = outputPath;
  job.filename = path.basename(outputPath);
  job.localPreviewUrl = `/download/${job.filename}`;
  job.finalUrl = job.localPreviewUrl;
  job.status = 'completed';
  job.assembledAt = job.assembledAt || new Date().toISOString();
  job.qaOutcome = job.qaOutcome === 'pass' ? 'pass' : 'manual_review';
  if (!job.gate3) {
    job.gate3 = {
      score: null,
      outcome: 'manual_review',
      report: GATE3_MANUAL_REVIEW_REPORT,
      checkedAt: new Date().toISOString(),
    };
  } else if (job.gate3.outcome === 'fail' && !job.gate3.score && String(job.gate3.report || '').includes('stuck in assembling')) {
    job.gate3.outcome = 'manual_review';
    job.gate3.report = GATE3_MANUAL_REVIEW_REPORT.replace('FROM FILES', '');
  } else if (job.gate3.outcome === 'fail' && !job.gate3.score && String(job.gate3.report || '').includes('did not run')) {
    job.gate3.outcome = 'manual_review';
  }
  if (!job.stage || job.stage === 'assembling' || job.stage === 'heygen_done' || job.stage === 'all_sent') {
    job.stage = 'awaiting_review';
  }
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

  const outputPath = findJobFinalOutputPath(job);
  if (!outputPath) return job;
  return wireAssemblyOutputToJob(job, outputPath);
}

/** FFmpeg finished but card lost preview link after restart (e.g. stage still heygen_done). */
function reconcileOrphanAssemblyOutput(job) {
  if (!job || job.assembledAt || job.driveUrl) return job;
  const jobId = job.id || job.jobId;
  if (!jobId) return job;
  const postHeygen = ['heygen_done', 'all_sent', 'script_ready'].includes(job.stage || '');
  const gate3WithOutput = job.status === 'gate3_failed' && !job.assembledAt;
  if (!gate3WithOutput && job.localPreviewUrl) return job;
  if (!postHeygen && job.status !== 'assembling' && !gate3WithOutput) return job;

  const outputPath = findJobFinalOutputPath(job);
  if (!outputPath) return job;

  try {
    const stat = fs.statSync(outputPath);
    if (stat.size < 500_000) return job;
  } catch (_e) {
    return job;
  }

  return wireAssemblyOutputToJob({ ...job }, outputPath);
}

function probeDurationSecSync(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return 0;
  try {
    const { execFileSync } = require('child_process');
    const { ffprobePath } = require('./ffmpeg_utils');
    const bin = process.env.FFPROBE_PATH
      || (process.env.USE_LOCAL_FFMPEG ? 'ffprobe' : null)
      || (fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : ffprobePath());
    const out = execFileSync(bin, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ], { encoding: 'utf8', timeout: 30000 });
    const d = parseFloat(String(out || '').trim());
    return Number.isFinite(d) ? d : 0;
  } catch (_e) {
    return 0;
  }
}

/** Mark credits appended when final MP4 duration includes outro (post-restart recovery). */
function reconcileCreditsOutroFromDuration(job) {
  if (!job || job.creditsOutroAppended) return job;
  const ct = String(job.contentType || job.type || '');
  const isShort = ct.includes('-short') || job.clipsOnly || job.formType === 'short';
  if (!ct.includes('twitch') || isShort) return job;
  const outputPath = job.outputPath || findJobFinalOutputPath(job);
  if (!outputPath) return job;
  const dur = probeDurationSecSync(outputPath);
  const { TWITCH_SOUP_MIN_WITH_CREDITS_SEC } = require('./twitch_bookends');
  if (dur >= TWITCH_SOUP_MIN_WITH_CREDITS_SEC) {
    job.creditsOutroAppended = true;
    job.creditsOutroDurationSec = job.creditsOutroDurationSec || 30;
    job.outputPath = outputPath;
    if (!job.filename) job.filename = path.basename(outputPath);
  }
  return job;
}
function reconcileLostAssemblyFailure(job) {
  if (!job || job.assembledAt || job.driveUrl || job.localPreviewUrl) return job;
  const err = String(job.assemblyError || '');
  const lost = /lost|restart|crash during run|stalled/i.test(err);
  const preOutput = ['heygen_done', 'all_sent', 'script_ready', 'gate1_failed'].includes(job.stage || '');
  if (job.status === 'failed' && lost && preOutput) {
    job.status = job.stage === 'all_sent' ? 'all_sent' : 'completed';
    delete job.assemblyError;
    if (job.stage === 'assembling') job.stage = 'heygen_done';
  } else if (job.status === 'failed' && lost && !job.driveUrl && !job.assembledAt) {
    job.status = 'all_sent';
    job.stage = job.stage || 'heygen_done';
    delete job.assemblyError;
  }
  return job;
}

module.exports = {
  persistAssemblyTerminalState,
  startAssemblyCompletionPoll,
  reconcileStuckAssemblingJob,
  reconcileOrphanAssemblyOutput,
  reconcileCreditsOutroFromDuration,
  reconcileLostAssemblyFailure,
  findJobFinalOutputPath,
  wireAssemblyOutputToJob,
  reconcileCreativeDesignSpec,
  localPreviewUrlFromAsm,
  normalizeStoredPreviewUrl,
  buildGate3CardFields,
};
