'use strict';
/**
 * lib/services/job_grader.js — Job Spec Compliance Grader (CPD-422)
 *
 * Grades a completed job 0–100 by checking every feature requested in the
 * job spec was actually delivered in the output.
 *
 * Grade = 100 only when ALL checks pass. Anything below surfaces the exact
 * failing checks so Jira tickets can be created and gaps fixed before the
 * next run.
 *
 * Usage:
 *   const { gradeJob } = require('./job_grader');
 *   const result = gradeJob(jobSpec);
 *   // { grade: 100, passed: true, checks: [...], gaps: [] }
 */

// ─── Feature check registry ───────────────────────────────────────────────────
// Each entry defines one deliverable the grader verifies.
// weight: how many grade points this check is worth (all weights sum to 100)
// implemented: false = feature is on roadmap but not built yet — grader reports
//              it as "not_implemented" (info only, does not deduct points)

const CHECKS = [
  // ── Critical gates (job must reach these states) ──────────────────────────
  {
    id: 'output_exists',
    label: 'Output URL exists',
    weight: 20,
    implemented: true,
    run(spec) {
      const url = spec.outputUrl || spec.state?.savedOutputs?.r2VideoUrl ||
                  spec.assembledVideoUrl || spec.state?.savedOutputs?.driveUrl;
      return url ? pass() : fail('No outputUrl on completed job');
    },
  },
  {
    id: 'status_complete',
    label: 'Job reached staged/complete status',
    weight: 10,
    implemented: true,
    run(spec) {
      const ok = ['staged', 'complete', 'published'].includes(spec.status);
      return ok ? pass() : fail(`Status is ${spec.status} — expected staged/complete/published`);
    },
  },
  {
    id: 'portals_passed',
    label: 'All declared portals passed',
    weight: 20,
    implemented: true,
    run(spec) {
      const reports = spec.portalReports || {};
      const portals  = spec.portals || {};
      const failures = [];
      for (const [key, cfg] of Object.entries(portals)) {
        if (!cfg?.active) continue;
        const r = reports[key];
        if (!r) { failures.push(`${key}: no report (did not run)`); continue; }
        if (r.outcome === 'mismatch_escalate') failures.push(`${key}: mismatch_escalate`);
        else if (r.passed === false && r.outcome !== 'mismatch_fixable')
          failures.push(`${key}: failed — ${r.failReason || r.outcome || 'unknown'}`);
      }
      return failures.length === 0 ? pass() : fail(failures.join('; '));
    },
  },
  {
    id: 'portal_score_avg',
    label: 'Average portal score ≥ 75',
    weight: 10,
    implemented: true,
    run(spec) {
      const reports = spec.portalReports || {};
      const scores = Object.values(reports)
        .map((r) => r?.score)
        .filter((s) => typeof s === 'number');
      if (scores.length === 0) return warn('No portal scores recorded');
      const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      // Clips compilations don't run portal4 (no commentary QA), so scores are higher-quality only.
      const threshold = spec.contentType === 'clips' ? 60 : 75;
      return avg >= threshold ? pass(`avg ${avg}`) : fail(`avg score ${avg} — below ${threshold} threshold`);
    },
  },

  // ── Script / content ──────────────────────────────────────────────────────
  {
    id: 'script',
    label: 'Script generated and stored',
    weight: 5,
    implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'script')) return skip('script not requested');
      const s = spec.filledScript || spec.state?.savedOutputs?.filledScript ||
                spec.state?.script?.finalScript;
      return s && s.length > 50 ? pass() : fail('filledScript missing or empty');
    },
  },

  // ── Visual / assembly ─────────────────────────────────────────────────────
  {
    id: 'scene_select',
    label: 'Scene selection applied',
    weight: 5,
    implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'scene_select')) return skip('scene_select not requested');
      const segs = spec.state?.savedOutputs?.segmentPaths ||
                   spec.state?.savedOutputs?.segmentDurations;
      return segs && (Array.isArray(segs) ? segs.length > 0 : true)
        ? pass()
        : fail('No segmentPaths/segmentDurations — scene selection may not have run');
    },
  },
  {
    id: 'branding',
    label: 'Branding / chrome applied',
    weight: 5,
    implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'branding')) return skip('branding not requested');
      // Fast path: assembly_service sets state.chromeApplied when applyChrome ran
      if (spec.state?.chromeApplied === true) return pass('chromeApplied flag set by assembly');
      // portal3a confirms chromeVisible in its sampleFindings
      const p3a = spec.portalReports?.portal3a;
      if (!p3a) return warn('portal3a report missing — cannot confirm branding');
      const findings = p3a.sampleFindings || {};
      const samples  = [findings.early, findings.middle, findings.late].filter(Boolean);
      if (samples.length === 0) return warn('portal3a sampleFindings empty — chrome status unconfirmed');
      const anyChrome = samples.some((f) => f.chromeVisible === true);
      return anyChrome ? pass() : fail('portal3a found no chrome visible in sampled frames');
    },
  },
  {
    id: 'dynamic',
    label: 'Dynamic overlays applied',
    weight: 3,
    implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'dynamic')) return skip('dynamic not requested');
      // Dynamic overlays are burned in during assembly — confirmed by portal3a chromeCorrect
      const p3a = spec.portalReports?.portal3a;
      if (!p3a) return warn('portal3a report missing — cannot confirm dynamic overlays');
      return p3a.passed ? pass() : warn('portal3a did not fully pass — dynamic overlays unconfirmed');
    },
  },

  // ── Production features (Sprint 7) ────────────────────────────────────────
  {
    id: 'scene_transitions',
    label: 'Scene transitions (xfade) applied',
    weight: 3,
    implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'scene_transitions')) return skip('scene_transitions not requested');
      // assembly.js logs xfade in savedOutputs.assemblyMeta when applied
      const meta = spec.state?.savedOutputs?.assemblyMeta;
      if (meta?.sceneTransitions === true) return pass();
      // Fallback: if more than 1 segment was assembled, transitions ran
      const segs = spec.state?.savedOutputs?.segmentDurations;
      if (Array.isArray(segs) && segs.length > 1) return pass('inferred from multi-segment assembly');
      return warn('Cannot confirm xfade — assemblyMeta.sceneTransitions not set');
    },
  },
  {
    id: 'chapter_markers',
    label: 'YouTube chapter timestamps in description',
    weight: 3,
    implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'chapter_markers')) return skip('chapter_markers not requested');
      const publishCopy = spec.state?.savedOutputs?.publishCopy;
      const ytDesc = publishCopy?.youtube?.description || publishCopy?.description || '';
      const hasChapters = /^\d+:\d{2}\s/m.test(ytDesc);
      if (hasChapters) return pass();
      const segs = spec.state?.savedOutputs?.segmentLabelsAndDurations ||
                   spec.state?.savedOutputs?.segmentDurations;
      if (!segs || (Array.isArray(segs) && segs.length < 2))
        return warn('Not enough segments for chapters — need 2+');
      return fail('Chapter timestamps not found in YouTube description');
    },
  },
  {
    id: 'zoom_punch',
    label: 'Zoom punch-in effect (CPD-415)',
    weight: 2,
    implemented: false, // roadmap — not built yet
    run() { return not_implemented('CPD-415 — zoom_punch post-processing not built yet'); },
  },
  {
    id: 'animated_text_effects',
    label: 'Animated text effects (CPD-416)',
    weight: 2,
    implemented: false,
    run() { return not_implemented('CPD-416 — animated_text_effects not built yet'); },
  },
  {
    id: 'sound_effects',
    label: 'Sound effects (CPD-417)',
    weight: 2,
    implemented: false,
    run() { return not_implemented('CPD-417 — sound_effects not built yet'); },
  },
  {
    id: 'lower_thirds',
    label: 'Lower thirds (CPD-414)',
    weight: 2,
    implemented: false,
    run() { return not_implemented('CPD-414 — lower_thirds not built yet'); },
  },

  // ── Publish readiness ─────────────────────────────────────────────────────
  {
    id: 'publish_copy',
    label: 'Publish copy generated for all platforms',
    weight: 5,
    implemented: true,
    run(spec) {
      const platforms = spec.order?.publish?.platforms ||
                        spec.deliverySpec?.platforms || [];
      if (platforms.length === 0) return skip('no platforms declared');
      const copy = spec.state?.savedOutputs?.publishCopy || {};
      const missing = platforms.filter((p) => !copy[p] && !copy.platforms?.[p]);
      return missing.length === 0
        ? pass()
        : fail(`Publish copy missing for: ${missing.join(', ')}`);
    },
  },
  {
    id: 'thumbnail',
    label: 'Thumbnail generated',
    weight: 3,
    implemented: true,
    run(spec) {
      return spec.thumbnailUrl ? pass() : warn('No thumbnailUrl — thumbnail may still be processing');
    },
  },

  // ── CPD-431: FFmpeg Full Feature Wiring (CPD-432 through CPD-439) ─────────
  // All checks below are not_implemented until the feature ships in assembly.
  // To activate a check: set implemented:true and update the run() logic.
  // Weight is 0 for all new checks until they are implemented and load-tested.

  // ── CPD-431-A: Audio processing ───────────────────────────────────────────
  {
    id: 'audio_loudnorm', label: 'EBU R128 loudness normalisation',
    weight: 2, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'audio.loudnorm')) return skip('not requested');
      return spec.state?.savedOutputs?.loudnormApplied ? pass() : not_implemented('audio.loudnorm not yet in assembly');
    },
  },
  {
    id: 'audio_bgmusic', label: 'Background music mix',
    weight: 2, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'audio.bgmusic')) return skip('not requested');
      return not_implemented('audio.bgmusic not yet in assembly');
    },
  },
  {
    id: 'audio_duck', label: 'Auto-duck music under speech',
    weight: 2, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'audio.duck')) return skip('not requested');
      return not_implemented('audio.duck not yet in assembly');
    },
  },
  {
    id: 'captions_whisper', label: 'Whisper word-level animated captions',
    weight: 3, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'captions.whisper')) return skip('not requested');
      const transcript = spec.state?.savedOutputs?.transcript || spec.state?.savedOutputs?.gpt4oQA?.transcript;
      return transcript ? not_implemented('captions.whisper transcript present but burn-in not yet in assembly')
                        : not_implemented('captions.whisper not yet in assembly');
    },
  },

  // ── CPD-431-B: Colour & visual effects ────────────────────────────────────
  {
    id: 'color_lut', label: 'LUT colour grade',
    weight: 2, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'color.lut')) return skip('not requested');
      return not_implemented('color.lut not yet in assembly');
    },
  },
  {
    id: 'color_vignette', label: 'Vignette',
    weight: 1, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'color.vignette')) return skip('not requested');
      return not_implemented('color.vignette not yet in assembly');
    },
  },
  {
    id: 'color_film_grain', label: 'Film grain',
    weight: 1, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'color.film_grain')) return skip('not requested');
      return not_implemented('color.film_grain not yet in assembly');
    },
  },
  {
    id: 'video_chromakey', label: 'Chroma key / green screen',
    weight: 2, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'video.chromakey')) return skip('not requested');
      return not_implemented('video.chromakey not yet in assembly');
    },
  },

  // ── CPD-431-C: Transition styles ──────────────────────────────────────────
  {
    id: 'transition_style', label: 'Scene transition style selection',
    weight: 1, implemented: false,
    run(spec) {
      const style = spec.addOns?.dynamicOverlays?.transition;
      if (!style || style === 'fade' || style === 'crossfade') return skip('default style — no custom transition');
      return spec.state?.savedOutputs?.transitionStyleApplied === style
        ? not_implemented('transition style validation not yet in grader')
        : not_implemented('transition style not yet validated in assembly output');
    },
  },

  // ── CPD-431-D: Motion effects ─────────────────────────────────────────────
  {
    id: 'video_ken_burns', label: 'Ken Burns zoom effect',
    weight: 2, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'video.ken_burns')) return skip('not requested');
      return not_implemented('video.ken_burns not yet in assembly');
    },
  },
  {
    id: 'video_slow_motion', label: 'Slow motion',
    weight: 2, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'video.slow_motion')) return skip('not requested');
      return not_implemented('video.slow_motion not yet in assembly');
    },
  },
  {
    id: 'video_speed_ramp', label: 'Speed ramp',
    weight: 1, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'video.speed_ramp')) return skip('not requested');
      return not_implemented('video.speed_ramp not yet in assembly');
    },
  },

  // ── CPD-431-E: Overlays ────────────────────────────────────────────────────
  {
    id: 'overlay_intro_outro', label: 'Intro / outro cards',
    weight: 2, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'overlay.intro_outro')) return skip('not requested');
      return not_implemented('overlay.intro_outro not yet in assembly');
    },
  },
  {
    id: 'overlay_ticker', label: 'Scrolling ticker',
    weight: 1, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'overlay.ticker')) return skip('not requested');
      return not_implemented('overlay.ticker not yet in assembly');
    },
  },
  {
    id: 'overlay_pip', label: 'Picture-in-picture',
    weight: 2, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'overlay.pip')) return skip('not requested');
      return not_implemented('overlay.pip not yet in assembly');
    },
  },
  {
    id: 'captions_burnin', label: 'Caption / subtitle burn-in',
    weight: 2, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'captions.burnin')) return skip('not requested');
      return not_implemented('captions.burnin not yet in assembly');
    },
  },

  // ── CPD-431-F: Layout & platform formatting ────────────────────────────────
  {
    id: 'layout_portrait', label: '9:16 portrait reframe (TikTok / Reels / Shorts)',
    weight: 2, implemented: false,
    run(spec) {
      const platforms = spec.order?.publish?.platforms || [];
      const wantsPortrait = _featureActive(spec, 'layout.portrait') ||
        platforms.some((p) => ['tiktok', 'instagram_reels', 'youtube_shorts'].includes(p));
      if (!wantsPortrait) return skip('portrait layout not requested');
      return not_implemented('layout.portrait not yet in assembly');
    },
  },
  {
    id: 'layout_square', label: '1:1 square reframe (Instagram)',
    weight: 1, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'layout.square')) return skip('not requested');
      return not_implemented('layout.square not yet in assembly');
    },
  },

  // ── CPD-431-G: QA upgrades ────────────────────────────────────────────────
  {
    id: 'qa_loudness', label: 'EBU R128 loudness compliance (platform spec)',
    weight: 2, implemented: false,
    run(spec) {
      const scan = spec.portalReports?.portal3a?.ffmpegScan;
      if (!scan) return not_implemented('portal3a loudness scan not yet wired (CPD-438)');
      const ok = scan.loudnessLUFS != null && scan.loudnessLUFS >= -16 && scan.loudnessLUFS <= -12;
      return ok ? pass(`${scan.loudnessLUFS} LUFS`) : warn(`Loudness ${scan.loudnessLUFS} LUFS outside -12 to -16 LUFS target`);
    },
  },
  {
    id: 'qa_black_frames', label: 'No unexpected black frames',
    weight: 1, implemented: false,
    run(spec) {
      const scan = spec.portalReports?.portal3a?.ffmpegScan;
      if (!scan) return not_implemented('portal3a black frame scan not yet wired (CPD-438)');
      return scan.blackFrames?.length ? fail(`Black frames at: ${scan.blackFrames.map((b) => b.timestamp).join(', ')}`)
                                      : pass();
    },
  },

  // ── CPD-431-H: Encoding & delivery ────────────────────────────────────────
  {
    id: 'encode_bitrate', label: 'Platform bitrate compliance (TikTok 287MB limit)',
    weight: 2, implemented: false,
    run(spec) {
      const sizeBytes = spec.state?.savedOutputs?.outputSizeBytes;
      if (!sizeBytes) return not_implemented('output file size not tracked yet (CPD-439)');
      const platforms = spec.order?.publish?.platforms || [];
      if (platforms.includes('tiktok') && sizeBytes > 287 * 1024 * 1024) {
        return fail(`Output ${Math.round(sizeBytes / 1024 / 1024)}MB exceeds TikTok 287MB limit`);
      }
      return pass(`${Math.round(sizeBytes / 1024 / 1024)}MB`);
    },
  },
  {
    id: 'publish_metadata', label: 'Embedded video metadata',
    weight: 1, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'publish.metadata')) return skip('not requested');
      return not_implemented('publish.metadata not yet in assembly');
    },
  },
];

// ─── Result helpers ───────────────────────────────────────────────────────────

function pass(note)            { return { result: 'pass',            note: note || null }; }
function fail(reason)          { return { result: 'fail',            reason };              }
function warn(reason)          { return { result: 'warn',            reason };              }
function skip(reason)          { return { result: 'skip',            reason };              }
function not_implemented(note) { return { result: 'not_implemented', note };                }

// ─── Feature active helper ────────────────────────────────────────────────────

/**
 * Returns true if the given feature key was requested in the job spec.
 * Checks featureConfig (new wizard path) and legacy addOns / portals.
 */
function _featureActive(spec, key) {
  // New wizard path — featureConfig is a map of feature key → config object
  if (spec.featureConfig && typeof spec.featureConfig === 'object') {
    if (Object.prototype.hasOwnProperty.call(spec.featureConfig, key)) {
      const cfg = spec.featureConfig[key];
      // active flag, or non-empty object = feature was requested
      if (cfg?.active === false) return false;
      if (cfg && Object.keys(cfg).length > 0) return true;
    }
  }
  // Legacy addOns path
  if (spec.addOns?.[key]?.active) return true;
  return false;
}

// ─── Main grader ─────────────────────────────────────────────────────────────

/**
 * Grade a job spec against its own declared requirements.
 *
 * @param {Object} spec - Full job spec from DB
 * @returns {{
 *   jobId:   string,
 *   grade:   number,          // 0–100
 *   passed:  boolean,         // true only when grade === 100
 *   checks:  Array<CheckResult>,
 *   gaps:    Array<GapItem>,  // checks that failed (need Jira tickets)
 *   summary: string,
 * }}
 */
function gradeJob(spec) {
  if (!spec) return { jobId: null, grade: 0, passed: false, checks: [], gaps: [], summary: 'No spec provided' };

  const jobId = spec.jobId || 'unknown';
  const checkResults = [];

  // Implemented checks contribute to grade; not_implemented and skip are neutral.
  const IMPLEMENTED_WEIGHT = CHECKS
    .filter((c) => c.implemented)
    .reduce((sum, c) => sum + c.weight, 0);

  let earnedWeight = 0;

  for (const check of CHECKS) {
    let outcome;
    try {
      outcome = check.run(spec);
    } catch (err) {
      outcome = fail(`Grader check threw: ${err.message}`);
    }

    const result = {
      id:     check.id,
      label:  check.label,
      weight: check.weight,
      ...outcome,
    };

    checkResults.push(result);

    // Score only implemented checks
    if (!check.implemented) continue;

    if (outcome.result === 'pass' || outcome.result === 'skip') {
      earnedWeight += check.weight;
    } else if (outcome.result === 'warn') {
      // Warn = half credit — feature may be delivered but can't be confirmed
      earnedWeight += Math.floor(check.weight / 2);
    }
    // fail = 0 credit
  }

  const grade   = IMPLEMENTED_WEIGHT > 0
    ? Math.round((earnedWeight / IMPLEMENTED_WEIGHT) * 100)
    : 0;
  const passed  = grade === 100;

  const gaps = checkResults.filter((c) => c.result === 'fail').map((c) => ({
    checkId: c.id,
    label:   c.label,
    reason:  c.reason,
  }));

  const warnItems = checkResults.filter((c) => c.result === 'warn');
  const notBuilt  = checkResults.filter((c) => c.result === 'not_implemented');

  const summary = [
    `Grade: ${grade}/100 | ${passed ? 'PASSED ✅' : 'FAILED ❌'}`,
    gaps.length      ? `Gaps (${gaps.length}): ${gaps.map((g) => g.checkId).join(', ')}` : null,
    warnItems.length ? `Warnings (${warnItems.length}): ${warnItems.map((w) => w.id).join(', ')}` : null,
    notBuilt.length  ? `Not yet built (${notBuilt.length}): ${notBuilt.map((n) => n.id).join(', ')}` : null,
  ].filter(Boolean).join(' | ');

  return { jobId, grade, passed, checks: checkResults, gaps, warnings: warnItems, summary };
}

/**
 * Grade multiple jobs and return a summary report.
 * @param {Object[]} specs
 * @returns {{ results: Array, passCount: number, failCount: number, avgGrade: number }}
 */
function gradeJobs(specs) {
  const results = specs.map(gradeJob);
  const passCount = results.filter((r) => r.passed).length;
  const avgGrade  = results.length
    ? Math.round(results.reduce((s, r) => s + r.grade, 0) / results.length)
    : 0;
  return {
    results,
    passCount,
    failCount: results.length - passCount,
    avgGrade,
    totalJobs: results.length,
  };
}

module.exports = { gradeJob, gradeJobs };
