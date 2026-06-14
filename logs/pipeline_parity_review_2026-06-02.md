# AuraFlux Full Ecosystem Health Review
**Date:** 2026-06-02
**Script:** scripts/pipeline_parity_review.js
**Layers:** Pipeline parity · Pipeline dependencies · Pipeline consumers

---
## LAYER 1 — Pipeline Parity

### 1.1 Assembly wired on all three dispatch paths
- ✅ developer_api.js: assembly wired
- ✅ jobs_c1.js: assembly wired
- ✅ queue/worker.js: assembly wired

### 1.2 Extension workers receive jobSpec on dashboard/BullMQ paths (CPD-491)
- ✅ jobs_c1.js: _resolveExtensionWorkers(jobSpec) defined correctly
- ✅ jobs_c1.js: all _resolveExtensionWorkers() call sites pass jobSpec
- ✅ queue/worker.js: _resolveExtensionWorkers(jobSpec) passed on BullMQ path

### 1.3 Assembly failure aborts portal sequence (CPD-492)
- ✅ portal_policy_runner.js: assembly failure correctly aborts portal sequence (onPortalPass propagates)

### 1.4 Operator retry/advance includes assembly + completion hooks (CPD-493)
- ✅ jobs_c1.js: operator advance/retry includes assembly + completion hooks

### 1.5 clipSpec forwarded into jobSpec
- ✅ jobs_c1.js: clipSpec forwarded into jobSpec

### 1.6 format: longform in wizard submit payload (CPD-494)
- ✅ Wizard submit includes format field in CreateJobPayload (format: format at line ~742)

### 1.7 productionProfile resolved on all paths
- ✅ productionProfile set in job_spec.js / pipeline_assembly.js (baked into jobSpec at creation)

### 1.8 portalReports stored during pipeline (grader dependency)
- ✅ developer_api.js: portalReports stored during pipeline
- ✅ jobs_c1.js: portalReports stored/built for grader

### 1.9 Feature gates on portal extension workers
- ✅ portal_burn_image_ext.js: isFeatureEnabled gate present
- ✅ portal_heygen_ext.js: isFeatureEnabled gate present
- ✅ portal_highlight_trim_ext.js: isFeatureEnabled gate present
- ✅ portal_shoppable_ext.js: isFeatureEnabled gate present
- ✅ portal_thumbnail_ext.js: isFeatureEnabled gate present
- ✅ portal_tts_ext.js: isFeatureEnabled gate present

### 1.10 Route mounting in server.js
- ✅ lib/routes/account.js: mounted in server.js
- ✅ lib/routes/admin.js: mounted in server.js
- ✅ lib/routes/admin_assistant.js: mounted in server.js
- ✅ lib/routes/admin_chat.js: mounted in server.js
- ✅ lib/routes/admin_crm.js: mounted in server.js
- ✅ lib/routes/app_content.js: mounted in server.js
- ✅ lib/routes/assembly_routes.js: excluded (C0-only or pending refactor — not required on Render)
- ✅ lib/routes/billing.js: mounted in server.js
- ✅ lib/routes/brands.js: mounted in server.js
- ✅ lib/routes/c0_capcut.js: excluded (C0-only or pending refactor — not required on Render)
- ✅ lib/routes/c0_gate_tools.js: excluded (C0-only or pending refactor — not required on Render)
- ✅ lib/routes/c0_sources.js: excluded (C0-only or pending refactor — not required on Render)
- ✅ lib/routes/channel_connect.js: mounted in server.js
- ✅ lib/routes/clip_sourcing.js: mounted in server.js
- ✅ lib/routes/collab.js: mounted in server.js
- ✅ lib/routes/concierge.js: excluded (C0-only or pending refactor — not required on Render)
- ✅ lib/routes/credits.js: mounted in server.js
- ✅ lib/routes/developer_api.js: mounted in server.js
- ✅ lib/routes/heygen.js: mounted in server.js
- ✅ lib/routes/jobs.js: mounted in server.js
- ✅ lib/routes/jobs_c1.js: mounted in server.js
- ✅ lib/routes/marketing.js: mounted in server.js
- ✅ lib/routes/notifications.js: mounted in server.js
- ✅ lib/routes/plan.js: mounted in server.js
- ✅ lib/routes/public.js: mounted in server.js
- ✅ lib/routes/publish.js: excluded (C0-only or pending refactor — not required on Render)
- ✅ lib/routes/social_connect.js: mounted in server.js
- ✅ lib/routes/source.js: mounted in server.js
- ✅ lib/routes/support.js: mounted in server.js
- ✅ lib/routes/team.js: mounted in server.js
- ✅ lib/routes/templates.js: mounted in server.js
- ✅ lib/routes/thumbnail.js: mounted in server.js
- ✅ lib/routes/upload.js: mounted in server.js
- ✅ lib/routes/video.js: mounted in server.js
- ✅ lib/routes/voice.js: mounted in server.js

---
## LAYER 2 — Pipeline Dependencies (what pipeline needs)

### 2.1 External API credentials present in .env
- ✅ REDIS_URL: set in .env (BullMQ / Redis queue)
- ✅ DATABASE_URL: set in .env (Postgres (job state, credits, billing))
- ✅ R2_ACCESS_KEY_ID: set in .env (Cloudflare R2 (video storage))
- ✅ R2_SECRET_ACCESS_KEY: set in .env (Cloudflare R2 secret)
- ✅ R2_ACCOUNT_ID: set in .env (Cloudflare R2 account)
- ✅ R2_VIDEO_BUCKET: set in .env (R2 video bucket name)
- ✅ ELEVENLABS_API_KEY: set in .env (ElevenLabs TTS)
- ✅ HEYGEN_API_KEY: set in .env (HeyGen avatar generation)
- ✅ RUNPOD_API_KEY: set in .env (RunPod WAN video generation)
- ✅ GEMINI_API_KEY: set in .env (Gemini script generation)
- ✅ ANTHROPIC_API_KEY: set in .env (Anthropic (Claude) script/QA)
- ✅ OPENAI_API_KEY: set in .env (OpenAI GPT-4o QA)
- ✅ TWELVE_LABS_API_KEY: set in .env (Twelve Labs video QA)
- ✅ TOPAZLABS_API_KEY: set in .env (Topaz Labs upscaler)
- ✅ VECTCUT_API_URL: set in .env (VectCut trim/cut service)
- ✅ YOUTUBE_API_KEY: set in .env (YouTube clip sourcing)
- ✅ TWITCH_CLIENT_ID: set in .env (Twitch clip sourcing)
- ✅ KICK_CLIENT_ID: set in .env (Kick clip sourcing)
- ✅ UPLOADPOST_API_KEY: set in .env (UploadPost (multi-platform publish))
- ⚠️  SENTRY_DSN: not in local .env (may be set on Render) — verify in Render env panel (Sentry error tracking)

### 2.2 FFmpeg path resolution
- ✅ lib/ffmpeg_utils.js: FFmpeg path resolution present

### 2.3 Redis / BullMQ queue wiring + graceful shutdown
- ✅ lib/queue/index.js: Redis URL wired into BullMQ queue
- ✅ lib/queue/worker.js: graceful shutdown handler present

### 2.4 Clip sourcing service present
- ✅ Clip sourcing route/service found

---
## LAYER 3 — Pipeline Consumers (what needs pipeline to be healthy)

### 3.1 Grader reads portalReports + called from completion path
- ✅ job_grader.js: reads portalReports for scoring
- ✅ job_grader.js: uses portal3a report (video QA score) in grade
- ✅ gradeJob called from pipeline completion path

### 3.2 Customer notifications dispatched on job complete
- ✅ Customer notification dispatched from pipeline completion
- ✅ notifications.js: DB-backed notification delivery present (in-app notifications)

### 3.3 Credit deduction on all dispatch paths
- ✅ lib/services/credits.js: credit deduction function present
- ✅ jobs_c1.js: credit deduction called on inline path
- ✅ queue/worker.js: credit deduction called on BullMQ path

### 3.4 Publish wiring — portal5 + OAuth token refresh
- ✅ portal5.js: publish to UploadPost/platforms wired
- ✅ portal5.js: platform routing present
- ✅ token_store.js: OAuth token refresh logic present

### 3.5 Operator dashboard data sources (portalReports, outputUrl, operator_review routing)
- ✅ jobs_c1.js: portalReports/gateResults exposed in job response shape
- ✅ jobs_c1.js: outputUrl exposed in job response shape
- ✅ jobs_c1.js: operator_review routing present (grade < 100 → operator hold)

### 3.6 Job status UI polling + outputUrl rendered
- ✅ myjobs/[jobId]/page.tsx: job status polling present
- ✅ myjobs/[jobId]/page.tsx: outputUrl rendered (video player / download link)

### 3.7 Billing consumer — Stripe webhook + planTier sync
- ✅ credits.js: Stripe subscription webhook handles plan tier changes
- ✅ credits.js: planTier written to customer record on subscription events

### 3.8 Env vars documented in .env.example
- ✅ ADMIN_SECRET: documented in .env.example
- ✅ AI_MEMORY_TRACE_ENABLED: documented in .env.example
- ✅ ANTHROPIC_API_KEY: documented in .env.example
- ✅ APIFY_API_TOKEN: documented in .env.example
- ✅ API_BASE_URL: documented in .env.example
- ✅ ATLASSIAN_API_TOKEN: documented in .env.example
- ✅ ATLASSIAN_DOMAIN: documented in .env.example
- ✅ ATLASSIAN_EMAIL: documented in .env.example
- ✅ AURAFLUX_APP_URL: documented in .env.example
- ✅ AUTOMATION_SELF_HEAL_MAX: documented in .env.example
- ✅ AUTO_PUBLISH_PLATFORMS: documented in .env.example
- ✅ C0_FORCE_SIDEBAR_VISIBLE: documented in .env.example
- ✅ C0_LEGACY_OVERLAY_ONLY: documented in .env.example
- ✅ C0_MANUAL_HEYGEN_NESTED: documented in .env.example
- ✅ C0_MANUAL_PREFETCH_SOURCE_CLIPS: documented in .env.example
- ✅ C0_MANUAL_SEGMENT_CHECKPOINT: documented in .env.example
- ✅ C0_MANUAL_WAIT_FOR_HEYGEN: documented in .env.example
- ✅ CANVA_ACCESS_TOKEN: documented in .env.example
- ✅ CAPCUT_URL: documented in .env.example
- ✅ CHROME_PATH: documented in .env.example
- ✅ CLERK_PUBLISHABLE_KEY: documented in .env.example
- ✅ CLERK_SECRET_KEY: documented in .env.example
- ✅ CLERK_WEBHOOK_SECRET: documented in .env.example
- ✅ COMFYUI_API_KEY: documented in .env.example
- ✅ CURSOR_API_KEY: documented in .env.example
- ✅ CWN_OVERLAY_BASELINE_PRESET: documented in .env.example
- ✅ DASHBOARD_PORT: documented in .env.example
- ✅ DATABASE_URL: documented in .env.example
- ✅ DRIVE_CLIENT_ID: documented in .env.example
- ✅ DRIVE_CLIENT_SECRET: documented in .env.example
- ✅ DRIVE_FOLDER_ID: documented in .env.example
- ✅ DRIVE_REFRESH_TOKEN: documented in .env.example
- ✅ E2E_AUTH_SECRET: documented in .env.example
- ✅ ELEVENLABS_API_KEY: documented in .env.example
- ✅ ELEVENLABS_DEFAULT_VOICE_ID: documented in .env.example
- ✅ FFMPEG_PATH: documented in .env.example
- ✅ FFPROBE_PATH: documented in .env.example
- ✅ FINNHUB_API_KEY: documented in .env.example
- ✅ FMP_API_KEY: documented in .env.example
- ✅ FORCE_SIDEBAR_VISIBLE: documented in .env.example
- ✅ GATE1_VIDEO_CACHE_DIR: documented in .env.example
- ✅ GATE1_VIDEO_CACHE_MAX_FILES: documented in .env.example
- ✅ GATE1_VIDEO_CACHE_PART_MAX_AGE_MS: documented in .env.example
- ✅ GATE1_VIDEO_CACHE_TTL_MS: documented in .env.example
- ✅ GATE1_VIDEO_REVIEW: documented in .env.example
- ✅ GATE2_MIN_SEGMENT_SECONDS: documented in .env.example
- ✅ GATE2_STUCK_THRESHOLD_MS: documented in .env.example
- ✅ GATE3A_CHROME_STRICT: documented in .env.example
- ✅ GATE_TEST_MODE: documented in .env.example
- ✅ GEMINI_API_KEY: documented in .env.example
- ✅ GEMINI_GATE1_MODEL: documented in .env.example
- ✅ GEMINI_MODEL: documented in .env.example
- ✅ GEMINI_SCRIPT_MODEL: documented in .env.example
- ✅ GITHUB_API_TOKEN: documented in .env.example
- ✅ GITHUB_REPO: documented in .env.example
- ✅ GITHUB_TOKEN: documented in .env.example
- ✅ GOOGLE_API_KEY: documented in .env.example
- ✅ HEYGEN_ADMIN_TOKEN: documented in .env.example
- ✅ HEYGEN_API_KEY: documented in .env.example
- ✅ HEYGEN_AVATAR_ID: documented in .env.example
- ✅ HEYGEN_AVATAR_SHORT_ID: documented in .env.example
- ✅ HEYGEN_AVATAR_SHORT_NBA_ID: documented in .env.example
- ✅ HEYGEN_AVATAR_SHORT_NEWS_ID: documented in .env.example
- ✅ HEYGEN_AVATAR_SHORT_TWITCH_ID: documented in .env.example
- ✅ HEYGEN_FOLDER_ID_NBA_NFL: documented in .env.example
- ✅ HEYGEN_FOLDER_ID_NEWS: documented in .env.example
- ✅ HEYGEN_FOLDER_ID_TWITCH: documented in .env.example
- ✅ HEYGEN_SIM_DURATION_SEC: documented in .env.example
- ✅ HEYGEN_SIM_FONT: documented in .env.example
- ✅ HEYGEN_SIM_MODE: documented in .env.example
- ✅ HEYGEN_SPEAK_SPEED: documented in .env.example
- ✅ HEYGEN_STUCK_POLLS: documented in .env.example
- ✅ HEYGEN_TEMPLATE_LANDSCAPE: documented in .env.example
- ✅ HEYGEN_TEMPLATE_PORTRAIT: documented in .env.example
- ✅ HEYGEN_VERIFY_FOLDER: documented in .env.example
- ✅ HEYGEN_VOICE_ID: documented in .env.example
- ✅ INSTAGRAM_ACCESS_TOKEN: documented in .env.example
- ✅ INSTAGRAM_ACCOUNT_ID: documented in .env.example
- ✅ JIRA_API_TOKEN: documented in .env.example
- ✅ JIRA_PROJECT_KEY: documented in .env.example
- ✅ JIRA_USER_EMAIL: documented in .env.example
- ✅ JIRA_WEBHOOK_SECRET: documented in .env.example
- ✅ JOB_TIMELINE_ARRAY_MAX: documented in .env.example
- ✅ JOB_TIMELINE_MAX_BYTES: documented in .env.example
- ✅ JOB_TIMELINE_STRING_MAX: documented in .env.example
- ✅ KICK_API_BASE_URL: documented in .env.example
- ✅ KICK_CLIENT_ID: documented in .env.example
- ✅ KICK_CLIENT_SECRET: documented in .env.example
- ✅ LEGACY_OVERLAY_ONLY: documented in .env.example
- ✅ LOG_LEVEL: documented in .env.example
- ✅ META_APP_ID: documented in .env.example
- ✅ META_APP_SECRET: documented in .env.example
- ✅ NEWS_AJ_MAX_CLIP_SEC: documented in .env.example
- ✅ NEWS_AJ_PINNED_URLS: documented in .env.example
- ✅ NEWS_RSS_URL: documented in .env.example
- ✅ NEWS_US_CANADA_HUB_URL: documented in .env.example
- ✅ NEWS_US_PRIMARY_HUB_URL: documented in .env.example
- ✅ NEW_RELIC_LICENSE_KEY: documented in .env.example
- ✅ NEW_RELIC_USER_KEY: documented in .env.example
- ✅ NEXT_PUBLIC_API_URL: documented in .env.example
- ✅ NEXT_PUBLIC_APP_URL: documented in .env.example
- ✅ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: documented in .env.example
- ✅ NEXT_PUBLIC_SUPPORT_SMS_NUMBER: documented in .env.example
- ✅ NODE_ENV: documented in .env.example
- ✅ NR_ALERT_SECRET: documented in .env.example
- ✅ NR_PIPELINE_SERVICE: documented in .env.example
- ✅ OPENAI_API_KEY: documented in .env.example
- ✅ OPERATOR_USER_IDS: documented in .env.example
- ✅ PGSSLROOTCERT: documented in .env.example
- ✅ PIPELINE_WORKER_CONCURRENCY: documented in .env.example
- ✅ PORT: documented in .env.example
- ✅ PORTAL1_VIDEO_REVIEW: documented in .env.example
- ✅ PUPPETEER_EXECUTABLE_PATH: documented in .env.example
- ✅ QA_CONFIRM_ON_GENERATE: documented in .env.example
- ✅ QA_MAX_INTERVENTION_ATTEMPTS: documented in .env.example
- ✅ QA_MAX_WORKER_SENDBACKS: documented in .env.example
- ✅ R2_ACCESS_KEY_ID: documented in .env.example
- ✅ R2_ACCOUNT_ID: documented in .env.example
- ✅ R2_ASSETS_DOMAIN: documented in .env.example
- ✅ R2_SECRET_ACCESS_KEY: documented in .env.example
- ✅ R2_VIDEO_BUCKET: documented in .env.example
- ✅ REDIS_URL: documented in .env.example
- ✅ RENDER_API_KEY: documented in .env.example
- ✅ RENDER_SERVICE_ID: documented in .env.example
- ✅ RESEARCH_GEMINI_MODEL: documented in .env.example
- ✅ RUNPOD_API_KEY: documented in .env.example
- ✅ RUNPOD_ENDPOINT_ID: documented in .env.example
- ✅ RUNPOD_POD_ID: documented in .env.example
- ✅ SCAFFOLD_PERSISTENCE_STRICT: documented in .env.example
- ✅ SENTRY_DSN: documented in .env.example
- ✅ SHORT_CLIP_WINDOW_MAX_SEC: documented in .env.example
- ✅ SKIP_DRIVE_UPLOAD: documented in .env.example
- ✅ SMS_PROVIDER: documented in .env.example
- ✅ SMTP_HOST: documented in .env.example
- ✅ SMTP_PASS: documented in .env.example
- ✅ SMTP_PORT: documented in .env.example
- ✅ SMTP_USER: documented in .env.example
- ✅ STRIPE_PRICE_GUIDED: documented in .env.example
- ✅ STRIPE_PRICE_MANAGED: documented in .env.example
- ✅ STRIPE_PRICE_OPERATE: documented in .env.example
- ✅ STRIPE_SECRET_KEY: documented in .env.example
- ✅ STRIPE_WEBHOOK_SECRET: documented in .env.example
- ✅ SUPERADMIN_PHONE: documented in .env.example
- ✅ SUPPORT_SMS_NUMBER: documented in .env.example
- ✅ SYNTH_ASSEMBLE_API_URL: documented in .env.example
- ✅ TELNYX_API_KEY: documented in .env.example
- ✅ TELNYX_NUMBER: documented in .env.example
- ✅ TELNYX_PUBLIC_KEY: documented in .env.example
- ✅ TIKTOK_ACCESS_TOKEN: documented in .env.example
- ✅ TIKTOK_CLIENT_KEY: documented in .env.example
- ✅ TIKTOK_CLIENT_SECRET: documented in .env.example
- ✅ TMP_DIR: documented in .env.example
- ✅ TOKEN_ENCRYPTION_KEY: documented in .env.example
- ✅ TOPAZLABS_API_KEY: documented in .env.example
- ✅ TWELVE_LABS_API_KEY: documented in .env.example
- ✅ TWILIO_NUMBER: documented in .env.example
- ✅ TWITCH_CLIENT_ID: documented in .env.example
- ✅ TWITCH_TOKEN: documented in .env.example
- ✅ UPLOADPOST_API_KEY: documented in .env.example
- ✅ UPLOADPOST_PROFILE: documented in .env.example
- ✅ UPLOAD_DIR: documented in .env.example
- ✅ USE_DIRECTIVE_CHROME: documented in .env.example
- ✅ USE_LOCAL_FFMPEG: documented in .env.example
- ✅ VECTCUT_API_URL: documented in .env.example
- ✅ WAN_MODEL_VERSION: documented in .env.example
- ✅ WORKER_MEM_PAUSE_MB: documented in .env.example
- ✅ WORKER_MEM_RESUME_MB: documented in .env.example
- ✅ YOUTUBE_API_KEY: documented in .env.example
- ✅ YOUTUBE_CLIENT_ID: documented in .env.example
- ✅ YOUTUBE_CLIENT_SECRET: documented in .env.example
- ✅ YOUTUBE_COOKIES_BASE64: documented in .env.example
- ✅ YOUTUBE_SERVER_API_KEY: documented in .env.example
- ✅ YTDLP_PATH: documented in .env.example
- ✅ YTDLP_PROXY: documented in .env.example

### 3.9 Sentry alerts on hard-fail paths
- ✅ lib/services/pipeline_assembly.js: error reporting on failure (Sentry/logError)
- ✅ lib/routes/jobs_c1.js: error reporting on failure (Sentry/logError)
- ✅ lib/queue/worker.js: error reporting on failure (Sentry/logError)

---
## Summary
- ✅ Passed: 272
- ⚠️  Warnings: 1
- ❌ Failed: 0

**STATUS: AMBER** — No critical failures. Review warnings manually.