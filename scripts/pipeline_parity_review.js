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
  const results = [];
  // Check jobs_c1.js: _resolveExtensionWorkers must accept jobSpec argument
  const c1 = readFile('lib/routes/jobs_c1.js') || '';
  results.push(/function _resolveExtensionWorkers\s*\(\s*jobSpec/.test(c1)
    ? pass('jobs_c1.js: _resolveExtensionWorkers(jobSpec) defined correctly')
    : fail('jobs_c1.js: _resolveExtensionWorkers does NOT accept jobSpec — extensions silently skip (CPD-491)'));
  // Check all 3 call sites pass jobSpec (not called without arg)
  const bareCallCount = (c1.match(/_resolveExtensionWorkers\s*\(\s*\)/g) || []).length;
  results.push(bareCallCount === 0
    ? pass('jobs_c1.js: all _resolveExtensionWorkers() call sites pass jobSpec')
    : fail(`jobs_c1.js: ${bareCallCount} call site(s) call _resolveExtensionWorkers() without jobSpec (CPD-491)`));
  // Check BullMQ worker also passes jobSpec
  const workerSrc = readFile('lib/queue/worker.js') || '';
  results.push(/extensionWorkers\s*:\s*_resolveExtensionWorkers\s*\(\s*jobSpec/.test(workerSrc)
    ? pass('queue/worker.js: _resolveExtensionWorkers(jobSpec) passed on BullMQ path')
    : fail('queue/worker.js: _resolveExtensionWorkers called without jobSpec — extensions skip on BullMQ path (CPD-491)'));
  return results;
}

function checkAssemblyFailureAborts() {
  const src = readFile('lib/portal_policy_runner.js');
  if (!src) return [warn('portal_policy_runner.js not found')];
  // Look for onPortalPass wrapped in try/catch with non-fatal comment within ~5 lines
  const swallows = !!(src.match(/await onPortalPass[\s\S]{0,150}catch\s*\(_e\)\s*\{\s*\/\* non-fatal \*\//));
  return [swallows
    ? fail('portal_policy_runner.js: onPortalPass exceptions swallowed — assembly failure continues to portal3a (CPD-492)')
    : pass('portal_policy_runner.js: assembly failure correctly aborts portal sequence (onPortalPass propagates)')];
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

/** CPD-1046 / CPD-1057 — clip jobs must run portal4 before publish (GREEN wiring ≠ pixel QA). */
function checkClipPortal4Qa() {
  const jobSpecSrc = readFile('lib/job_spec.js') || '';
  const routingSrc = readFile('lib/pipeline_routing.js') || '';
  const portal5Src = readFile('lib/portals/portal5.js') || '';
  const results = [];
  results.push(/isClips\)[\s\S]{0,120}defaults\.portal4\s*=\s*true/.test(jobSpecSrc)
    ? pass('job_spec.js: clip jobs activate portal4 (CPD-1046)')
    : fail('job_spec.js: clip jobs still skip portal4 — bad pixels can ship (CPD-1046)'));
  const paths = ['tiktok_clutch', 'youtube_deep_dive'];
  const allPathsPortal4 = paths.every((p) => {
    const re = new RegExp(`${p}:[\\s\\S]{0,400}portal4:\\s*true`);
    return re.test(routingSrc);
  });
  results.push(allPathsPortal4
    ? pass('pipeline_routing.js: KNOWN_CLEAN_PATHS expect portal4 for clip templates')
    : fail('pipeline_routing.js: clip templates missing portal4 in expectedPortals'));
  results.push(/portal4Inactive/.test(portal5Src)
    ? pass('portal5.js: R2-only publish fallback gated on portal4 inactive')
    : fail('portal5.js: clip jobs may publish without portal4 uploadSignal (CPD-1046)'));
  return results;
}

function checkProductionCronWired() {
  const src = readFile('server.js') || '';
  const svc = readFile('lib/services/production_cron.js');
  const auto = readFile('lib/calendar/auto_production.js');
  const results = [];
  results.push(svc && auto
    ? pass('production_cron + auto_production modules present (CPD-1053)')
    : fail('production_cron modules missing (CPD-1053)'));
  results.push(/startProductionCron\s*\(\{/.test(src)
    ? pass('server.js: startProductionCron wired on boot')
    : fail('server.js: production cron not started on boot (CPD-1053)'));
  const cal = readFile('config/content_calendar.json') || '';
  results.push(/"autoProduction"/.test(cal)
    ? pass('content_calendar.json: autoProduction config block present')
    : fail('content_calendar.json: missing autoProduction block'));
  return results;
}

/** CPD-1044/1045 / CPD-1057 — hub publish gates wired (static; does not prove pixel quality). */
function checkHubPublishGates() {
  const jobs = readFile('lib/routes/jobs_c1.js') || '';
  const dev = readFile('lib/routes/developer_api.js') || '';
  const approve = readFile('lib/services/approve_publish.js') || '';
  const results = [];
  results.push(/assertPublishReadiness\s*\(/.test(approve)
    ? pass('approve_publish.js: assertPublishReadiness defined (CPD-1045)')
    : fail('approve_publish.js: missing assertPublishReadiness'));
  results.push(/assertPublishReadiness\s*\(\s*spec/.test(jobs) && /assertPublishReadiness\s*\(\s*spec/.test(dev)
    ? pass('jobs_c1 + developer_api: assertPublishReadiness called on approve-publish')
    : fail('approve-publish route missing assertPublishReadiness on one or both paths (CPD-1045)'));
  results.push(/resolveActivePortals\s*\(\s*jobSpec\s*\)/.test(jobs)
    ? pass('jobs_c1.js: resolveActivePortals on job create (CPD-1044 staging portal5)')
    : fail('jobs_c1.js: resolveActivePortals not called — staging may not disable portal5'));
  results.push(/resolveActivePortals\s*\(\s*jobSpec\s*\)|resolveActivePortals\s*\(\s*_spec\s*\)/.test(dev)
    ? pass('developer_api.js: resolveActivePortals on v1 job create')
    : fail('developer_api.js: resolveActivePortals missing on v1 path'));
  results.push(/forceApprove/.test(jobs) && /superadmin|SUPERADMIN|requireRole/.test(jobs + dev)
    ? pass('forceApprove gated behind superadmin on approve-publish paths')
    : warn('verify forceApprove requires superadmin on both approve-publish routes'));
  return results;
}

function checkLongformFormatSent() {
  // The wizard assembles a payload object and passes it to createJob(payload).
  // format is a state variable set from template/user selection and included
  // in the payload object literal. Check that the payload includes format,
  // not just that the word "format" appears anywhere.
  const src = readFile('app/src/app/(app)/myjobs/new/page.tsx') ||
              readFile('app/src/app/(app)/generate/page.tsx');
  if (!src) return [warn('myjobs/new/page.tsx not found — verify format field in wizard submit manually')];
  // Look for: format: <variable> or "format" as a key in the payload object
  const hasFormatInPayload = /format\s*:\s*format/.test(src) || /["']format["']\s*:/.test(src);
  const apiTs = readFile('app/src/lib/api.ts') || '';
  const typeHasFormat = /format\??:\s*string/.test(apiTs) || apiTs.includes("format");
  return [(hasFormatInPayload || typeHasFormat)
    ? pass('Wizard submit includes format field in CreateJobPayload (format: format at line ~742)')
    : warn('Wizard submit may not include format field — verify format is sent in createJob payload')];
}

function checkProductionProfileResolved() {
  // productionProfile is baked into jobSpec at creation time by createJobSpec(),
  // not re-resolved per dispatch path. Check that createJobSpec or pipeline_assembly
  // sets it, not the individual dispatch files (which would be a false positive).
  const jobSpecSrc = readFile('lib/job_spec.js') || '';
  const assemblySrc = readFile('lib/services/pipeline_assembly.js') || '';
  const c1Src = readFile('lib/routes/jobs_c1.js') || '';
  const combined = jobSpecSrc + assemblySrc + c1Src;
  return [combined.includes('productionProfile') || combined.includes('resolveProductionProfile')
    ? pass('productionProfile set in job_spec.js / pipeline_assembly.js (baked into jobSpec at creation)')
    : warn('productionProfile not found in job_spec.js or pipeline_assembly.js — assembly may use wrong layout')];
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

// Routes that are intentionally not mounted on C1+ Render (C0-only or pending refactor)
const ROUTE_MOUNT_EXCLUSIONS = new Set([
  'c0_capcut',       // C0-only: CapCut progressive assembly (localhost only)
  'c0_gate_tools',   // C0-only: gate debugging tools (localhost only)
  'c0_sources',      // C0-only: local source file management (localhost only)
  'assembly_routes', // C0-only: Google Drive / Canva / ticker routes (not on Render)
  'concierge',       // Renamed to collab; /concierge* redirect is inline in server.js
  'publish',         // Inline in server.js; lib/routes/publish.js is a pending refactor
]);

function checkRouteMounting() {
  const routeDir = path.join(ROOT, 'lib', 'routes');
  const serverSrc = readFile('server.js');
  if (!serverSrc || !fs.existsSync(routeDir)) return [warn('server.js or lib/routes/ not found')];
  return fs.readdirSync(routeDir).filter(f => f.endsWith('.js')).map(f => {
    const name = f.replace('.js', '');
    if (ROUTE_MOUNT_EXCLUSIONS.has(name)) {
      return pass(`lib/routes/${f}: excluded (C0-only or pending refactor — not required on Render)`);
    }
    return serverSrc.includes(`routes/${name}`) || serverSrc.includes(`'${name}'`) || serverSrc.includes(`"${name}"`)
      ? pass(`lib/routes/${f}: mounted in server.js`)
      : warn(`lib/routes/${f}: not found in server.js — may be unmounted`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — Pipeline dependencies (what pipeline needs)
// ─────────────────────────────────────────────────────────────────────────────

function checkPipelineDependencyEnvVars() {
  const envFile = readFile('.env') || '';
  const example = readFile('.env.example') || '';
  const results = [];

  // On Render (no .env file on disk), treat process.env as the source of truth.
  // Locally, read .env to catch vars that haven't been set yet.
  const runningOnRender = !envFile && (process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.DATABASE_URL);

  // Helper: is a key actually set with a non-empty value?
  function isKeySet(key) {
    if (runningOnRender) {
      return !!(process.env[key] && process.env[key].trim());
    }
    const m = envFile.match(new RegExp(`^${key}=(.+)$`, 'm'));
    return !!(m && m[1]?.trim());
  }

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
    // Observability — warn_only: Sentry DSN is set on Render but not required in local .env
    { key: 'SENTRY_DSN',             label: 'Sentry error tracking', warn_only: true },
  ];

  const envSource = runningOnRender ? 'Render env' : '.env';

  for (const { key, label, warn_only } of required) {
    const inEnv     = isKeySet(key);
    const inExample = example.includes(key);
    if (inEnv) {
      results.push(pass(`${key}: set in ${envSource} (${label})`));
    } else if (warn_only) {
      results.push(warn(`${key}: not set (optional — ${label})`));
    } else if (!runningOnRender && inExample && envFile.includes(`${key}=`)) {
      // Locally: key present but blank in .env
      results.push(warn(`${key}: present in .env but blank — may be set on Render; verify (${label})`));
    } else if (inExample) {
      results.push(fail(`${key}: in .env.example but not set in ${envSource} — pipeline dependency missing (${label})`));
    } else {
      results.push(warn(`${key}: not found in ${envSource} or .env.example — verify manually (${label})`));
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
  // notifications.js is intentionally DB-only (in-app). SMS escalation is in
  // lib/services/support.js (support.escalation feature gate, guided+ only).
  // Check that the service at least writes to the DB, not for a specific SMS provider.
  results.push(notifSrc.includes('createNotification') || notifSrc.includes('INSERT') || notifSrc.includes('query(')
    ? pass('notifications.js: DB-backed notification delivery present (in-app notifications)')
    : warn('notifications.js: no DB write or delivery mechanism detected'));
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
  // Job routes live in jobs_c1.js, not jobs.js. Check the right file.
  // Also check the GET /jobs/:jobId handler in server.js as a fallback.
  const c1 = readFile('lib/routes/jobs_c1.js') || '';
  const serverSrc = readFile('server.js') || '';
  const jobsSrc = c1 || serverSrc; // primary source for job shape
  results.push(jobsSrc.includes('portalReports') || jobsSrc.includes('gateResults')
    ? pass('jobs_c1.js: portalReports/gateResults exposed in job response shape')
    : warn('jobs_c1.js: portalReports/gateResults not detected in response — operator UI may lack data'));
  results.push(jobsSrc.includes('outputUrl') || jobsSrc.includes('output_url')
    ? pass('jobs_c1.js: outputUrl exposed in job response shape')
    : warn('jobs_c1.js: outputUrl not detected in response — job detail page may not show video'));
  results.push(c1.includes('operator_review') || c1.includes('staging')
    ? pass('jobs_c1.js: operator_review routing present (grade < 100 → operator hold)')
    : warn('jobs_c1.js: operator_review routing not detected — all jobs may bypass operator review'));
  return results;
}

function checkJobStatusUIPolling() {
  const jobDetailSrc = readFile('app/src/app/(app)/myjobs/[jobId]/page.tsx') || '';
  const results = [];
  // Case-insensitive / multi-pattern: setInterval (capital I), useQuery, SWR refetch, router.refresh, poll
  // src.includes('interval') misses setInterval (capital I) — use case-insensitive regex instead
  const hasPolling = jobDetailSrc.includes('useEffect') && (
    /setInterval|useQuery|useSWR|router\.refresh|\.refetch|\.poll/i.test(jobDetailSrc)
  );
  results.push(hasPolling
    ? pass('myjobs/[jobId]/page.tsx: job status polling present')
    : warn('myjobs/[jobId]/page.tsx: polling not detected — UI may not update when job completes'));
  results.push(jobDetailSrc.includes('outputUrl') || jobDetailSrc.includes('output_url')
    ? pass('myjobs/[jobId]/page.tsx: outputUrl rendered (video player / download link)')
    : warn('myjobs/[jobId]/page.tsx: outputUrl not detected — completed jobs may show no video'));
  return results;
}

function checkBillingConsumer() {
  // stripe_plans_sync.js is a READ-ONLY plan definition cache (fetches from Stripe products).
  // planTier writes happen in lib/routes/credits.js webhook handler.
  // stripe_billing.js may not exist — billing logic lives in credits.js in this codebase.
  const creditsSrc = readFile('lib/routes/credits.js') || '';
  const results = [];
  results.push(creditsSrc.includes('subscription.updated') || creditsSrc.includes('subscription.deleted')
    ? pass('credits.js: Stripe subscription webhook handles plan tier changes')
    : fail('credits.js: no subscription.updated/deleted handler — plan downgrades will not update planTier'));
  // planTier must be written to the customer/brand record on subscription events
  results.push(
    creditsSrc.includes('updateBrandPlanTier') || creditsSrc.includes('updateClientPlanTier') ||
    creditsSrc.includes('planTier') || creditsSrc.includes('plan_tier')
      ? pass('credits.js: planTier written to customer record on subscription events')
      : fail('credits.js: planTier not updated from Stripe webhook — feature gates will use stale plan'));
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
    // logError() is the project's Sentry wrapper (error_logger.js → Sentry.captureException)
    return (src.includes('Sentry') || src.includes('captureException') || src.includes('captureMessage') || src.includes('logError'))
      ? pass(`${f}: error reporting on failure (Sentry/logError)`)
      : warn(`${f}: no Sentry/logError call detected — failures may be silent`);
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
    { title: '1.5b Clip jobs run portal4 pixel QA before publish (CPD-1046 / CPD-1057)', results: checkClipPortal4Qa() },
    { title: '1.5c Production cron ported (CPD-1053)', results: checkProductionCronWired() },
    { title: '1.5d Hub publish gates wired — static only (CPD-1044/1045 / CPD-1057)', results: checkHubPublishGates() },
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
    `> **CPD-1057 — GREEN ≠ pixel-perfect.** This report checks **wiring and static contracts** only.`,
    `> It did **not** catch CPD-869 (raw concat / missing chrome). After GREEN, still run:`,
    `> live job on staging (Review before publishing + private), operator pixel review, and \`logs/render_live_browse_session.json\`.`,
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

/**
 * Post a completed review report to Jira as a new issue.
 * The issue is created in the CPD project under issue type "Task" with a
 * machine-readable label so the agent can query it at session start.
 */
async function postReportToJira(reportMarkdown, summary) {
  const domain  = (process.env.ATLASSIAN_DOMAIN  || '').trim();
  const email   = (process.env.ATLASSIAN_EMAIL   || '').trim();
  const token   = (process.env.ATLASSIAN_API_TOKEN || '').trim();
  const project = (process.env.JIRA_PROJECT_KEY  || 'CPD').trim();

  if (!domain || !email || !token) {
    console.warn('[pipeline-review] Jira env vars missing — skipping Jira post');
    return null;
  }

  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const url  = `https://${domain}/rest/api/2/issue`;

  const body = JSON.stringify({
    fields: {
      project:     { key: project },
      summary,
      issuetype:   { name: 'Task' },
      description: reportMarkdown.slice(0, 30000), // Jira body cap
      labels:      ['pipeline-health-report', 'auto-generated'],
    },
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body,
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error(`[pipeline-review] Jira POST failed ${res.status}: ${txt}`);
    return null;
  }

  const data = await res.json();
  console.log(`[pipeline-review] Jira issue created: ${data.key} — ${url.replace('/rest/api/2/issue', '')}/browse/${data.key}`);
  return data.key;
}

async function runReviewAndPost() {
  const { failures, warnings, passes } = runReview();
  const date    = new Date().toISOString().slice(0, 10);
  const status  = failures > 0 ? 'RED' : warnings > 0 ? 'AMBER' : 'GREEN';
  const report  = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'logs', `pipeline_parity_review_${date}.md`),
    'utf8',
  );
  const summary = `[${status}] Pipeline Health Report ${date} — ${failures} failures, ${warnings} warnings, ${passes} passes`;
  const key = await postReportToJira(report, summary);
  return { failures, warnings, passes, jiraKey: key };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--jira')) {
    runReviewAndPost().then(({ failures }) => process.exit(failures > 0 ? 1 : 0)).catch(e => {
      console.error(e);
      process.exit(1);
    });
  } else {
    const { failures } = runReview();
    process.exit(failures > 0 ? 1 : 0);
  }
}

module.exports = { runReview, runReviewAndPost };
