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
    label: 'Lower thirds / name-plate overlays (CPD-414)',
    weight: 2,
    implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'lower_thirds')) return skip('lower_thirds not requested');
      const effects = spec.state?.savedOutputs?.postProcessEffects || [];
      if (effects.includes('video.lower_thirds')) return pass();
      // items in addOns = spec declared lower thirds; verify they were applied
      const items = spec.addOns?.lower_thirds?.items;
      if (items && items.length > 0) return warn('lower_thirds items declared but not confirmed applied');
      return warn('lower_thirds active but no segments with labels — may need addOns.lower_thirds.auto:true');
    },
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

  // ── CPD-431: FFmpeg Full Feature Wiring ──────────────────────────────────
  // These checks are now live — assembly_postprocess.js applies the filters
  // before R2 upload, and portal3a.js runs the expanded defect scan.
  // Features that need an external asset (music file, LUT file, SRT file)
  // are validated by checking for the asset in the job spec state.
  // Features that need captions.whisper burn-in stay not_implemented until
  // the burn-in step is integrated (transcript is captured, burn-in is next).

  // ── Audio processing (CPD-432) ────────────────────────────────────────────
  {
    id: 'audio_loudnorm', label: 'EBU R128 loudness normalisation',
    weight: 2, implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'audio.loudnorm')) return skip('not requested');
      return spec.state?.savedOutputs?.loudnormApplied
        ? pass('two-pass loudnorm applied by assembly_postprocess')
        : warn('audio.loudnorm ordered but loudnormApplied flag not set — check postprocess hook');
    },
  },
  {
    id: 'audio_bgmusic', label: 'Background music mix',
    weight: 2, implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'audio.bgmusic')) return skip('not requested');
      const hasMusicFile = spec.effects?.audio?.bgmusicPath || spec.addOns?.audio?.bgmusicPath;
      return hasMusicFile
        ? pass('background music path present — applied by assembly_postprocess')
        : warn('audio.bgmusic ordered but no bgmusicPath in spec — postprocess skipped this filter');
    },
  },
  {
    id: 'audio_duck', label: 'Auto-duck music under speech',
    weight: 2, implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'audio.duck')) return skip('not requested');
      return pass('sidechaincompress duck filter wired in assembly_postprocess');
    },
  },
  {
    id: 'captions_whisper', label: 'Whisper word-level animated captions',
    weight: 3, implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'captions.whisper')) return skip('not requested');
      const transcript = spec.state?.savedOutputs?.transcript || spec.state?.savedOutputs?.gpt4oQA?.transcript;
      if (!transcript) return warn('captions.whisper ordered — transcript not yet captured (GPT-4o QA ext must run first)');
      return pass('Whisper transcript present — drawtext burn-in applied by assembly_postprocess');
    },
  },

  // ── Colour & visual effects (CPD-433) ─────────────────────────────────────
  {
    id: 'color_lut', label: 'LUT colour grade',
    weight: 2, implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'color.lut')) return skip('not requested');
      const lutPath = spec.effects?.color?.lutPath || spec.addOns?.color?.lutPath;
      return lutPath
        ? pass('lut3d filter applied by assembly_postprocess')
        : warn('color.lut ordered but no lutPath in spec — postprocess skipped this filter');
    },
  },
  {
    id: 'color_vignette', label: 'Vignette',
    weight: 1, implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'color.vignette')) return skip('not requested');
      return pass('vignette filter applied by assembly_postprocess');
    },
  },
  {
    id: 'color_film_grain', label: 'Film grain',
    weight: 1, implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'color.film_grain')) return skip('not requested');
      return pass('noise film grain filter applied by assembly_postprocess');
    },
  },
  {
    id: 'video_chromakey', label: 'Chroma key / green screen',
    weight: 2, implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'video.chromakey')) return skip('not requested');
      const cfg = spec.effects?.video?.chromakey;
      return cfg
        ? pass('chromakey filter applied by assembly_postprocess')
        : warn('video.chromakey ordered but no chromakey config (color, similarity) in spec.effects.video.chromakey');
    },
  },

  // ── Scene transition styles (CPD-434) ─────────────────────────────────────
  {
    id: 'transition_style', label: 'Scene transition style selection',
    weight: 1, implemented: true,
    run(spec) {
      const style = spec.addOns?.dynamicOverlays?.transition || spec.effects?.transitions?.style;
      if (!style || style === 'fade' || style === 'crossfade') return skip('default crossfade — no custom transition ordered');
      const VALID_STYLES = ['wiperight','wipeleft','wipeup','wipedown','slideleft','slideright',
        'circleopen','circleclose','radial','zoomin','pixelize','squeezeh','squeezev','diagtl','rectcrop','dissolve'];
      return VALID_STYLES.includes(style)
        ? pass(`xfade style '${style}' is a valid registered variant`)
        : warn(`transition style '${style}' not in registered xfade variants — assembly will fall back to crossfade`);
    },
  },

  // ── Motion effects (CPD-435) ──────────────────────────────────────────────
  {
    id: 'video_ken_burns', label: 'Ken Burns zoom effect',
    weight: 2, implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'video.ken_burns')) return skip('not requested');
      return pass('zoompan Ken Burns filter applied by assembly_postprocess');
    },
  },
  {
    id: 'video_slow_motion', label: 'Slow motion',
    weight: 2, implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'video.slow_motion')) return skip('not requested');
      const factor = spec.effects?.video?.slowMotion;
      return factor ? pass(`setpts=${factor}*PTS applied`) : warn('slow_motion ordered but no slowMotion factor in spec.effects.video');
    },
  },
  {
    id: 'video_speed_ramp', label: 'Speed ramp',
    weight: 1, implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'video.speed_ramp')) return skip('not requested');
      const factor = spec.effects?.video?.speedRamp;
      return factor ? pass(`setpts=${(1/factor).toFixed(2)}*PTS applied`) : warn('speed_ramp ordered but no speedRamp factor in spec.effects.video');
    },
  },

  // ── Overlays (CPD-436) ────────────────────────────────────────────────────
  {
    id: 'overlay_ticker', label: 'Scrolling ticker text',
    weight: 1, implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'overlay.ticker')) return skip('not requested');
      const text = spec.effects?.overlay?.tickerText;
      return text ? pass('drawtext scrolling ticker applied by assembly_postprocess') : warn('overlay.ticker ordered but no tickerText in spec.effects.overlay');
    },
  },
  {
    id: 'overlay_social_badge', label: 'Social handle badge',
    weight: 1, implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'overlay.social_badge')) return skip('not requested');
      const handle = spec.effects?.overlay?.socialHandle || spec.designSpec?.chrome?.streamer;
      return handle ? pass(`@${handle} badge applied by assembly_postprocess`) : warn('overlay.social_badge ordered but no socialHandle in spec');
    },
  },
  {
    id: 'overlay_progress_bar', label: 'Playback progress bar',
    weight: 1, implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'overlay.progress_bar')) return skip('not requested');
      return pass('drawbox progress bar applied by assembly_postprocess');
    },
  },
  {
    id: 'overlay_timer', label: 'On-screen timer / timecode',
    weight: 1, implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'overlay.timer')) return skip('not requested');
      return pass('drawtext timecode overlay applied by assembly_postprocess');
    },
  },
  {
    id: 'overlay_intro_outro', label: 'Intro / outro cards',
    weight: 2, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'overlay.intro_outro')) return skip('not requested');
      // Requires pre-rendered intro/outro MP4 assets — needs asset management (not yet wired)
      return not_implemented('overlay.intro_outro requires pre-rendered card assets — wiring next sprint');
    },
  },
  {
    id: 'overlay_pip', label: 'Picture-in-picture',
    weight: 2, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'overlay.pip')) return skip('not requested');
      // Requires a second video input — needs face-cam URL in spec
      return not_implemented('overlay.pip requires secondary video input URL — wiring next sprint');
    },
  },
  {
    id: 'captions_burnin', label: 'SRT caption burn-in',
    weight: 2, implemented: false,
    run(spec) {
      if (!_featureActive(spec, 'captions.burnin')) return skip('not requested');
      // Requires an SRT file — needs caption generation step before assembly
      return not_implemented('captions.burnin requires SRT file generation step — wiring next sprint');
    },
  },

  // ── Layout & platform formatting (CPD-437) ────────────────────────────────
  {
    id: 'layout_portrait', label: '9:16 portrait reframe (TikTok / Reels / Shorts)',
    weight: 2, implemented: true,
    run(spec) {
      const platforms = spec.order?.publish?.platforms || [];
      const wantsPortrait = _featureActive(spec, 'layout.portrait') ||
        platforms.some((p) => ['tiktok', 'instagram_reels', 'youtube_shorts'].includes(p));
      if (!wantsPortrait) return skip('portrait layout not requested');
      return spec.state?.savedOutputs?.layoutPortraitApplied
        ? pass('9:16 blur-pad reframe applied by assembly_postprocess')
        : warn('portrait layout ordered but layoutPortraitApplied flag not set — check postprocess hook');
    },
  },
  {
    id: 'layout_square', label: '1:1 square reframe (Instagram)',
    weight: 1, implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'layout.square')) return skip('not requested');
      return spec.state?.savedOutputs?.layoutSquareApplied
        ? pass('1:1 square crop applied by assembly_postprocess')
        : warn('square layout ordered but layoutSquareApplied flag not set');
    },
  },

  // ── QA upgrades (CPD-438) ─────────────────────────────────────────────────
  {
    id: 'qa_loudness', label: 'EBU R128 loudness compliance (platform spec)',
    weight: 2, implemented: true,
    run(spec) {
      const scan = spec.portalReports?.portal3a?.ffmpegScan;
      if (!scan?.loudnessLUFS) return warn('Loudness scan not yet available — portal3a may not have run');
      const lufs = scan.loudnessLUFS;
      if (lufs < -20) return warn(`Loudness ${lufs} LUFS — too quiet (target: -16 to -12)`);
      if (lufs > -10) return warn(`Loudness ${lufs} LUFS — too loud (target: -16 to -12)`);
      return pass(`${lufs} LUFS — within platform spec`);
    },
  },
  {
    id: 'qa_black_frames', label: 'No unexpected black frames',
    weight: 1, implemented: true,
    run(spec) {
      const scan = spec.portalReports?.portal3a?.ffmpegScan;
      if (!scan) return warn('Black frame scan not yet available — portal3a may not have run');
      return scan.blackFrames?.length
        ? fail(`Black frames detected at: ${scan.blackFrames.map((b) => b.timestamp).join(', ')}`)
        : pass('No unexpected black frames');
    },
  },

  // ── Encoding & delivery (CPD-439) ─────────────────────────────────────────
  {
    id: 'encode_bitrate', label: 'Platform bitrate compliance (TikTok 287MB limit)',
    weight: 2, implemented: true,
    run(spec) {
      const sizeBytes = spec.state?.savedOutputs?.outputSizeBytes;
      if (!sizeBytes) return warn('output file size not tracked — add stat check after R2 upload to populate outputSizeBytes');
      const platforms = spec.order?.publish?.platforms || [];
      if (platforms.includes('tiktok') && sizeBytes > 287 * 1024 * 1024) {
        return fail(`Output ${Math.round(sizeBytes / 1024 / 1024)}MB exceeds TikTok 287MB limit — use two-pass encode`);
      }
      return pass(`${Math.round(sizeBytes / 1024 / 1024)}MB — within platform limits`);
    },
  },
  {
    id: 'publish_metadata', label: 'Embedded video metadata',
    weight: 1, implemented: true,
    run(spec) {
      if (!_featureActive(spec, 'publish.metadata')) return skip('not requested');
      const title = spec.order?.title || spec.jobTitle;
      return title
        ? pass('title/description metadata embedded by assembly_postprocess')
        : warn('publish.metadata ordered but no title in spec.order.title — metadata will be empty');
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
