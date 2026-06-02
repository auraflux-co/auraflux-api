#!/usr/bin/env node
'use strict';

/**
 * pipeline_parity_review.js — AuraFlux Full Ecosystem Health Review
 *
 * Three-layer review:
 *   Layer 1 — Pipeline parity: all three dispatch paths implement the same contract
 *   Layer 2 — Pipeline dependencies: everything the pipeline needs to run
 *   Layer 3 — Pipeline consumers: everything that needs the pipeline to be healthy
 *
 * Run:  node scripts/pipeline_parity_review.js
 * Output: logs/pipeline_parity_review_<date>.md
 */

const fs   = require('fs');
const path = require('path');

const ROOT    = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'logs');

// ── Helpers ───────────────────────────────────────────────────────────────────

function readFile(relPath) {
  const abs = path.join(ROOT, relPath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

function pass(msg)  { return { status: '✅', msg }; }
function fail(msg)  { return { status: '❌', msg }; }
function warn(msg)  { return { status: '⚠️ ', msg }; }

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — Pipeline parity
// ─────────────────────────────────────────────────────────────────────────────

function checkAssemblyWired() {
  const paths = {
    'developer_api.js': readFile('lib/routes/developer_api.js'),
    'jobs_c1.js':       readFile('lib/routes/jobs_c1.js'),
    'queue/worker.js':  readFile('lib/queue/worker.js'),
  };
  return Object.entries(paths).map(([file, src]) => {
    if (!src) return fail(`${file} not found`);
    return (src.includes('assembleForJob') || src.includes('pipeline_assembly') || src.includes('runAssemblyAndPostProcess'))
      ? pass(`${file}: assembly wired`)
      : fail(`${file}: assembly NOT called — jobs will produce no video`);
  });
}

function checkExtensionAdapterPassesJobSpec() {
  const src = readFile('lib/routes/jobs_c1.js');
  if (!src) return [fail('jobs_c1.js not found')];
  const fnBody = src.match(/function _resolveExtensionWorkers\s*\(([\s\S]*?)\{([\s\S]*?)\n\}/)?.[0] || '';
  return [fnBody.includes('jobSpec') || src.match(/_resolveExtensionWorkers\s*\(\s*[a-zA-Z_]/)
    ? pass('jobs_c1.js: _resolveExtensionWorkers passes jobSpec to extension adapter')
    : fail('jobs_c1.js: _resolveExtensionWorkers does NOT pass jobSpec — TTS/HeyGen/shoppable silently skip (CPD-491)')];
}

function checkAssemblyFailureAborts() {
  const src = readFile('lib/portal_policy_runner.js');
  if (!src) return [warn('portal_policy_runner.js not found')];
  const swallows = src.includes("catch (_e) { /* non-fatal */") || src.match(/onPortalPass[\s\S]{0,200}catch.*non-fatal/);
  return [swallows
    ? fail('portal_policy_runner.js: onPortalPass exceptions swallowed — assembly failure continues to portal3a (CPD-492)')
    : pass('portal_policy_runner.js: assembly failure correctly aborts portal sequence')];
}

function checkOperatorRetryHooks() {
  const src = readFile('lib/routes/jobs_c1.js');
  if (!src) return [fail('jobs_c1.js not found')];
  const advanceSection = src.slice(src.indexOf('advance') > 0 ? src.lastIndexOf('advance', src.length) - 500 : 0);
  return [advanceSection.includes('runJobComplete') || advanceSection.includes('onPortalPass')
    ? pass('jobs_c1.js: operator advance/retry includes assembly + completion hooks')
    : fail('jobs_c1.js: operator advance/retry missing assembly + completion hooks (CPD-493)')];
}

function checkClipSpecForwarded() {
  const src = readFile('lib/routes/jobs_c1.js');
  if (!src) return [fail('jobs_c1.js not found')];
  return [src.includes('clipSpec')
    ? pass('jobs_c1.js: clipSpec forwarded into jobSpec')
    : fail('jobs_c1.js: clipSpec NOT forwarded — trim points silently dropped')];
}

function checkLongformFormatSent() {
  const src = readFile('app/src/app/(app)/myjobs/new/page.tsx') ||
              readFile('app/src/app/(app)/generate/page.tsx');
  if (!src) return [warn('myjobs/new/page.tsx not found — verify format: longform in wizard submit manually')];
  const apiTs = readFile('app/src/lib/api.ts') || '';
  return [apiTs.includes("format") && src.includes("format")
    ? pass('Wizard submit includes format field in CreateJobPayload')
    : warn('Wizard submit may not include format: longform — long-form compilations may get wrong aspect ratio (CPD-494)')];
}

function checkProductionProfileResolved() {
  return ['lib/routes/jobs_c1.js', 'lib/queue/worker.js'].map(f => {
    const src = readFile(f);
    if (!src) return fail(`${f} not found`);
    return (src.includes('resolveProductionProfile') || src.includes('productionProfile'))
      ? pass(`${f}: productionProfile resolved`)
      : warn(`${f}: productionProfile may not be resolved`);
  });
}

function checkPortalReportsStored() {
  const results = [];
  const v1 = readFile('lib/routes/developer_api.js');
  const c1 = readFile('lib/routes/jobs_c1.js');
  results.push((v1 || '').includes('portalReports') || (v1 || '').includes('_storeReport')
    ? pass('developer_api.js: portalReports stored during pipeline')
    : fail('developer_api.js: portalReports NOT stored — grader and operator UI will see empty reports'));
  results.push((c1 || '').includes('portalReports') || (c1 || '').includes('_buildPortalReports')
    ? pass('jobs_c1.js: portalReports stored/built for grader')
    : fail('jobs_c1.js: portalReports NOT stored — grader and operator UI will see empty reports'));
  return results;
}

function checkFeatureGates() {
  const extDir = path.join(ROOT, 'lib', 'portals');
  if (!fs.existsSync(extDir)) return [warn('lib/portals/ not found')];
  return fs.readdirSync(extDir).filter(f => f.endsWith('_ext.js')).map(f => {
    const src = fs.readFileSync(path.join(extDir, f), 'utf8');
    return src.includes('isFeatureEnabled')
      ? pass(`${f}: isFeatureEnabled gate present`)
      : fail(`${f}: isFeatureEnabled gate MISSING — extension runs for all plans`);
  });
}

function checkRouteMounting() {
  const routeDir = path.join(ROOT, 'lib', 'routes');
  const serverSrc = readFile('server.js');
  if (!serverSrc || !fs.existsSync(routeDir)) return [warn('server.js or lib/routes/ not found')];
  return fs.readdirSync(routeDir).filter(f => f.endsWith('.js')).map(f => {
    const name = f.replace('.js', '');
    return serverSrc.includes(`routes/${name}`) || serverSrc.includes(`'${name}'`) || serverSrc.includes(`"${name}"`)
      ? pass(`lib/routes/${f}: mounted in server.js`)
      : warn(`lib/routes/${f}: not found in server.js — may be unmounted`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — Pipeline dependencies (what pipeline needs)
// ─────────────────────────────────────────────────────────────────────────────

function checkPipelineDependencyEnvVars() {
  const env = readFile('.env') || '';
  const example = readFile('.env.example') || '';
  const results = [];

  const required = [
    // Queue / storage
    { key: 'REDIS_URL',              label: 'BullMQ / Redis queue' },
    { key: 'DATABASE_URL',           label: 'Postgres (job state, credits, billing)' },
    { key: 'R2_ACCESS_KEY_ID',       label: 'Cloudflare R2 (video storage)' },
    { key: 'R2_SECRET_ACCESS_KEY',   label: 'Cloudflare R2 secret' },
    { key: 'R2_ACCOUNT_ID',          label: 'Cloudflare R2 account' },
    { key: 'R2_VIDEO_BUCKET',        label: 'R2 video bucket name' },
    // AI / generation
    { key: 'ELEVENLABS_API_KEY',     label: 'ElevenLabs TTS' },
    { key: 'HEYGEN_API_KEY',         label: 'HeyGen avatar generation' },
    { key: 'RUNPOD_API_KEY',         label: 'RunPod WAN video generation' },
    { key: 'GEMINI_API_KEY',         label: 'Gemini script generation' },
    { key: 'ANTHROPIC_API_KEY',      label: 'Anthropic (Claude) script/QA' },
    { key: 'OPENAI_API_KEY',         label: 'OpenAI GPT-4o QA' },
    // QA / grading
    { key: 'TWELVE_LABS_API_KEY',    label: 'Twelve Labs video QA' },
    { key: 'TOPAZLABS_API_KEY',      label: 'Topaz Labs upscaler' },
    { key: 'VECTCUT_API_URL',        label: 'VectCut trim/cut service' },
    // Clip sourcing
    { key: 'YOUTUBE_API_KEY',        label: 'YouTube clip sourcing' },
    { key: 'TWITCH_CLIENT_ID',       label: 'Twitch clip sourcing' },
    { key: 'KICK_CLIENT_ID',         label: 'Kick clip sourcing' },
    // Publish
    { key: 'UPLOADPOST_API_KEY',     label: 'UploadPost (multi-platform publish)' },
    // Observability
    { key: 'SENTRY_DSN',             label: 'Sentry error tracking' },
  ];

  for (const { key, label } of required) {
    const inEnv     = env.includes(`${key}=`) && !env.match(new RegExp(`${key}=\\s*$`, 'm'));
    const inExample = example.includes(key);
    if (inEnv) {
      results.push(pass(`${key}: set in .env (${label})`));
    } else if (inExample) {
      results.push(fail(`${key}: in .env.example but NOT in .env — pipeline dependency missing (${label})`));
    } else {
      results.push(warn(`${key}: not found in .env or .env.example — verify manually (${label})`));
    }
  }
  return results;
}

function checkFFmpegAvailable() {
  const utilsSrc = readFile('lib/ffmpeg_utils.js') || readFile('lib/ffmpeg.js') || '';
  return [utilsSrc.includes('ffmpegPath') || utilsSrc.includes('ffmpeg')
    ? pass('lib/ffmpeg_utils.js: FFmpeg path resolution present')
    : fail('FFmpeg utility file not found — pipeline cannot process video')];
}

function checkRedisQueueHealth() {
  const queueSrc = readFile('lib/queue/index.js') || readFile('lib/queue.js') || '';
  const workerSrc = readFile('lib/queue/worker.js') || '';
  const results = [];
  results.push(queueSrc.includes('REDIS_URL') || queueSrc.includes('redis')
    ? pass('lib/queue/index.js: Redis URL wired into BullMQ queue')
    : fail('lib/queue/index.js: Redis not wired — BullMQ queue will fail to connect'));
  results.push(workerSrc.includes('SIGTERM') || workerSrc.includes('graceful') || workerSrc.includes('close')
    ? pass('lib/queue/worker.js: graceful shutdown handler present')
    : warn('lib/queue/worker.js: no SIGTERM graceful shutdown — in-flight jobs may be lost on deploy'));
  return results;
}

function checkClipSourcingDeps() {
  const sourceSrc = readFile('lib/routes/source.js') || readFile('lib/clip_sourcing.js') || '';
  return [sourceSrc.length > 0
    ? pass('Clip sourcing route/service found')
    : warn('Clip sourcing route not found — verify yt-dlp is installed on Render')];
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 3 — Pipeline consumers (what needs pipeline to be healthy)
// ─────────────────────────────────────────────────────────────────────────────

function checkGraderWired() {
  const graderSrc = readFile('lib/services/job_grader.js');
  const results = [];
  if (!graderSrc) return [fail('lib/services/job_grader.js not found')];
  results.push(graderSrc.includes('portalReports')
    ? pass('job_grader.js: reads portalReports for scoring')
    : fail('job_grader.js: does not read portalReports — grader works blind'));
  results.push(graderSrc.includes('portal3a')
    ? pass('job_grader.js: uses portal3a report (video QA score) in grade')
    : warn('job_grader.js: portal3a report not referenced — video quality score may be ignored'));

  // Grader must be called from all job completion paths
  const c1 = readFile('lib/routes/jobs_c1.js') || '';
  const assembly = readFile('lib/services/pipeline_assembly.js') || '';
  results.push(c1.includes('gradeJob') || c1.includes('job_grader') || assembly.includes('gradeJob') || assembly.includes('job_grader')
    ? pass('gradeJob called from pipeline completion path')
    : fail('gradeJob NOT called from pipeline — jobs never get a quality score'));
  return results;
}

function checkNotificationsWired() {
  const notifSrc = readFile('lib/services/notifications.js');
  const assembly = readFile('lib/services/pipeline_assembly.js') || '';
  const c1 = readFile('lib/routes/jobs_c1.js') || '';
  const results = [];
  if (!notifSrc) return [fail('lib/services/notifications.js not found')];
  results.push(assembly.includes('createNotification') || assembly.includes('notify') || c1.includes('createNotification') || c1.includes('notifications')
    ? pass('Customer notification dispatched from pipeline completion')
    : fail('No notification call found in pipeline completion path — customers never notified'));
  results.push(notifSrc.includes('TELNYX') || notifSrc.includes('SMS') || notifSrc.includes('sms')
    ? pass('notifications.js: SMS provider (Telnyx) wired')
    : warn('notifications.js: SMS provider not detected — verify notification delivery'));
  return results;
}

function checkCreditsWired() {
  const creditsSrc = readFile('lib/services/credits.js') || '';
  const c1 = readFile('lib/routes/jobs_c1.js') || '';
  const workerSrc = readFile('lib/queue/worker.js') || '';
  const results = [];
  results.push(creditsSrc.includes('deduct') || creditsSrc.includes('consume') || creditsSrc.includes('use')
    ? pass('lib/services/credits.js: credit deduction function present')
    : fail('lib/services/credits.js: no deduction function found — credits may not be consumed'));
  results.push(c1.includes('credits') || c1.includes('consumeCredit') || c1.includes('deduct')
    ? pass('jobs_c1.js: credit deduction called on inline path')
    : fail('jobs_c1.js: credit deduction NOT called — free jobs possible on dashboard path'));
  results.push(workerSrc.includes('credits') || workerSrc.includes('consumeCredit') || workerSrc.includes('deduct')
    ? pass('queue/worker.js: credit deduction called on BullMQ path')
    : fail('queue/worker.js: credit deduction NOT called — free jobs possible on BullMQ path'));
  return results;
}

function checkPublishWired() {
  const portal5 = readFile('lib/portals/portal5.js') || '';
  const results = [];
  results.push(portal5.includes('uploadpost') || portal5.includes('UploadPost') || portal5.includes('publish')
    ? pass('portal5.js: publish to UploadPost/platforms wired')
    : fail('portal5.js: no publish call found — portal5 may not be publishing'));
  results.push(portal5.includes('youtube') || portal5.includes('tiktok') || portal5.includes('platforms')
    ? pass('portal5.js: platform routing present')
    : warn('portal5.js: explicit platform routing not detected — verify UploadPost handles platform selection'));
  // OAuth token store
  const tokenStore = readFile('lib/services/token_store.js') || '';
  results.push(tokenStore.includes('refresh') || tokenStore.includes('expir')
    ? pass('token_store.js: OAuth token refresh logic present')
    : warn('token_store.js: no token refresh detected — expired OAuth tokens will cause silent publish failures'));
  return results;
}

function checkOperatorDashboardDataSources() {
  const results = [];
  // Operator dashboard needs: job status, currentPortal, gateResults, portalReports, outputUrl
  const jobsRoute = readFile('lib/routes/jobs.js') || '';
  results.push(jobsRoute.includes('portalReports') || jobsRoute.includes('gateResults')
    ? pass('lib/routes/jobs.js: portalReports/gateResults exposed to operator UI')
    : warn('lib/routes/jobs.js: portalReports/gateResults not explicitly exposed — operator UI may lack data'));
  results.push(jobsRoute.includes('outputUrl') || jobsRoute.includes('output_url')
    ? pass('lib/routes/jobs.js: outputUrl exposed to job detail UI')
    : warn('lib/routes/jobs.js: outputUrl not detected in response shape — job detail page may not show video'));
  // Staging / operator review routing
  const c1 = readFile('lib/routes/jobs_c1.js') || '';
  results.push(c1.includes('operator_review') || c1.includes('staging')
    ? pass('jobs_c1.js: operator_review routing present (grade < 100 → operator hold)')
    : warn('jobs_c1.js: operator_review routing not detected — all jobs may bypass operator review'));
  return results;
}

function checkJobStatusUIPolling() {
  const jobDetailSrc = readFile('app/src/app/(app)/myjobs/[jobId]/page.tsx') || '';
  const results = [];
  results.push(jobDetailSrc.includes('useEffect') && (jobDetailSrc.includes('interval') || jobDetailSrc.includes('poll') || jobDetailSrc.includes('refetch'))
    ? pass('myjobs/[jobId]/page.tsx: job status polling present')
    : warn('myjobs/[jobId]/page.tsx: polling not detected — UI may not update when job completes'));
  results.push(jobDetailSrc.includes('outputUrl') || jobDetailSrc.includes('output_url')
    ? pass('myjobs/[jobId]/page.tsx: outputUrl rendered (video player / download link)')
    : warn('myjobs/[jobId]/page.tsx: outputUrl not detected — completed jobs may show no video'));
  return results;
}

function checkBillingConsumer() {
  const stripeSync = readFile('lib/services/stripe_plans_sync.js') || '';
  const stripeBilling = readFile('lib/services/stripe_billing.js') || '';
  const results = [];
  results.push(stripeSync.includes('planTier') || stripeSync.includes('plan_tier')
    ? pass('stripe_plans_sync.js: planTier synced from Stripe to customer record')
    : warn('stripe_plans_sync.js: planTier sync not detected — plan downgrades may not gate features'));
  results.push(stripeBilling.includes('webhook') || stripeBilling.includes('STRIPE_WEBHOOK_SECRET')
    ? pass('stripe_billing.js: webhook handler present (subscription events)')
    : fail('stripe_billing.js: no webhook handler — subscription changes will not update planTier'));
  return results;
}

function checkEnvVarsDocumented() {
  const exampleSrc = readFile('.env.example') || '';
  const libDir = path.join(ROOT, 'lib');
  if (!fs.existsSync(libDir)) return [warn('lib/ not found')];
  const envVars = new Set();
  function scanDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { scanDir(path.join(dir, entry.name)); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(dir, entry.name), 'utf8');
      for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) envVars.add(m[1]);
    }
  }
  scanDir(libDir);
  return [...envVars].sort().map(v =>
    exampleSrc.includes(v)
      ? pass(`${v}: documented in .env.example`)
      : fail(`${v}: NOT in .env.example — undocumented env var`));
}

function checkSentryOnHardFail() {
  return ['lib/services/pipeline_assembly.js', 'lib/routes/jobs_c1.js', 'lib/queue/worker.js'].map(f => {
    const src = readFile(f);
    if (!src) return warn(`${f}: not found`);
    return (src.includes('Sentry') || src.includes('captureException') || src.includes('captureMessage'))
      ? pass(`${f}: Sentry alert on failure`)
      : warn(`${f}: no Sentry call detected — failures may be silent`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function runReview() {
  const date = new Date().toISOString().slice(0, 10);

  const sections = [
    // ── Layer 1: Pipeline parity ───────────────────────────────────────────
    { title: 'LAYER 1 — Pipeline Parity', header: true },
    { title: '1.1 Assembly wired on all three dispatch paths', results: checkAssemblyWired() },
    { title: '1.2 Extension workers receive jobSpec on dashboard/BullMQ paths (CPD-491)', results: checkExtensionAdapterPassesJobSpec() },
    { title: '1.3 Assembly failure aborts portal sequence (CPD-492)', results: checkAssemblyFailureAborts() },
    { title: '1.4 Operator retry/advance includes assembly + completion hooks (CPD-493)', results: checkOperatorRetryHooks() },
    { title: '1.5 clipSpec forwarded into jobSpec', results: checkClipSpecForwarded() },
    { title: '1.6 format: longform in wizard submit payload (CPD-494)', results: checkLongformFormatSent() },
    { title: '1.7 productionProfile resolved on all paths', results: checkProductionProfileResolved() },
    { title: '1.8 portalReports stored during pipeline (grader dependency)', results: checkPortalReportsStored() },
    { title: '1.9 Feature gates on portal extension workers', results: checkFeatureGates() },
    { title: '1.10 Route mounting in server.js', results: checkRouteMounting() },
    // ── Layer 2: Pipeline dependencies ────────────────────────────────────
    { title: 'LAYER 2 — Pipeline Dependencies (what pipeline needs)', header: true },
    { title: '2.1 External API credentials present in .env', results: checkPipelineDependencyEnvVars() },
    { title: '2.2 FFmpeg path resolution', results: checkFFmpegAvailable() },
    { title: '2.3 Redis / BullMQ queue wiring + graceful shutdown', results: checkRedisQueueHealth() },
    { title: '2.4 Clip sourcing service present', results: checkClipSourcingDeps() },
    // ── Layer 3: Pipeline consumers ───────────────────────────────────────
    { title: 'LAYER 3 — Pipeline Consumers (what needs pipeline to be healthy)', header: true },
    { title: '3.1 Grader reads portalReports + called from completion path', results: checkGraderWired() },
    { title: '3.2 Customer notifications dispatched on job complete', results: checkNotificationsWired() },
    { title: '3.3 Credit deduction on all dispatch paths', results: checkCreditsWired() },
    { title: '3.4 Publish wiring — portal5 + OAuth token refresh', results: checkPublishWired() },
    { title: '3.5 Operator dashboard data sources (portalReports, outputUrl, operator_review routing)', results: checkOperatorDashboardDataSources() },
    { title: '3.6 Job status UI polling + outputUrl rendered', results: checkJobStatusUIPolling() },
    { title: '3.7 Billing consumer — Stripe webhook + planTier sync', results: checkBillingConsumer() },
    { title: '3.8 Env vars documented in .env.example', results: checkEnvVarsDocumented() },
    { title: '3.9 Sentry alerts on hard-fail paths', results: checkSentryOnHardFail() },
  ];

  let failures = 0, warnings = 0, passes = 0;
  const lines = [
    `# AuraFlux Full Ecosystem Health Review`,
    `**Date:** ${date}`,
    `**Script:** scripts/pipeline_parity_review.js`,
    `**Layers:** Pipeline parity · Pipeline dependencies · Pipeline consumers`,
    '',
  ];

  for (const section of sections) {
    if (section.header) {
      lines.push(`---`);
      lines.push(`## ${section.title}`);
      lines.push('');
      continue;
    }
    lines.push(`### ${section.title}`);
    for (const r of section.results) {
      lines.push(`- ${r.status} ${r.msg}`);
      if (r.status.includes('❌')) failures++;
      else if (r.status.includes('⚠️')) warnings++;
      else passes++;
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`## Summary`);
  lines.push(`- ✅ Passed: ${passes}`);
  lines.push(`- ⚠️  Warnings: ${warnings}`);
  lines.push(`- ❌ Failed: ${failures}`);
  lines.push('');
  if (failures > 0) {
    lines.push(`**STATUS: RED** — ${failures} critical check(s) failed. Fix before next deploy.`);
  } else if (warnings > 0) {
    lines.push(`**STATUS: AMBER** — No critical failures. Review warnings manually.`);
  } else {
    lines.push(`**STATUS: GREEN** — All checks passed.`);
  }

  const outPath = path.join(OUT_DIR, `pipeline_parity_review_${date}.md`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(lines.join('\n'));
  console.log(`\nReport written → ${outPath}`);
  return { failures, warnings, passes };
}

if (require.main === module) {
  const { failures } = runReview();
  process.exit(failures > 0 ? 1 : 0);
}

module.exports = { runReview };
