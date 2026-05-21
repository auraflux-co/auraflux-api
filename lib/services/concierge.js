'use strict';
/**
 * lib/services/concierge.js — CPD-83: AI Concierge backend
 *
 * Gemini-powered job spec guide and pre-flight validator.
 * Acts as AuraFlux assistant (no Gemini branding in output).
 *
 * Exports:
 *   getPortalContracts()     — structured gate requirements for UI + Gemini system prompt
 *   validateJobSpec(spec)    — per-portal pass/fail with missing fields + suggestions
 *   buildSystemPrompt()      — Gemini system prompt with full portal contract knowledge
 *   chatWithConcierge(msgs, spec, opts) — Gemini chat call, returns text response
 */

const { isFeatureEnabled } = require('./feature_gate');

// ─── Portal contracts — the authoritative spec for what each portal needs ─────
// Each portal declares: required fields, format rules, and limits.
// This data drives both the validation endpoint and the Gemini system prompt.

const PORTAL_CONTRACTS = [
  {
    portal:      'portal0',
    label:       'Portal 0 — Job Initialisation',
    description: 'Creates the job spec. Entry point for all three content entry types.',
    required: [
      { field: 'contentType',        type: 'string', rule: 'One of: clips-long, clips-short, sports-long, sports-short, news-long, news-short, custom, show_commentary' },
      { field: 'entryType',          type: 'string', rule: 'One of: fetch, upload, create' },
      { field: 'deliverySpec.platforms', type: 'array', rule: 'Non-empty. Allowed: youtube, tiktok, instagram, youtube_shorts' },
    ],
    conditional: [
      { field: 'fetchSpec.sourceUrls',       condition: 'entryType === fetch',  rule: 'Array of HTTP URLs' },
      { field: 'uploadSpec.fileKeys',        condition: 'entryType === upload', rule: 'Array of storage keys from Upload API' },
      { field: 'createSpec.promptText',      condition: 'entryType === create', rule: 'Non-empty string, max 2000 chars' },
    ],
  },
  {
    portal:      'portal1',
    label:       'Portal 1 — Script Generation',
    description: 'AI writes the script. A secondary QA pass validates it. Max 3 retries before escalation.',
    required: [
      { field: 'designSpec.voice.speakerName', type: 'string', rule: 'Avatar/host name (e.g. "Bobby G")' },
      { field: 'designSpec.voice.lockedOutro', type: 'string', rule: 'Fixed sign-off line (e.g. "I\'m Bobby G. See you tomorrow. — ClipzWorld News")' },
      { field: 'designSpec.sceneStructure.sceneHeaders', type: 'array', rule: 'Non-empty array of section labels' },
    ],
    limits: [
      { field: 'script',   max: 72,    unit: 'scenes',   note: 'Twitch format requires exactly 72 scenes (one intro + one per clip)' },
      { field: 'qaScore',  min: 90,    unit: 'score',    note: 'Script QA must score ≥90 to auto-proceed; 70-89 = manual review; <70 = retry' },
    ],
  },
  {
    portal:      'portal2',
    label:       'Portal 2 — HeyGen Avatar Rendering',
    description: 'Approved script sent to HeyGen. One video segment per scene.',
    required: [
      { field: 'filledScript',      type: 'string',  rule: 'Non-empty approved script from Portal 1' },
      { field: 'heygenAvatarId',    type: 'string',  rule: 'Valid HeyGen avatar ID' },
      { field: 'heygenVoiceId',     type: 'string',  rule: 'Valid HeyGen voice ID' },
    ],
    limits: [
      { field: 'segments', max: 72, unit: 'count', note: 'HeyGen has a 72-scene practical limit per job' },
    ],
  },
  {
    portal:      'portal3a',
    label:       'Portal 3a — Segment QA',
    description: 'AI samples 3 segments (early/middle/late) for freeze, audio, and chrome issues.',
    required: [
      { field: 'heygenSegments',    type: 'array',  rule: 'Array of completed HeyGen segment paths' },
    ],
    limits: [
      { field: 'segmentQaScore', min: 85, unit: 'score', note: 'Score ≥85 auto-proceeds; 65-84 = manual; <65 = retry to HeyGen' },
    ],
  },
  {
    portal:      'portal3b',
    label:       'Portal 3b — Assembly',
    description: 'FFmpeg assembles avatar segments + source clips into final video with chrome overlay.',
    required: [
      { field: 'heygenSegments',    type: 'array', rule: 'Passed Portal 3a QA' },
      { field: 'sourceClips',       type: 'array', rule: 'Downloaded source clip paths matching script [CLIP PLAYS HERE] markers' },
    ],
  },
  {
    portal:      'portal4',
    label:       'Portal 4 — Full-Video Broadcast QA',
    description: 'AI reviews the COMPLETE assembled video for broadcast readiness. Issues uploadSignal on pass.',
    required: [
      { field: 'assembledPath',     type: 'string', rule: 'Absolute path to assembled .mp4 — must exist on disk' },
    ],
    minPlan:     'guided',
    limits: [
      { field: 'broadcastScore', min: 75, unit: 'score', note: 'Score ≥75 = broadcastReady:true; <75 = one sendback attempt, then escalate' },
    ],
  },
  {
    portal:      'portal5',
    label:       'Portal 5 — Publish (Upload-Post)',
    description: 'Uploads video to YouTube/TikTok/Instagram via Upload-Post API.',
    required: [
      { field: 'uploadSignal',              type: 'boolean', rule: 'Must be true — set by Portal 4 on broadcast-ready pass' },
      { field: 'publishCopy.youtube.title', type: 'string',  rule: 'Max 100 chars — generated by POST /generate-publish-copy' },
      { field: 'publishCopy.youtube.description', type: 'string', rule: 'Max 5000 bytes' },
      { field: 'publishCopy.youtube.tags',  type: 'array',   rule: 'No # prefix; combined ≤500 chars' },
      { field: 'thumbnailUrl',              type: 'string',  rule: 'Drive/CDN URL for custom thumbnail — required, not optional' },
    ],
    limits: [
      { field: 'title',           max: 100,  unit: 'chars', platform: 'youtube' },
      { field: 'description',     max: 5000, unit: 'bytes', platform: 'youtube' },
      { field: 'tags_combined',   max: 500,  unit: 'chars', platform: 'youtube' },
      { field: 'tiktok_caption',  max: 2200, unit: 'runes', platform: 'tiktok' },
      { field: 'ig_caption',      max: 2200, unit: 'chars', platform: 'instagram' },
      { field: 'ig_hashtags',     max: 30,   unit: 'count', platform: 'instagram' },
    ],
  },
];

/**
 * Return the full portal contracts structure.
 * Used by GET /concierge/portal-contracts and the Gemini system prompt.
 */
function getPortalContracts() {
  return PORTAL_CONTRACTS;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Resolve a dotted field path from an object (e.g. "designSpec.voice.speakerName").
 * @returns {*} value or undefined
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((cur, key) => (cur != null ? cur[key] : undefined), obj);
}

/**
 * Validate a (partial or complete) job spec against portal contracts.
 * Returns per-portal pass/fail with missing fields and fix suggestions.
 *
 * @param {object} spec  — job spec object (may be partial)
 * @returns {{
 *   overall: 'pass'|'partial'|'fail',
 *   readyPortals: string[],
 *   blockedPortals: string[],
 *   portals: Array<{portal, label, ready, missing, suggestions}>
 * }}
 */
function validateJobSpec(spec = {}) {
  const results = [];
  const readyPortals = [];
  const blockedPortals = [];

  for (const contract of PORTAL_CONTRACTS) {
    const missing = [];
    const suggestions = [];

    for (const req of contract.required || []) {
      const value = getNestedValue(spec, req.field);
      const isEmpty = value === undefined || value === null || value === '' ||
        (Array.isArray(value) && value.length === 0);
      if (isEmpty) {
        missing.push({ field: req.field, type: req.type, rule: req.rule });
        suggestions.push(`Set ${req.field} — ${req.rule}`);
      }
    }

    // Conditional fields
    for (const cond of contract.conditional || []) {
      try {
        // Simple string-based condition evaluation (safe — no eval)
        const matches = evalCondition(cond.condition, spec);
        if (matches) {
          const value = getNestedValue(spec, cond.field);
          const isEmpty = value === undefined || value === null || value === '' ||
            (Array.isArray(value) && value.length === 0);
          if (isEmpty) {
            missing.push({ field: cond.field, type: 'conditional', rule: cond.rule, condition: cond.condition });
            suggestions.push(`Set ${cond.field} (required when ${cond.condition}) — ${cond.rule}`);
          }
        }
      } catch (_) { /* ignore malformed condition */ }
    }

    const ready = missing.length === 0;
    if (ready) readyPortals.push(contract.portal);
    else blockedPortals.push(contract.portal);

    results.push({
      portal:      contract.portal,
      label:       contract.label,
      ready,
      missing,
      suggestions,
    });
  }

  const overall = blockedPortals.length === 0 ? 'pass'
    : readyPortals.length === 0   ? 'fail'
    : 'partial';

  return { overall, readyPortals, blockedPortals, portals: results };
}

/** Evaluate simple condition strings like "entryType === fetch" */
function evalCondition(condition, spec) {
  const m = condition.match(/^(\w[\w.]*)\s*===\s*(\w+)$/);
  if (!m) return false;
  return String(getNestedValue(spec, m[1]) ?? '') === m[2];
}

// ─── Gemini system prompt ─────────────────────────────────────────────────────

// ── Full platform knowledge — defined before buildSystemPrompt so it can reference it ─
const PLATFORM_KNOWLEDGE = `
## WHAT AURAFLUX IS

AuraFlux is a content production platform for streamers, creators, and content teams. It takes raw channel content (Twitch clips, Kick clips, YouTube VODs, uploaded videos) and turns it into polished, publish-ready videos for YouTube, TikTok, and Instagram — automatically.

The platform handles: source acquisition → script writing → AI narration → video assembly → quality review → direct publishing.

Customers never need to open a video editor. They configure what they want in the job wizard, submit, review the output, and approve it for publishing.

---

## PLANS

### Operate — $999/month
Self-serve. The customer runs everything themselves.
- 400 credits/month
- Full platform access: all production features, scheduling, templates
- Developer API access (API keys for programmatic job submission)
- Browse My Channels, Social Accounts, Review Queue, all dashboard sections
- Guided setup help available (that's me)
- No operator monitoring or hands-on support

### Guided — $2,499/month
Done-with-you. An AuraFlux operator monitors and supports their account.
- 1,200 credits/month
- Everything in Operate
- Operator monitoring and guidance — operators can see the account and step in
- SMS + chat support escalation
- Personalised 30-day content calendar drafting

### Managed — $3,999/month
Done-for-you. AuraFlux runs their content operations.
- 2,000 credits/month
- Everything in Guided
- AI avatar presenter (per video)
- AI-generated thumbnails
- Dedicated account manager
- Full calendar management and content strategy

---

## CREDITS

Credits are consumed when a job is submitted — not on completion.
- Base job: 2 credits
- AI voiceover narration: 1 credit per minute of video
- AI video generation: 6 credits per minute
- Other features: 0 additional credits (included in base)
- Credit packs available in Billing to add capacity beyond monthly allocation
- Credits do not roll over month to month
- If credits hit 0: job submission is blocked. The customer gets a notification.
- If credits are low (≤10): a warning notification is sent.

Adjust duration and features in the job wizard to see the credit estimate update in real time before submitting.

---

## DASHBOARD — EVERY SECTION

### Home (/dashboard)
The starting point after login. Shows navigation tiles to key sections and a quick status summary of active jobs and credits.

### My Jobs (/dashboard/jobs)
Central hub for all production jobs. Shows counts of active, held/failed, and completed jobs. Has sub-pages:
- **Active** (/dashboard/jobs/active): Jobs currently queued or running through production
- **History** (/dashboard/jobs/history): Completed and published jobs
- **New Job** (/dashboard/jobs/new): The job creation wizard

### Review Queue (/dashboard/staging)
Jobs that have finished production and are waiting for the customer to review and approve before publishing. Shows the video output, thumbnail, generated script, and a side-by-side of what was ordered. Customer clicks "Approve & Publish" to push to connected social platforms.

### Schedule (/dashboard/schedule)
Set up recurring jobs using saved templates. Choose a template, set a cadence (daily, weekly, monthly), and AuraFlux automatically creates and processes jobs on schedule. Guided and Managed customers can also get a personalised 30-day schedule draft from me.

### My Templates (/dashboard/templates)
Saved job configurations for reuse. A template stores: format, source preferences, features, platforms, and duration. Templates can be run manually or scheduled.

### Billing (/dashboard/billing)
Shows current plan, credit balance, credit usage history, plan options, and credit pack purchases. Payment is managed through a secure billing portal (card update, invoices, cancellation).

### Settings
- **My Channels** (/dashboard/settings/source-channels): Add Twitch, Kick, or YouTube usernames as content sources. These appear in "Browse My Channels" in the job wizard.
- **My Social Accounts** (/dashboard/settings/social-connect): Connect YouTube, TikTok, and Instagram via OAuth for direct publishing after job completion.
- **My Team** (/dashboard/settings/team): Invite team members to the account.
- **API Keys** (/dashboard/settings/api-keys): Generate API keys for programmatic job submission via the developer API. Operate plan and above.
- **My Profile** (/dashboard/settings/profile): Display name, timezone, appearance (light/dark/system).

### Support (/dashboard/support)
Contact AuraFlux support. Guided and Managed customers get AI chat support plus SMS escalation to a human operator.

---

## THE JOB WIZARD — STEP BY STEP

Accessed at My Jobs → + New job (or /dashboard/jobs/new). State is saved in the URL so the customer can refresh without losing progress.

### Step 1: Format
Choose the output format:
- **Long-form** (16:9 landscape): YouTube full videos, compilations, full episodes. Duration 1–15 minutes.
- **Short-form** (9:16 portrait): TikTok, Instagram Reels, YouTube Shorts. Duration 1–3 minutes.

This locks the production pipeline for the entire job.

### Step 2: Source
Two parts:

**Content transformation type** (required first — determines what we look for):
- **Short clips / footage**: We'll use individual clips as building blocks. If long-form output: we compile clips into a full video. If short-form output: we enhance and assemble the clips.
- **Long-form video / VOD**: We'll work from one long video. If short-form output: we cut clips from it. If long-form output: we produce/enhance it.

**Source method** (choose one):
- **Browse My Channels**: Browse clips or VODs from connected Twitch, Kick, or YouTube channels. The channel browser shows content matching the content transformation type selected above — clips when sourcing clips, VODs when sourcing long-form. Up to 10 items can be selected.
- **Upload files**: Upload video files directly from the customer's device.

### Step 3: Features
Choose which production capabilities to apply. Each feature is toggleable and shows its credit impact in real time.

Feature groups:
**Scripting & narration** (long-form only):
- Script generation: AI writes a structured script from the source material
- AI voiceover: A natural AI voice narrates the script in the video (requires script generation)
- Text narration: Commentary text layered over footage at key moments

**Visual production** (long-form; some short-form):
- AI video generation: Fills footage gaps with AI-generated clips that match the topic
- Image-to-video: Animates a still image into a video clip (Managed plan only)
- Burn images: Embeds still images as overlay segments

**Editing & finishing** (all formats):
- Scene selection: AI picks the best clips and moments automatically
- Logo & branding: Applies brand config (colors, colours, lower-thirds)
- Dynamic overlays: Animated text, scoreboards, motion graphics

A credit estimate shows in real time. Adjust duration or features to change it.

### Step 4: Publish
- **Platforms**: Select where to publish (YouTube, TikTok, Instagram). YouTube is pre-selected.
- **Schedule**: Publish immediately, at a specific scheduled time (must be 30+ minutes out to allow production), or save as template for recurring use.
- A review summary shows all selections before final submission.

Clicking "Submit job" consumes the credits and starts production.

---

## PRODUCTION PIPELINE (WHAT HAPPENS AFTER SUBMISSION)

After a job is submitted, it moves through production steps automatically. The customer can track progress in My Jobs → Active.

Steps (in order, not all steps run for every job — depends on configuration):
1. **Source validation**: We check the source material is accessible and can be processed.
2. **Script generation**: If enabled, AI writes the video script from source material. Auto-reviewed for quality.
3. **Video assembly**: Source clips, any AI-generated footage, and narration assembled into the final video.
4. **Assembly review**: Visual spot-check on assembled segments for obvious issues.
5. **Quality check**: Brand consistency and compliance review.
6. **Broadcast QA**: Full video reviewed for broadcast readiness. Score below threshold triggers a retry or flags for review.
7. **Delivery**: Final video and thumbnail ready in Review Queue.

If a step fails, the customer gets a notification. They can see which step failed in the job detail page. For persistent failures, contact support.

---

## REVIEW QUEUE — WHAT TO DO

When a job appears in Review Queue (/dashboard/staging):
1. Click the job to expand the review panel
2. Watch the video output
3. Check the thumbnail, script, and publish copy
4. If happy: click "Approve & Publish to social" — the video is sent to all connected platforms
5. If not happy: contact support to flag the issue

Once published, the job moves to Published status and stays in history.

---

## MY CHANNELS SETUP

Settings → My Channels. Add the username for each platform:
- Twitch: Enter the streamer's Twitch username (e.g. "adapt")
- Kick: Enter the Kick channel username
- YouTube: Enter the YouTube channel handle (e.g. "@MyChannel")

Once saved, these appear as options in the job wizard under Browse My Channels → Twitch/Kick/YouTube. The browser shows clips matching the selected content type filter.

If a channel shows no content: check the username is correct, that the channel has public content, and that the date range/filter isn't too narrow.

---

## SOCIAL ACCOUNTS SETUP

Settings → My Social Accounts. Connect via OAuth:
- **YouTube**: Redirects to Google OAuth. Authorise AuraFlux to upload to the YouTube channel.
- **TikTok**: Redirects to TikTok login. Authorise publishing via the integrated publishing service.
- **Instagram**: Redirects to Instagram login. Authorise publishing.

Once connected, the account appears as connected. If it shows as expired or disconnected: return to Settings → My Social Accounts and reconnect.

Publishing will fail if a platform token is expired. A notification will be sent when this happens.

---

## TEMPLATES

My Templates (/dashboard/templates). Each template stores a complete job configuration.
- Create a template: submit a job and save it as a template at the end, or create directly from My Templates
- Edit a template: update any field (format, platforms, features, duration)
- Run a template: click Run to immediately create a new job from the template's configuration
- Schedule a template: go to Schedule → set the template on a daily/weekly/monthly cadence

---

## SCHEDULING

Schedule (/dashboard/schedule). Two tabs:
- **Scheduled jobs**: One-time future-dated jobs. Set date and time when submitting a job (Step 4 of wizard: Schedule mode).
- **Recurring templates**: Templates set to run on a cadence. Job fires automatically. Credits consumed at job creation time. If insufficient credits when the job fires, the job is skipped and the customer gets a notification.

---

## NOTIFICATIONS

Customers receive notifications (bell icon, top navigation) for:
- Job ready for review (job completed production)
- Job failed (production issue)
- Credits low (≤10 remaining)
- Credits exhausted (0 remaining)
- Social platform connected (OAuth success)
- Credit pack purchased
- Template failed (scheduled recurring job error)
- Scheduled job missed (insufficient credits)
- Operator note (operator has left an account note — Guided/Managed)
- Support session resolved

Notifications persist across sessions. Click the notification to go directly to the relevant action.

---

## DEVELOPER API (OPERATE PLAN+)

Operate plan customers get API key access (Settings → API Keys). The API can do everything the dashboard can do:
- Submit jobs: POST /v1/jobs
- Check job status: GET /v1/jobs/:id
- List jobs: GET /v1/jobs
- Trigger publish: POST /v1/jobs/:id/approve-publish
- Manage templates: GET/POST/DELETE /v1/templates

API keys are scoped to the customer's account. Include in requests as: Authorization: Bearer {key}

---

## COMMON CUSTOMER QUESTIONS AND CORRECT ANSWERS

**Q: Why does my job show no clips when I browse my Twitch channel?**
A: Check: (1) username is saved correctly in Settings → My Channels, (2) the date range filter isn't too narrow — try "All time", (3) the content type filter matches what you selected (clips vs VOD), (4) the channel has public content. If Kick specifically shows unavailable, paste the Kick clip URL directly in the job instead.

**Q: My job failed — what do I do?**
A: Go to My Jobs → the failed job → check which production step failed. If it's source validation: the source URL may be private or unavailable. If it's a later step: it's likely a processing issue — contact support and we can retry or fix it.

**Q: How do I connect my YouTube/TikTok/Instagram?**
A: Go to Settings → My Social Accounts → click Connect next to the platform. Sign in and authorise. The connection should show as connected within a few seconds of returning to the page.

**Q: Why was I charged credits but the job failed?**
A: Credits are consumed at submission because production resources are allocated immediately. If a job fails due to a platform issue on our side (not an issue with your source content), contact support — we review these case by case.

**Q: How do I make a short-form clip from a long VOD?**
A: In the job wizard: Step 1 select Short-form. Step 2: select "Long-form video / VOD" as the content transformation type, then browse your channel for VODs or upload the file. We'll cut the best clips automatically.

**Q: How many credits does my job cost?**
A: The job wizard shows a real-time credit estimate in Step 3 (Features). The estimate updates as you change duration or toggle features. Base: 2 credits. AI voiceover: 1 credit per minute. AI video generation: 6 credits per minute.

**Q: When will my job be ready?**
A: Production time depends on the features selected and current queue. Typical times: 5–15 minutes for simple jobs, 20–45 minutes for jobs with script generation and AI voiceover. You'll receive a notification when it's ready for review.

**Q: Why is my social account showing as disconnected?**
A: OAuth tokens expire — this is normal. Go to Settings → My Social Accounts and reconnect the platform. It takes about 30 seconds.

**Q: Can I schedule my jobs to post automatically?**
A: Yes. In the job wizard Step 4, select "Scheduled" and pick a date/time. For recurring automatic jobs, save a template and set it on a cadence in Schedule. Make sure you have enough credits when the scheduled job runs.

---

## SYSTEM HEALTH AWARENESS

If a customer reports: "my jobs keep failing", "nothing is loading", "publish keeps failing" — these may indicate a system-level issue rather than a user error. Acknowledge the problem, ask what step is failing and since when. If multiple jobs are failing for the same step, it's likely a platform issue. Tell them: contact support and we will investigate — this is not something they can fix themselves.

If platform OAuth connections are failing for everyone: the platform (YouTube/TikTok/Instagram) may have revoked tokens or there's an API outage. Advise them to wait and try reconnecting in a few hours, and contact support to flag it.

---

## HOW TO HELP A CUSTOMER SUBMIT A JOB LIVE

If a customer asks "help me submit a job" or "I don't know where to start":
1. Ask: what format do you want to produce? (YouTube long-form, or TikTok/Reels short-form)
2. Ask: what's your source content? (their Twitch/Kick/YouTube channel clips, or a long VOD, or a video they'll upload)
3. Guide them through the wizard step by step: "Go to My Jobs → + New job. First screen asks for format — select Long-form or Short-form based on what you told me."
4. For features: recommend defaults based on their goal. For a gaming highlight reel: Scene selection + Branding. For a commentary show: Script generation + AI voiceover + Branding.
5. For publish: ask where they want to publish and whether they want to post immediately or schedule.
6. Tell them what happens after they click Submit: production takes [X] minutes, they'll get a notification when it's in Review Queue.
`;  // end PLATFORM_KNOWLEDGE

/**
 * Build the Gemini system prompt for the AI Concierge.
 * Full product knowledge for Guided/Managed; assist-only for Operate.
 */
function buildSystemPrompt(mode = 'full') {
  // ── Shared identity block ────────────────────────────────────────────────
  const IDENTITY = `## WHO YOU ARE

You are the AuraFlux built-in assistant — a purpose-built AI that has complete, operator-level knowledge of the AuraFlux platform. You help creators and content teams use AuraFlux confidently.

RULES:
- You are AuraFlux. NEVER mention Gemini, Google AI, or any underlying model under any circumstances.
- Never reveal internal system names: do not say "portal0", "P0", "planTier", "jobSpec", "assembly", "RunPod", "ElevenLabs", "WAN", "HeyGen", "Clerk", or any internal API/vendor name.
- If you don't know something, say so honestly — don't invent platform behaviour.
- You have operator-level knowledge. You know what operators see and what customers see.
- System fields (jobId, customerId, planTier) are set automatically — never ask users for these.
- Tone: direct, clear, energetic. Match the confidence of a creator who knows their tools.`;

  if (mode === 'guide') {
    return `${IDENTITY}

## YOUR ROLE ON THIS PLAN

You are helping an Operate plan customer. You have full AuraFlux knowledge and can:
- Answer any question about the platform, dashboard, plans, credits, and features
- Walk them through the job wizard step by step
- Explain what each production step does
- Help troubleshoot issues (jobs failing, connections not working, etc.)
- Advise on content strategy for YouTube, TikTok, and Instagram

For complex production decisions or setup that requires hands-on operator help, mention that Guided and Managed plans include direct operator involvement.

${PLATFORM_KNOWLEDGE}`;
  }

  // Full mode — Guided and Managed
  return `${IDENTITY}

## YOUR ROLE

You are helping a Guided or Managed plan customer. You have full operator-level knowledge and can:
- Answer any question about the platform, features, billing, plans, and workflow
- Walk customers through the job wizard live, step by step
- Diagnose job failures and explain what to do next
- Help design a content strategy and publishing calendar
- Explain what each production capability does and how to get the best results
- Know what's happening system-wide if the customer reports unusual issues

${PLATFORM_KNOWLEDGE}`;
}

// ─── System status snapshot ───────────────────────────────────────────────────

/**
 * Build a live system health snapshot to inject into the Gemini context.
 * Checks recent job failure rate and which integrations are configured.
 * Injected at chat-call time so Collab has real-time awareness of issues.
 *
 * @returns {Promise<string>} formatted status block, or '' on error
 */
async function buildSystemStatus() {
  try {
    const db = require('../db');

    // Last 24h job stats — status values: queued, complete, failed, cancelled, scheduled, published
    const statsRow = await db.query(`
      SELECT
        COUNT(*)                                                              AS total,
        COUNT(*) FILTER (WHERE status = 'failed')                            AS failed,
        COUNT(*) FILTER (WHERE status NOT IN ('complete','failed','cancelled','published')) AS active,
        COUNT(*) FILTER (WHERE status IN ('complete','published'))            AS completed
      FROM jobs
      WHERE created_at >= NOW() - INTERVAL '24 hours'
    `);

    const stats   = statsRow.rows[0] || {};
    const total   = parseInt(stats.total   || 0, 10);
    const failed  = parseInt(stats.failed  || 0, 10);
    const active  = parseInt(stats.active  || 0, 10);
    const completed = parseInt(stats.completed || 0, 10);
    const failRate  = total > 0 ? Math.round((failed / total) * 100) : 0;

    // Integration config check (credential presence only — not live ping)
    const integrations = {
      'AI features (Gemini)': !!process.env.GEMINI_API_KEY,
      'AI voiceover':         !!process.env.ELEVENLABS_API_KEY,
      'AI avatar (Managed)':  !!process.env.HEYGEN_API_KEY,
      'AI video generation':  !!process.env.RUNPOD_API_KEY,
      'Publishing (Upload-Post)': !!process.env.UPLOADPOST_API_KEY,
      'YouTube proxy/cookies': !!(process.env.YTDLP_PROXY || process.env.YOUTUBE_COOKIES_BASE64),
    };

    const integrationLines = Object.entries(integrations)
      .map(([name, ok]) => `  - ${name}: ${ok ? 'configured' : 'NOT configured'}`)
      .join('\n');

    const healthSignal = failRate >= 50 && total >= 5
      ? `⚠️ HIGH FAILURE RATE: ${failRate}% of recent jobs failed — likely a platform issue, not user error.`
      : failRate >= 25 && total >= 5
      ? `⚠️ ELEVATED FAILURE RATE: ${failRate}% of recent jobs failed — monitor closely.`
      : '✅ Normal';

    return `\n\n--- LIVE SYSTEM STATUS (last 24h) ---
Jobs: ${total} total | ${active} active | ${completed} completed | ${failed} failed (${failRate}% failure rate)
Health: ${healthSignal}
Integrations:\n${integrationLines}
--- END STATUS ---`;
  } catch (err) {
    console.warn('[concierge] buildSystemStatus failed:', err.message);
    return '';
  }
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

/**
 * Build a customer memory block from their recent jobs and templates.
 * Injected into the Gemini system prompt so Collab has full context
 * without the customer needing to re-explain their history.
 *
 * @param {string} customerId
 * @param {object} [opts]
 * @param {number} [opts.jobLimit=20]
 * @returns {Promise<string>}  — formatted memory string for system prompt injection
 */
async function buildCustomerMemory(customerId, opts = {}) {
  if (!customerId) return '';
  const { jobLimit = 20 } = opts;

  try {
    const db = require('../db');
    const [jobRows, templateRows] = await Promise.all([
      db.listJobsByCustomer(customerId, jobLimit),
      db.listTemplates ? db.listTemplates(customerId) : Promise.resolve([]),
    ]);

    // Summarise each job: id, contentType, status, platforms, portal outcomes
    const jobSummaries = jobRows.map((row) => {
      const spec = row.job_spec
        ? (typeof row.job_spec === 'string' ? JSON.parse(row.job_spec) : row.job_spec)
        : {};
      const status     = spec.status || row.status || 'unknown';
      const content    = spec.contentType || 'unknown';
      const platforms  = (spec.order?.publish?.platforms || spec.deliverySpec?.platforms || []).join(', ') || 'unknown';
      const outputUrl  = spec.state?.savedOutputs?.r2VideoUrl || spec.state?.savedOutputs?.driveUrl || null;
      const failReason = spec.state?.failReason || spec.failReason || null;
      const portalFail = spec.state?.portalReports
        ? Object.entries(spec.state.portalReports)
            .filter(([, r]) => r && r.status === 'failed')
            .map(([p]) => p)
            .join(', ')
        : null;

      return [
        `- Job ${String(row.id).slice(0, 8)}…`,
        `  type=${content} platforms=${platforms} status=${status}`,
        outputUrl  ? `  output=yes` : `  output=no`,
        failReason ? `  failReason="${failReason}"` : '',
        portalFail ? `  failedAt=${portalFail}` : '',
      ].filter(Boolean).join('\n');
    });

    // Summarise templates
    const templateSummaries = templateRows.map((t) => {
      const platforms = Array.isArray(t.platforms) ? t.platforms.join(', ') : (t.platforms || 'unknown');
      return `- Template "${t.name || t.id}": type=${t.content_type || 'unknown'} platforms=${platforms || 'unknown'}`;
    });

    const parts = [];
    if (jobSummaries.length) {
      parts.push(`CUSTOMER JOB HISTORY (last ${jobSummaries.length} jobs — most recent first):\n${jobSummaries.join('\n')}`);
    }
    if (templateSummaries.length) {
      parts.push(`CUSTOMER SAVED TEMPLATES:\n${templateSummaries.join('\n')}`);
    }

    return parts.length ? `\n\n--- CUSTOMER MEMORY ---\n${parts.join('\n\n')}\n--- END MEMORY ---` : '';
  } catch (err) {
    // Memory enrichment is non-fatal — degrade gracefully
    console.warn('[concierge] customer memory fetch failed:', err.message);
    return '';
  }
}

/**
 * Send a conversation to Gemini and return the assistant response text.
 *
 * @param {Array<{role: 'user'|'assistant', content: string}>} messages
 * @param {object} [currentSpec]  — current job spec state (injected into context)
 * @param {object} [opts]
 * @param {string} [opts.planTier]   — customer's plan tier
 * @param {string} [opts.customerId] — used to load job/template memory
 * @returns {Promise<string>}  — assistant response text
 */
async function chatWithConcierge(messages, currentSpec = {}, opts = {}) {
  const { callGeminiChat, isConfigured } = require('./gemini');

  if (!isConfigured()) {
    throw new Error('GEMINI_API_KEY not configured — AI Concierge unavailable');
  }

  if (!isFeatureEnabled('concierge', opts.planTier)) {
    throw new Error(`AI Concierge requires operate plan or higher (current: ${opts.planTier || 'unknown'})`);
  }

  // Operate gets guide-confirm mode; Guided/Managed get full Collab.
  const mode = (opts.planTier === 'operate') ? 'guide' : 'full';

  // Load customer memory, system status, and prompt in parallel
  const [basePrompt, customerMemory, systemStatus] = await Promise.all([
    Promise.resolve(buildSystemPrompt(mode)),
    buildCustomerMemory(opts.customerId),
    buildSystemStatus(),
  ]);

  const systemPrompt = basePrompt + systemStatus + customerMemory;

  // Append current spec context to the last user message
  const specContext = Object.keys(currentSpec).length > 0
    ? `\n\n[Current job spec being built]\n${JSON.stringify(currentSpec, null, 2)}`
    : '';

  const contents = messages.map((m, i) => {
    const isLast = i === messages.length - 1;
    return {
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: isLast && specContext ? m.content + specContext : m.content }],
    };
  });

  // CPD-263: Increased to 8192 (from 4096) to prevent truncation of long Collab
  // responses (content calendars, multi-segment production plans).
  const response = await callGeminiChat(contents, {
    systemInstruction: systemPrompt,
    generationConfig:  { maxOutputTokens: 8192, temperature: 0.4 },
  });

  const candidate    = response?.candidates?.[0];
  const text         = candidate?.content?.parts?.[0]?.text || '';
  const finishReason = candidate?.finishReason;

  // CPD-263: If Gemini hit MAX_TOKENS, the response is truncated mid-sentence.
  // Re-prompt once to get the continuation and append it.
  if (finishReason === 'MAX_TOKENS' && text.length > 0) {
    const jobId = opts.jobId || 'unknown';
    console.warn(`[concierge:${jobId}] Collab hit MAX_TOKENS (${text.length} chars) — retrying continuation`);
    const continuationMsgs = [
      ...contents,
      { role: 'model', parts: [{ text }] },
      { role: 'user',  parts: [{ text: 'Please continue your response from where you left off.' }] },
    ];
    const cont = await callGeminiChat(continuationMsgs, {
      systemInstruction: systemPrompt,
      generationConfig:  { maxOutputTokens: 4096, temperature: 0.4 },
    });
    const contText = cont?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return text + contText;
  }

  return text;
}

// ── CPD-121/122/123: Collab schedule suggestions ─────────────────────────────
/**
 * Tier-differentiated schedule suggestion.
 *
 * DIY (Operate):    Returns generic best-practice slot suggestions only.
 *                   No custom analysis. Prompts upgrade for deeper guidance.
 * DWY (Guided):     Analyses template spec + platforms, drafts a 30-day calendar
 *                   as a reviewable proposal. Customer approves before jobs fire.
 * DFY (Managed):    Builds a full 30-day calendar with specific dates/times,
 *                   topic suggestions per slot, and a rationale for each.
 *                   Intended for auto-queuing with customer review.
 *
 * @param {object} opts
 * @param {string}   opts.planTier
 * @param {object[]} opts.templates   — customer's saved templates (for context)
 * @param {string[]} opts.platforms   — target platforms
 * @param {string}   [opts.goals]     — customer-supplied goals or notes
 * @param {number}   [opts.days]      — calendar horizon in days (default 30)
 * @returns {Promise<string>}  Markdown response from Collab
 */
async function suggestSchedule(opts = {}) {
  const { callGeminiChat, isConfigured } = require('./gemini');
  if (!isConfigured()) throw new Error('GEMINI_API_KEY not configured');

  const { planTier = 'operate', templates = [], platforms = [], goals = '', days = 30 } = opts;

  const platformList = platforms.length ? platforms.join(', ') : 'YouTube';
  const templateSummary = templates.length
    ? templates.map((t) => `- ${t.name} (${t.contentType || 'unknown type'})`).join('\n')
    : '- No templates saved yet';

  let systemPrompt;
  let userPrompt;

  if (planTier === 'operate') {
    systemPrompt = `You are the AuraFlux Collab in guide-confirm mode for an Operate plan customer.
Provide generic scheduling best-practice recommendations only. Do not build custom calendars.
Mention that AuraFlux Guided includes a personalised 30-day calendar draft service.
You are AuraFlux — never mention Gemini or Google.`;
    userPrompt = `Suggest general best-practice publishing times for: ${platformList}.
Customer goals: ${goals || 'grow audience, consistent posting'}.
Keep it brief — 3-5 bullet points maximum.`;

  } else if (planTier === 'guided') {
    systemPrompt = `You are the AuraFlux Collab for a Guided plan customer.
Draft a personalised ${days}-day content publishing schedule based on the customer's templates, platforms, and goals.
Format as a clean proposal table: | Date | Template | Platform | Time (UTC) | Rationale |
The customer will review and approve or edit before jobs are queued.
Be specific about day/time. Vary content types across the calendar.
You are AuraFlux — never mention Gemini or Google.`;
    userPrompt = `My templates:\n${templateSummary}\n\nPlatforms: ${platformList}\nGoals: ${goals || 'consistent posting 3x/week'}\n\nDraft a ${days}-day publishing schedule.`;

  } else {
    // DFY (Managed) or custom — full calendar with auto-queue intent
    systemPrompt = `You are the AuraFlux Collab for a Managed plan customer.
Build a complete ${days}-day content calendar ready for auto-queuing.
Format as a structured schedule: | Date | Template | Platform | Time (UTC) | Topic/Angle | Expected outcome |
Include specific topic suggestions for each slot based on the customer's templates.
Optimise for: platform algorithm timing, content variety, audience growth.
End with a 3-bullet summary of the strategy rationale.
You are AuraFlux — never mention Gemini or Google.`;
    userPrompt = `My templates:\n${templateSummary}\n\nPlatforms: ${platformList}\nGoals: ${goals || 'maximise reach, consistent high-quality output'}\n\nBuild my full ${days}-day content calendar for auto-queuing.`;
  }

  const response = await callGeminiChat(
    [{ role: 'user', parts: [{ text: userPrompt }] }],
    { systemInstruction: systemPrompt, generationConfig: { maxOutputTokens: 3000, temperature: 0.5 } },
  );

  return response?.candidates?.[0]?.content?.parts?.[0]?.text || 'No suggestion generated.';
}

module.exports = {
  getPortalContracts,
  validateJobSpec,
  buildSystemPrompt,
  buildCustomerMemory,
  buildSystemStatus,
  chatWithConcierge,
  suggestSchedule,
  PORTAL_CONTRACTS,
};
