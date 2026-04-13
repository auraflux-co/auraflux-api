# PHASE_2_BUILD_SPEC.md

**Author:** Claude Code, drafted 2026-04-13 PM from Rob's stack+build+Figma notes
**Status:** Execution spec for Phase 2 (Client Layer) of the autonomous production roadmap
**Companion docs:**
- `AUTONOMOUS_PRODUCTION_ROADMAP.md` section 12 — stack architecture (already locked, not duplicated here)
- `BUSINESS_STRATEGY.md` — positioning, ICP, pricing (referenced, not duplicated)
- `SHARED_NEWSCAST_SET_MIGRATION.md` — News chrome migration (parallel track, different scope)

**Not a handoff.** No Cline checklist, no commit template. This is the reference doc for when Phase 2 actually starts. Once Jira is online, the content here becomes epics/stories/tasks/subtasks organized by week.

---

## 1. Purpose

This doc captures Rob's 6-week Phase 2 build plan for the customer-facing SaaS product. It is the bridge between:

- **Current state:** localhost operator dashboard, vanilla HTML, JSON file persistence, single operator (Rob), Phase 1 smoke test loop
- **Phase 2 end state:** Next.js + Vercel frontend calling Railway Node/Express backend with Postgres persistence, first paying customer onboarded, daily content shipping automatically, 3-5 closed alpha beta creators using the product

Phase 2 is where CWN stops being Rob's personal production tool and becomes a product other people can use. The engineering side of that shift is captured here; the business side lives in `BUSINESS_STRATEGY.md` sections 5–9 (GTM, outreach, pricing, execution stack).

---

## 2. Hard prerequisites — Phase 2 cannot start until these are all true

Per Rob's decision 2026-04-13, Phase 2 is **sequential after Phase 1**, not parallel. No Next.js/Vercel/Railway work begins until:

| # | Gate | How verified |
|---|---|---|
| 1 | **News long-form locked** | News smoke test passes end-to-end with no new gaps across 2+ consecutive runs. Rob's visual review is "ship it." Currently blocked behind `CLINE_HANDOFF_NEWS_SMOKE_TEST_9_FIXES.md` (5 fixes). |
| 2 | **NBA long-form locked** | Same criteria as News. Currently blocked behind NBA chrome migration (post-News) + NBA voiceover V2 dispatch (`CLINE_DISPATCH_NBA_VOICEOVER_V2_QUEUED.md`). |
| 3 | **At least one short-form content type locked** | One short-form smoke test passes (News short, NBA short, OR Twitch short — Rob picks). Short-form is not yet built at all; this is new Phase 1.5 work. |

**Rationale for all three:** News and NBA are the most complex content types, so their locks prove the long-form pipeline is durable. Short-form is a structurally different layout (9:16, split-screen, avatar below clip) that Phase 2 must be able to support from day one — if short-form isn't proven, Phase 2 can't ship an alpha Twitch product because Twitch clips are short-form by default.

**No calendar date attached to Phase 2 start.** It starts the week Rob says "all three gates passed." Optimistic estimate: late April 2026. Realistic estimate: early May 2026. Pessimistic: mid-May 2026 if HeyGen/Anthropic outages eat another week.

---

## 3. Cross-reference — what's already in `AUTONOMOUS_PRODUCTION_ROADMAP.md`

Do NOT re-read stack architecture decisions here. They are locked in section 12 of the roadmap doc. This build spec builds on top of those decisions:

- **12.1** The frontend/backend split diagram
- **12.2** Why Vercel+Railway beats Railway-only
- **12.3** Full stack table (Next.js, Tailwind, shadcn/ui, Clerk, Postgres, R2, etc.)
- **12.4** Phase-by-phase migration path
- **12.5** What Phase 1 work does NOT change
- **12.6** Rob's anti-patterns (stupid simple, no pipeline view, no QA detail to customers)
- **12.7** Figma → dev workflow
- **12.8** 3-tier binary storage
- **12.9** Still-open sub-decisions (Clerk vs Supabase Auth, Sentry choice, App Router vs Pages Router)

Phase 2 additions captured in this doc:
- Section 4 — Monorepo + folder structure
- Section 5 — Library choices (React Query, Zod) not in roadmap yet
- Section 6 — Railway service breakdown (API, worker, assembly)
- Section 7 — API contract reference
- Sections 8–13 — 6-week execution plan
- Section 14 — Figma structure
- Section 15 — Dual palette note
- Section 16 — Developer profile guidance

---

## 4. Monorepo + folder structure

**Repository:** same `cwn-production` repo. Phase 2 restructures it into a monorepo layout without losing existing Phase 1 code.

### Top-level

```
cwn-production/
├── apps/
│   ├── web/                # Next.js frontend (NEW in Phase 2)
│   ├── api/                # Railway Node/Express backend (existing server.js migrated here)
│   ├── worker/             # Railway background job runner (NEW in Phase 2)
│   └── ffmpeg-service/     # Optional separate assembly service (PHASE 3+, not now)
├── packages/
│   ├── ui/                 # Shared React components (shadcn/ui + custom)
│   ├── config/             # env parsing, constants, feature flags
│   ├── types/              # Shared TypeScript types (job shapes, API contracts)
│   └── lib/                # Shared helpers, API client, auth helpers
├── tools/                  # Existing tools/ directory (clipzworld_newscast.html, etc.) stays
├── data/                   # Existing runtime state stays (gitignored)
├── output/                 # Existing MP4 output stays (gitignored, later moves to R2)
├── tmp/                    # Existing hot state stays (gitignored)
├── assets/                 # Music library, brand assets (moves to R2 in Phase 3)
├── scripts/                # Existing standalone scripts stay
├── test/                   # Existing + new test directories
└── docs/archive/           # Existing archive stays
```

### `apps/web/` (Next.js frontend, detailed)

```
apps/web/
├── app/
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   └── signup/page.tsx
│   ├── (dashboard)/
│   │   ├── layout.tsx           # Customer nav shell
│   │   ├── dashboard/page.tsx
│   │   ├── schedule/page.tsx
│   │   ├── videos/page.tsx
│   │   ├── videos/[id]/page.tsx
│   │   ├── accounts/page.tsx
│   │   ├── billing/page.tsx
│   │   └── settings/page.tsx
│   ├── (operator)/
│   │   ├── layout.tsx           # Operator nav shell (role-gated)
│   │   ├── operator/page.tsx
│   │   ├── operator/jobs/page.tsx
│   │   ├── operator/clients/page.tsx
│   │   ├── operator/clients/[id]/page.tsx
│   │   ├── operator/alerts/page.tsx
│   │   └── operator/metrics/page.tsx
│   ├── api/                     # Next.js API routes (minimal — most calls go to Railway API)
│   └── layout.tsx               # Root layout with Clerk provider, Tailwind, theme
├── components/
│   ├── layout/                  # Sidebar, top nav, page container
│   ├── dashboard/               # KPI cards, next-post card, system-status card
│   ├── jobs/                    # Job card, status badge, progress bar
│   ├── schedule/                # Weekly calendar, schedule picker
│   ├── onboarding/              # Stepper, Twitch connect, brand config
│   ├── billing/                 # Plan card, payment method, upgrade CTA
│   └── operator/                # Operator-only components (alerts panel, rollback button)
├── lib/
│   ├── api/                     # API client (calls Railway backend)
│   ├── auth/                    # Clerk helpers, role check utilities
│   ├── hooks/                   # React Query hooks for data fetching
│   └── utils/                   # Generic helpers
├── public/                      # Static assets (logo, icons)
├── tailwind.config.ts
├── next.config.ts
└── package.json
```

**Notes on the structure:**

- Next.js App Router with route groups `(auth)`, `(dashboard)`, `(operator)` for shared layouts without affecting URL paths
- Operator routes are rendered by the same Next.js app but wrapped in a role check at the layout level — if `session.role !== 'operator' && session.role !== 'admin'`, redirect to `/dashboard`
- Components organized by feature domain, NOT by component type — `components/jobs/` instead of `components/cards/` + `components/badges/` — easier to find related code
- `lib/api/` is the ONLY place that talks to the Railway backend; everything else imports from here
- `lib/hooks/` uses React Query (TanStack Query v5) for server state, not Redux or Zustand for remote data

### `apps/api/` (Railway backend, migrated from existing `server.js`)

```
apps/api/
├── src/
│   ├── index.ts              # Express app entry point (was server.js)
│   ├── routes/               # Route handlers (one file per resource)
│   │   ├── auth.ts
│   │   ├── onboarding.ts
│   │   ├── jobs.ts
│   │   ├── videos.ts
│   │   ├── schedule.ts
│   │   ├── integrations.ts
│   │   ├── operator.ts
│   │   ├── publish.ts
│   │   └── health.ts
│   ├── middleware/
│   │   ├── auth.ts           # Role check middleware
│   │   ├── rate-limit.ts     # Per-endpoint rate limiting
│   │   └── error-handler.ts  # Centralized error responses
│   ├── db/
│   │   ├── schema.ts         # Postgres schema (via Drizzle or Prisma)
│   │   ├── migrations/
│   │   └── client.ts
│   ├── services/             # Business logic extracted from server.js
│   │   ├── gemini.ts         # Existing Gemini helpers
│   │   ├── claude.ts         # Existing Claude QA
│   │   ├── heygen.ts         # Existing HeyGen client
│   │   ├── twitch.ts         # Existing Twitch GQL client
│   │   ├── news.ts           # News scraping (post Fix 25a)
│   │   ├── ffmpeg.ts         # FFmpeg orchestration
│   │   └── upload-post.ts    # Upload-Post publishing
│   └── lib/
│       ├── clients/          # lib/clients/ moved here
│       ├── config.ts         # CONFIG object from lib/config.js
│       └── logger.ts         # lib/logger.js
├── package.json
└── tsconfig.json
```

**Migration strategy for `server.js`:**

1. Rename `server.js` → `apps/api/src/index.ts` (add TypeScript gradually)
2. Split 10k-line monolith into route files by extracting `app.get()` / `app.post()` handlers
3. Extract business logic into `services/` modules
4. Keep existing `lib/config.js`, `lib/metrics.js`, `lib/logger.js` as-is, move to `apps/api/src/lib/`
5. Route file naming matches the URL path (`routes/jobs.ts` handles `/jobs/*`)
6. NO rewrite of the pipeline — FFmpeg, HeyGen, Gemini, Claude orchestration code stays functionally identical

This is the "move, don't rewrite" principle from the roadmap. Phase 2 is a restructuring pass, not a rebuild.

### `apps/worker/` (NEW in Phase 2)

Background job runner that handles scheduled executions. Separate process from the API service so long-running FFmpeg doesn't block HTTP responses.

```
apps/worker/
├── src/
│   ├── index.ts              # Worker entry point
│   ├── scheduler.ts          # Cron logic — fires scheduled jobs at calculated kickoff times
│   ├── queue.ts              # Job queue (in-process initially, BullMQ+Redis later if needed)
│   ├── handlers/
│   │   ├── news-scrape.ts
│   │   ├── nba-scrape.ts
│   │   ├── twitch-scrape.ts
│   │   ├── script-gen.ts
│   │   ├── heygen-submit.ts
│   │   ├── heygen-poll.ts
│   │   ├── assemble.ts
│   │   ├── gate-qa.ts
│   │   └── publish.ts
│   └── lib/                  # shares @cwn/lib from packages/lib
├── package.json
└── tsconfig.json
```

**What the worker does that the API doesn't:**

- Polls scheduled jobs table every 60s, computes kickoff time for each job = deliveryTime - estimatedPipelineDuration - buffer
- Enqueues jobs when their kickoff time arrives
- Executes pipeline stages sequentially per job
- Updates job state in Postgres as stages complete
- Fires 3-channel alerts on hard failures (customer dashboard, operator dashboard, Slack webhook)
- Manages retry caps per stage

**What the API does that the worker doesn't:**

- Serves HTTP requests from the Next.js frontend
- Authentication and session handling (via Clerk SDK)
- CRUD on clients, schedules, presets, brand configs
- Triggers one-off jobs (manual "run now" from operator dashboard)
- Read-only queries for dashboard data

**Communication between API and worker:** via Postgres (shared job table) and optional Redis pub/sub for real-time status updates. No HTTP calls between them.

### `apps/ffmpeg-service/` (DEFERRED to Phase 3+)

Initially FFmpeg orchestration lives in the worker. If load grows and FFmpeg becomes a bottleneck, split into a dedicated service. Phase 2 does NOT build this — the `apps/ffmpeg-service/` directory doesn't exist yet.

---

## 5. Library choices locked for Phase 2

Additions to the stack beyond what's in `AUTONOMOUS_PRODUCTION_ROADMAP.md` section 12:

| Purpose | Library | Why |
|---|---|---|
| **Server state / data fetching** | React Query (TanStack Query v5) | Handles loading/error/refetch/mutation states for API calls, first-class Next.js App Router support, no Redux needed |
| **Form validation + types** | Zod | Runtime validation + TypeScript type inference, shared schema between frontend and backend via `packages/types` |
| **ORM / query builder** | Drizzle ORM (first choice) OR Prisma (fallback) | Drizzle is lighter, better TypeScript inference, closer to raw SQL; Prisma has more tooling. Pick during Week 1. |
| **API client** | Native `fetch` or `ky` | Small footprint, no axios bloat. axios stays in `apps/api/` backend for existing external API calls. |
| **TypeScript** | TS 5.x strict mode | Required everywhere in Phase 2. Existing `server.js` migrates to `.ts` gradually during Phase 2. |
| **Monorepo tool** | pnpm workspaces + Turborepo | pnpm handles dependency deduplication, Turborepo handles build caching across packages |
| **Testing (unit)** | Vitest | Faster than Jest, same API, first-class TypeScript |
| **Testing (E2E)** | Playwright (already installed per package.json) | Reuse existing setup from `qa:install` npm script |
| **Linting** | ESLint 9 (flat config) + TypeScript ESLint | Already in package.json, upgrade to flat config during Week 1 |
| **Formatting** | Prettier | Zero-config, matches existing style |
| **Error tracking** | Sentry (first choice) OR Logtail (fallback) | Pick during Phase 2 when errors actually need aggregation. Free tier covers launch. |

**Anti-library list** — do NOT add these, even if they're tempting:

- **Redux / Redux Toolkit** — React Query handles all the server state; local UI state uses `useState`. No global store needed.
- **Zustand / Jotai** — same reason. Avoid until proven necessary.
- **MUI / Ant Design / Chakra** — conflicts with shadcn/ui. Stick with Tailwind + shadcn primitives.
- **axios on the frontend** — adds ~30KB for no benefit over native `fetch`. axios stays backend-only.
- **Moment.js** — use native `Intl.DateTimeFormat` or `date-fns` for date math.
- **Lodash** — ES2023 has most of what's needed natively. Only import specific Lodash functions if there's a real perf gap.
- **Socket.io** — don't add real-time until the dashboard genuinely needs it. Polling every 10s via React Query is fine for job status.

---

## 6. Railway backend service breakdown

Services Railway will run, mapped to the monorepo structure:

### 6.1 API service (`apps/api/`)

**Purpose:** handle HTTP requests from the Next.js frontend.

**Endpoints:** see section 7 for the full API contract.

**Scaling:** 1 replica for alpha (Weeks 1–6). Multiple replicas behind Railway's load balancer later when customer count grows.

**Environment variables:**
- All existing `HEYGEN_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, etc. (from current `.env`)
- `DATABASE_URL` (Railway Postgres add-on)
- `CLERK_SECRET_KEY` (new for Phase 2)
- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` (new for Phase 2)
- `SLACK_ALERT_WEBHOOK_URL` (new for Phase 2)
- `SENTRY_DSN` (new for Phase 2, if Sentry picked)

**Health check:** `GET /health` returns 200 + `{status, uptime, version}`. Railway's health check hits this every 30s.

### 6.2 Worker service (`apps/worker/`)

**Purpose:** run scheduled jobs and pipeline execution.

**Scaling:** 1 replica for alpha. Horizontal scaling is non-trivial (job state in Postgres with row-level locking needed to prevent double-execution). Defer until Phase 3.

**Environment variables:** same as API service + any worker-specific tuning flags.

**Health check:** `GET /health` on an internal port for Railway's monitor, returns `{status, lastCronTick, activeJobs}`.

**Lifecycle:** long-running. Restarts on crash via Railway auto-restart. No graceful shutdown handling in Phase 2 — a mid-assembly crash results in a job marked `failed` on restart + operator alert.

### 6.3 Postgres (Railway add-on)

**Purpose:** persistent state for all customer data, job history, schedules, presets.

**Scaling:** Railway Starter plan (free tier) for alpha. Upgrade to Pro/Team as customer count grows.

**Schema:** see `apps/api/src/db/schema.ts` (Week 2 deliverable). Initial tables:

```sql
-- users: auth + role assignment
CREATE TABLE users (
  id           TEXT PRIMARY KEY,      -- Clerk user ID
  email        TEXT UNIQUE NOT NULL,
  name         TEXT,
  role         TEXT NOT NULL,         -- 'customer' | 'operator' | 'admin'
  client_id    TEXT,                  -- links to clients.id, null for operators
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- clients: tenant accounts (Rob = client_000_rob)
CREATE TABLE clients (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  plan         TEXT NOT NULL,         -- 'starter' | 'standard' | 'premium' | 'unlimited_internal'
  status       TEXT NOT NULL,         -- 'active' | 'suspended' | 'cancelled'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata     JSONB                  -- flexible extension point
);

-- brand_configs: per-client chrome settings (hex colors, show name, etc.)
CREATE TABLE brand_configs (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id),
  content_type    TEXT NOT NULL,       -- 'twitch' | 'nba' | 'news'
  primary_hex     TEXT NOT NULL,
  accent_hex      TEXT NOT NULL,
  show_name       TEXT NOT NULL,
  tagline         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id, content_type)
);

-- client_integrations: platform OAuth tokens + credentials
CREATE TABLE client_integrations (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL REFERENCES clients(id),
  platform      TEXT NOT NULL,         -- 'twitch' | 'youtube' | 'tiktok' | 'instagram' | 'upload_post'
  credentials   JSONB NOT NULL,        -- encrypted tokens / API keys
  connected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  status        TEXT NOT NULL,         -- 'connected' | 'expired' | 'revoked'
  UNIQUE(client_id, platform)
);

-- jobs: full job history
CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id),
  content_type    TEXT NOT NULL,
  form_type       TEXT NOT NULL,       -- 'compilation' | 'short'
  status          TEXT NOT NULL,       -- 'queued' | 'pulling_clips' | 'scripting' | 'rendering' | 'assembling' | 'publishing' | 'published' | 'failed'
  stage           TEXT,                -- granular sub-stage within status
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scheduled_for   TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  progress        INTEGER DEFAULT 0,   -- 0-100
  script          TEXT,
  gate1_score     INTEGER,
  gate2_score     INTEGER,
  gate3_score     INTEGER,
  metadata        JSONB                -- flexible for per-content-type extras
);

-- schedules: recurring job kickoff patterns
CREATE TABLE schedules (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id),
  content_type    TEXT NOT NULL,
  form_type       TEXT NOT NULL,
  days_of_week    INTEGER[] NOT NULL,  -- [0-6], 0=Sunday
  time_of_day     TEXT NOT NULL,       -- HH:MM
  timezone        TEXT NOT NULL,
  platforms       TEXT[] NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- publish_records: per-platform publish outcomes
CREATE TABLE publish_records (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  client_id       TEXT NOT NULL REFERENCES clients(id),
  platform        TEXT NOT NULL,
  published_url   TEXT,
  upload_post_request_id TEXT,
  status          TEXT NOT NULL,       -- 'pending' | 'submitted' | 'published' | 'failed'
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

-- gate_results: QA gate history (supersedes output/qa_failures/ JSON logs)
CREATE TABLE gate_results (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id),
  gate_number  INTEGER NOT NULL,       -- 1-7
  outcome      TEXT NOT NULL,          -- 'pass' | 'manual_review' | 'fail'
  score        INTEGER,
  report       JSONB,                  -- full gate report structure
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- alerts: operator-visible incident log
CREATE TABLE alerts (
  id              TEXT PRIMARY KEY,
  client_id       TEXT REFERENCES clients(id),
  job_id          TEXT REFERENCES jobs(id),
  severity        TEXT NOT NULL,       -- 'info' | 'warning' | 'error' | 'critical'
  category        TEXT NOT NULL,       -- 'heygen_outage' | 'anthropic_529' | 'scrape_failure' | 'gate3_fail' | etc.
  message         TEXT NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- billing_records: Stripe integration (Week 6+)
CREATE TABLE billing_records (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan            TEXT NOT NULL,
  amount_cents    INTEGER,
  period_start    TIMESTAMPTZ,
  period_end      TIMESTAMPTZ,
  status          TEXT NOT NULL,       -- 'active' | 'past_due' | 'cancelled'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Migration from JSON files:** one-time script in Week 1 reads `data/jobs.json`, `data/episode_counters.json`, `data/upload_status.json` and writes to Postgres with `client_id: 'client_000_rob'` on every row. JSON files stay in `data/` gitignored as backup for 30 days, then deleted.

### 6.4 Persistent volume (Railway add-on)

**Purpose:** hot job state only (tmp/ renders, in-flight pipeline artifacts).

**Size:** 10 GB for alpha. Cleanup runs every 24h to delete files older than 24 hours.

**What doesn't live on the volume:** music library, final MP4s, customer uploads, Gemini QA evidence. Those all live on R2 (see section 6.5).

### 6.5 Cloudflare R2 (external storage)

**Purpose:** cold storage for binary assets.

**Buckets:**
- `cwn-music-library` — shared music tracks (migrated from `assets/audio/` during Phase 2)
- `cwn-customer-uploads` — customer-provided source material per client
- `cwn-output-archive` — produced MP4s archived here after publishing (optional, for customer re-download)
- `cwn-qa-evidence` — Gemini QA frame extractions, gate report attachments (optional)

**Access pattern:** signed URLs for customer downloads, direct SDK access for backend services. No public bucket access.

---

## 7. API contract reference

The Next.js frontend talks to the Railway API service only. Worker service is internal, no HTTP exposure.

Full endpoint list to be built across Weeks 2–6. Shape captured here so frontend and backend can develop in parallel.

### 7.1 Auth

```
POST   /auth/login          { email, password }              → { user, sessionToken }
POST   /auth/logout                                            → 204
GET    /auth/session                                           → { user }
```

User shape:
```typescript
type User = {
  id: string;
  email: string;
  name?: string;
  role: 'customer' | 'operator' | 'admin';
  clientId?: string;  // null for operator/admin without a specific client
};
```

### 7.2 Onboarding

```
POST   /onboarding/start                                      → { stepper: {currentStep: 1, totalSteps: 5} }
POST   /onboarding/connect-twitch  { twitchUsername }         → { ok, channelId, profileImage }
POST   /onboarding/set-platforms   { platforms: [] }          → { ok }
POST   /onboarding/set-brand       { primaryHex, accentHex, showName, tagline } → { ok }
POST   /onboarding/set-schedule    { daysOfWeek, timeOfDay, timezone } → { ok }
POST   /onboarding/finish                                     → { ok, firstJobQueued: boolean }
GET    /onboarding/status                                     → { complete, currentStep }
```

### 7.3 Jobs

```
GET    /jobs                                                  → { jobs: Job[], total }
GET    /jobs/:id                                              → { job: Job, timeline, gateResults, publishRecords }
POST   /jobs                      { contentType, formType, source, scheduledFor? } → { jobId }
POST   /jobs/:id/retry                                        → { ok }
POST   /jobs/:id/cancel                                       → { ok }
```

Job shape:
```typescript
type Job = {
  id: string;
  clientId: string;
  contentType: 'twitch' | 'nba' | 'news';
  formType: 'compilation' | 'short';
  status: 'queued' | 'pulling_clips' | 'scripting' | 'rendering' | 'assembling' | 'publishing' | 'published' | 'failed';
  stage?: string;
  platforms: string[];
  createdAt: string;
  scheduledFor?: string;
  startedAt?: string;
  completedAt?: string;
  progress: number;  // 0-100
};
```

**Customer-facing job endpoints return a SIMPLIFIED Job shape** — hiding `gate1_score`, `gate2_score`, `gate3_score`, `script`, `metadata`. Operator-facing endpoints return the full shape.

### 7.4 Videos (published outputs)

```
GET    /videos                                                → { videos: Video[], total }
GET    /videos/:id                                            → { video: Video, publishRecords }
```

### 7.5 Schedule

```
GET    /schedule                                              → { schedules: Schedule[] }
POST   /schedule                  { daysOfWeek, timeOfDay, timezone, platforms } → { schedule }
PATCH  /schedule/:id              { ...updates }              → { schedule }
DELETE /schedule/:id                                          → 204
```

### 7.6 Integrations

```
POST   /integrations/twitch/connect          { twitchUsername }    → { ok, channelId }
POST   /integrations/upload-post/connect     { profileName, apiKey } → { ok }
POST   /integrations/youtube/connect                                → OAuth redirect URL
POST   /integrations/tiktok/connect                                 → OAuth redirect URL
POST   /integrations/instagram/connect                              → OAuth redirect URL
GET    /integrations                                                → { integrations: Integration[] }
DELETE /integrations/:platform                                      → 204
```

### 7.7 Operator-only

**All operator endpoints enforce `role === 'operator' || role === 'admin'` at the middleware level. 403 otherwise.**

```
GET    /operator/clients                                     → { clients: Client[] }
GET    /operator/clients/:id                                 → { client, jobs, alerts }
GET    /operator/jobs                                        → { jobs: Job[] }  // all clients
GET    /operator/alerts                                      → { alerts: Alert[] }
POST   /operator/alerts/:id/acknowledge                     → { ok }
GET    /operator/metrics                                     → { metricsDashboard }
POST   /operator/jobs/:id/rollback     { targetStage }      → { ok, newStage }
POST   /operator/jobs/:id/advance      { gate }             → { ok, newStage }
POST   /operator/jobs/:id/retry                             → { ok }
```

The rollback/advance endpoints match the existing `POST /job/:id/rollback` and `POST /job/:id/advance` from `server.js` (shipped `eac1073`). They move to the operator namespace in Phase 2 — only operators can fire them.

---

## 8. Week 1 — Foundation and app shell

**Goal:** stand up the product skeleton without touching heavy pipeline logic.

**Build:**

1. **Monorepo restructure**
   - Create `apps/`, `packages/` directories
   - Move `server.js` → `apps/api/src/index.ts` (rename, no refactor yet)
   - Create `apps/web/` empty Next.js 15 project with TypeScript, Tailwind, App Router
   - Create `apps/worker/` empty scaffolding
   - Add `packages/ui/`, `packages/config/`, `packages/types/`, `packages/lib/` with `package.json` stubs
   - Configure pnpm workspaces root + Turborepo `turbo.json`
   - Verify `pnpm install` at repo root installs all dependencies correctly

2. **Railway project setup**
   - Create Railway project `cwn-production-staging`
   - Deploy `apps/api/` service linked to the repo (Railway monorepo support)
   - Provision Railway Postgres add-on
   - Provision persistent volume add-on (10 GB)
   - Verify `GET /health` returns 200 on the Railway URL

3. **Vercel project setup**
   - Connect `apps/web/` to Vercel via GitHub integration
   - Configure build command for monorepo (`pnpm --filter web build`)
   - Deploy empty Next.js app
   - Verify Vercel preview URL loads the default Next.js homepage

4. **Frontend app shell**
   - `app/(auth)/login/page.tsx` — placeholder
   - `app/(auth)/signup/page.tsx` — placeholder
   - `app/(dashboard)/layout.tsx` — sidebar + top nav (customer nav items)
   - `app/(dashboard)/dashboard/page.tsx` — placeholder "dashboard" heading
   - `app/(dashboard)/schedule/page.tsx` — placeholder
   - `app/(dashboard)/videos/page.tsx` — placeholder
   - `app/(dashboard)/settings/page.tsx` — placeholder

5. **Shared design tokens in code**
   - `packages/ui/src/tokens.ts` exports colors, spacing, typography scales
   - `tailwind.config.ts` in `apps/web/` consumes tokens
   - Define status badge component with 5 states (queued, processing, publishing, published, failed)

6. **Multi-tenant data model preparation**
   - `apps/api/src/db/schema.ts` — initial Drizzle schema (or Prisma) with `users`, `clients`, `jobs`, `schedules`, `brand_configs` tables
   - One-time migration script to import existing `data/jobs.json` into Postgres with `client_id: 'client_000_rob'`
   - Keep existing JSON files as backup for 30 days

**Deliverable:** a working empty product shell with auth placeholders, navigation skeleton, Railway+Postgres backend reachable, Vercel frontend deployed, monorepo builds successfully via `pnpm build`.

**Realistic time estimate:** 1.5–2 calendar weeks for one full-time engineer. Rob's paste optimistically called this "Week 1" — in practice monorepo tooling, TypeScript migration, and first Railway deploy always eat 50% more time than estimated.

**Flag for sprint planning:** if Jira sprints run 2 weeks each, Week 1 of this doc maps to Sprint 1. If sprints are 1 week, Sprint 1 = Week 1 foundation stubs only, Sprint 2 = finishing the monorepo setup.

---

## 9. Week 2 — Auth, client model, and onboarding v1

**Goal:** let a beta user enter the system and create a usable account.

**Build:**

1. **Auth integration**
   - Add Clerk SDK to `apps/web/`
   - Wrap root layout with Clerk provider
   - Replace login/signup placeholders with Clerk's `<SignIn />` / `<SignUp />` components
   - Add role-based middleware to `apps/api/`: read Clerk JWT from `Authorization: Bearer` header, validate, attach `user.role` and `user.clientId` to `req`
   - Operator role creation: Rob's account is seeded as `admin` via manual DB insert; all other signups default to `customer`

2. **Database tables**
   - Run first Postgres migration: creates `users`, `clients`, `client_integrations`, `brand_configs`, `schedules`, `jobs`, `publish_records`, `gate_results`, `alerts` tables per section 6.3
   - Seed `client_000_rob` and Rob's `admin` user from the existing `.env` email

3. **Onboarding v1**
   - `app/(dashboard)/onboarding/page.tsx` — multi-step wizard using shadcn/ui `<Tabs>` or a custom stepper
   - Step 1: Create account (handled by Clerk signup, auto-redirects to onboarding)
   - Step 2: Enter Twitch username (POST `/onboarding/connect-twitch`)
   - Step 3: Select target platforms (YouTube, TikTok, Instagram)
   - Step 4: Choose output mode (default = "Auto Clips", beta = "Enhanced Videos")
   - Step 5: Pick publish schedule (days, time, timezone)
   - Step 6: Review + "Start Engine" button
   - All onboarding state persists to DB incrementally (no lost progress on refresh)

4. **Minimal settings page**
   - `app/(dashboard)/settings/page.tsx` — shows + edits:
     - Show name (from `brand_configs.show_name`)
     - Twitch username (from `client_integrations` where platform=twitch)
     - Platforms
     - Timezone

**Deliverable:** a beta user can create an account, complete onboarding, land on the dashboard.

**Constraint:** no real job execution yet. Onboarding just configures the client account. Clicking "Start Engine" at step 6 persists the schedule but does NOT immediately run a job.

---

## 10. Week 3 — Twitch-first job creation and dashboard

**Goal:** turn onboarding data into actual jobs.

**Build:**

1. **Job creation endpoint**
   - `POST /jobs` in `apps/api/src/routes/jobs.ts`
   - Accepts `{ contentType: 'twitch', formType: 'short', source: { twitchUsername }, scheduledFor? }`
   - Validates Twitch integration is connected
   - Creates `jobs` row with `status: 'queued'`, `client_id` from session
   - Returns `{ jobId }`

2. **Dashboard page**
   - `app/(dashboard)/dashboard/page.tsx`
   - Shows three card sections:
     - **Next scheduled post** (from schedules table, calculates next kickoff time)
     - **Jobs in progress** (active jobs with status !== 'published' && !== 'failed')
     - **Latest published videos** (last 5 from publish_records)
   - Uses React Query for polling (`refetchInterval: 10_000`)
   - Empty states for each section when no data

3. **Job status states + timeline**
   - Define job status enum in `packages/types/`:
     - `queued` — created, waiting for scheduler
     - `pulling_clips` — Twitch GQL fetch in progress
     - `scripting` — Gemini script gen + Claude QA
     - `rendering` — HeyGen segment rendering
     - `assembling` — FFmpeg concat + chrome burn
     - `publishing` — Upload-Post submit
     - `published` — final success
     - `failed` — hard fail, alert fired
   - Job detail page shows timeline of state transitions with timestamps
   - Each state has a customer-friendly label (e.g., "Pulling your clips" instead of "pulling_clips")

4. **No QA gate detail in customer UI**
   - Operator view has full gate reports
   - Customer view shows only: queued → processing → published OR failed
   - "Processing" is the umbrella label for pulling_clips / scripting / rendering / assembling — customer doesn't need to know which specific substage

**Deliverable:** a creator can trigger a Twitch job (manually via "Run now" button OR via the scheduler) and see progress in the dashboard.

**Notes for the Week 3 scope:**

- The actual pipeline execution (Gemini, Claude, HeyGen, FFmpeg) is CALLED from the worker, which is same code as the existing `server.js` pipeline just moved into `apps/worker/src/handlers/`. No new pipeline logic.
- Worker polls for queued jobs every 60s, picks one, executes it, updates status transitions
- For Week 3, the worker fires jobs ONLY on explicit "Run now" — no schedule-driven kickoff yet (that's Week 4)

---

## 11. Week 4 — Schedule engine and Railway execution

**Goal:** move from manual triggering to product behavior.

**Build:**

1. **Schedule model**
   - `schedules` table: `client_id`, `content_type`, `form_type`, `days_of_week[]`, `time_of_day`, `timezone`, `platforms[]`, `active`
   - UI: `app/(dashboard)/schedule/page.tsx` with weekly calendar view
   - Creator picks which days + time + timezone
   - Can have multiple schedules per client (e.g., "Tuesdays 2pm" AND "Fridays 6pm")

2. **Worker cron logic**
   - Worker runs a cron every 60s checking the schedules table
   - For each active schedule, compute "next kickoff time" = next occurrence of (day, time, timezone) - estimatedPipelineDuration - 10min buffer
   - If now >= kickoff time AND no job for this schedule exists in the last hour, enqueue a new job
   - Job creation triggers the pipeline same as the Week 3 manual path

3. **Persist all job state transitions to Postgres**
   - Every status change writes a row to `jobs` updates + an `alerts` row if transition is 'failed'
   - Operator dashboard reads from `alerts` table (Week 6 deliverable)

4. **Operator-only failures page**
   - `app/(operator)/operator/alerts/page.tsx`
   - Lists active failures (alerts where acknowledged_at IS NULL)
   - Quick actions: retry, rollback, mark acknowledged
   - Role-gated: 403 if user is not operator or admin

**Deliverable:** jobs start automatically on Railway based on the creator's schedule, without manual "Run now" clicks.

**Scope constraints for Week 4:**

- Scheduler is naive: polling every 60s, no priority queue, no DAG of dependent jobs
- Retry logic: per-stage retry caps from the roadmap section 5.1 are enforced but simple (no exponential backoff sophistication)
- Scheduled-delivery accuracy target is +/-15 min for alpha (tighten to +/-5 min in Week 6)

---

## 12. Week 5 — Publishing flow and customer-ready outputs

**Goal:** complete the alpha loop from clip pull to delivered result.

**Build:**

1. **Publishing wire-up**
   - `apps/worker/src/handlers/publish.ts` — migrated from existing `server.js` publish logic
   - Submits to Upload-Post API
   - Records each platform's upload_post_request_id in `publish_records` table
   - Polls Upload-Post status every 60s until job_id completes or fails
   - Updates `publish_records.status` and `published_url` on completion

2. **Customer video history page**
   - `app/(dashboard)/videos/page.tsx` — grid of video cards
   - Each card: thumbnail, title, date, per-platform status badges, click → video detail
   - Video detail: preview player, platforms + links, status timeline, metadata

3. **Customer-provided thumbnail support**
   - Onboarding step 4 adds optional "upload custom thumbnail" per video OR per schedule
   - If uploaded, FFmpeg assembly uses the custom thumbnail in the Canva/Upload-Post submission
   - If not, existing `generateThumbnail` helper runs as default

4. **Generated metadata persistence**
   - For each published video, store in DB:
     - Title (from `generatePublishCopy`)
     - Description
     - Hashtags (comma-separated)
     - Tags
     - First pinned comment (YouTube-specific)
     - Chapters (YouTube-specific, when applicable)
   - Customer can view (read-only) in the video detail page
   - Operator can edit in the operator job detail page

5. **Short-form path support**
   - Twitch-first alpha is short-form only
   - Worker handler branches on `form_type === 'short'`:
     - Short: 9:16 split-screen assembly via existing `assembleShortForm()` function
     - No stitched long-sequence output required
   - Long-form is available as a preset option but not the default for Twitch alpha

**Deliverable:** a creator can see published outputs and per-platform destination status inside the app. Videos arrive on YouTube/TikTok/Instagram per the schedule without creator intervention.

**Flag for sprint planning:** Week 5 is the heaviest week because it wires together multiple systems. If any prior week runs over, Week 5 is the natural place to absorb the slip since publishing can ship in Week 6 without alpha blocking.

---

## 13. Week 6 — Operator layer, beta hardening, first user test

**Goal:** make the alpha usable by real beta creators without drowning Rob in support.

**Build:**

1. **Operator-only views**
   - `app/(operator)/operator/clients/page.tsx` — client list with status + activity
   - `app/(operator)/operator/jobs/page.tsx` — all jobs across all clients, filterable
   - `app/(operator)/operator/alerts/page.tsx` — active failures (Week 4 deliverable, hardened in Week 6)
   - `app/(operator)/operator/metrics/page.tsx` — per-client job counts, success rates, error patterns

2. **Customer-friendly failure messages**
   - When a job status = 'failed', customer dashboard shows:
     - "We had trouble processing this one. Our team has been notified and will look into it." (not the raw error)
     - No stack traces, no retry button (operator handles that)
   - Operator dashboard shows full error detail

3. **Internal observability**
   - Per-job timings: start, each stage completion, total
   - Failure reason categorization (HeyGen outage / Anthropic 529 / scraper failure / assembly error / etc.)
   - Publish success rate per client per content type

4. **Manual beta onboarding checklist**
   - Hand-holding process for first 3-5 creators
   - Rob personally onboards each one (Clerk invite → walks them through onboarding → watches first job succeed)
   - Documented in an internal runbook so future support reps can follow the same process

5. **In-app feedback capture**
   - Simple widget on dashboard: "Was this useful?" / "What would you change?"
   - Responses go to `feedback` table (new, minimal schema)
   - Rob reviews weekly

**Deliverable:** closed alpha with 3-5 Twitch creators using the product with minimal support.

**Success criteria for the 6-week build:**

By end of Week 6, **at least one Twitch creator** can:

1. Sign up at the Vercel-hosted frontend
2. Complete onboarding (enter Twitch username, select platforms, set schedule)
3. Receive daily short-form videos automatically published to YouTube/TikTok/Instagram
4. Do all of the above WITHOUT Rob opening the operator dashboard to intervene

That's the alpha milestone. If it works, Phase 2 is done and Phase 3 (automation layer) begins.

---

## 14. Figma structure

**One Figma file with 5 top-level pages. Screen element detail lives inside Figma frames, not duplicated here.**

### Page 1 — Foundations

Design tokens that every other page references:

- **Colors:** see section 15 (dual palette note)
- **Typography:** Inter or Geist family, weights 400/500/600/700, type scale matching Tailwind defaults
- **Spacing scale:** 4, 8, 12, 16, 24, 32, 48 px
- **Border radius:** 4, 8, 12, 16 px
- **Shadows:** sm, md, lg matching shadcn/ui defaults
- **Icon system:** Lucide (shadcn/ui default)
- **Status badges:** queued (neutral gray), processing (blue), publishing (amber), published (green), failed (red)

### Page 2 — Components

Reusable component library matching the monorepo's `packages/ui/` structure:

**Layout:** Sidebar, Top nav, Page header, Page container

**Core UI:** Button (primary/secondary/ghost/destructive variants), Input field, Dropdown, Toggle switch, Modal, Stepper, Tab group, Empty state, Alert banner

**Product-specific:**
- Job Card (title, status badge, platform chips, timestamp, progress bar)
- Video Card (thumbnail, title, platform badges, publish status, quick actions)
- Platform Chip (YouTube, TikTok, Instagram, Twitch — each with brand color + icon)
- Schedule Picker (days grid, time picker, timezone dropdown)
- File/Upload Card (drag-drop zone for custom thumbnails)
- Preview Card (video preview with metadata overlay)
- KPI Card (dashboard summary numbers)

### Page 3 — Customer App

**10 screens** matching the routes in `apps/web/app/(auth)/` and `apps/web/app/(dashboard)/`:

1. **Login** — email, password, login button, "create account" link
2. **Signup** — email, password, confirm password, continue
3. **Onboarding wizard** (5 steps, single screen with stepper):
   - Step 1: Twitch input + Connect button
   - Step 2: Platform toggles (YouTube, TikTok, Instagram)
   - Step 3: Output mode (Auto Clips default, Enhanced Videos beta)
   - Step 4: Schedule (days, time, timezone)
   - Step 5: Confirmation + "Start Engine"
4. **Dashboard** — Next scheduled post card, system status card, recent jobs, latest published videos
5. **Videos page** — grid of video cards
6. **Video detail** — preview player, platforms + links, status timeline, metadata (read-only)
7. **Schedule page** — weekly calendar view with editable schedule blocks
8. **Accounts / Integrations** — connected platforms list, reconnect button per platform
9. **Settings** — name, email, timezone, content preferences
10. **Billing** (Phase 4, designed in Phase 2 for placeholder) — plan card, payment method, upgrade button

### Page 4 — Operator App (internal only)

**5 screens** for role-gated operator views. DO NOT link from customer nav.

1. **All Jobs** — full table with filters, client column, status, stage, created-at
2. **Job Detail (advanced)** — pipeline stages, QA gate results, retry button, rollback button, force advance button
3. **Alerts** — failed jobs, severity, quick fix actions
4. **Clients** — list of all clients with status + activity metrics
5. **Metrics** — jobs per day, success rate, failure patterns, per-client breakdown

### Page 5 — Flows (clickable prototypes)

Three prototype flows for user testing before dev starts:

1. **New user → first video:** login → onboarding → dashboard → "Run now" → job appears → published
2. **Job lifecycle:** dashboard → click job → processing → refresh → published (simulated time passage)
3. **Failure recovery:** job fails → customer sees "we're looking into it" → operator sees alert → operator retries → job succeeds

### Dev handoff from Figma

When Figma designs are ready:

1. Export component specs (Tailwind class equivalents via Figma-to-Tailwind plugins)
2. Copy component naming to match `packages/ui/src/components/` structure
3. Hand to frontend engineer with API contract reference (section 7 of this doc)
4. Design review cadence: weekly during Week 1–2, per-screen during Week 3–6

**Rob's incoming deliverables** (flagged, awaiting):
- Shell of wireframes
- React components (initial cut)
- Dev tickets (prior to Jira import)

Placeholders in this doc will be updated when those land.

---

## 15. Dual palette note — broadcast vs product

Two color palettes coexist in CWN. They are NOT unified. Future agents must not try to merge them.

### 15.1 Broadcast palette (video chrome)

Used by `tools/clipzworld_newscast.html` and rendered into video output via Puppeteer + FFmpeg. This is the on-air look.

```css
--navy:  #22304b   /* News primary — newscast chrome background family */
--gold:  #c7af4f   /* News accent — borders, highlight accents */
--gold2: #f0d060   /* Gold highlight variant */
--red:   #c0392b   /* LIVE indicator */
--white: #ffffff
--dark:  #0d1424   /* Deep newscast background */
```

**NBA broadcast palette:** `#0d1424` (dark) + `#c7af4f` (gold) — same as News, different content type  
**Twitch broadcast palette:** `#6A4C93` (muted purple) + `#c7af4f` (gold) — same gold, different primary

Source of truth: `SHARED_NEWSCAST_SET_MIGRATION.md` section 10.1

### 15.2 Product palette (SaaS UI)

Used by the Next.js frontend, shadcn/ui components, customer dashboard. This is the product look.

```css
--primary:    #0B1220   /* Dark navy, product UI dark surface */
--accent:     #F5C542   /* Gold accent for CTAs, highlights */
--bg:         #F8FAFC   /* Light background */
--surface:    #FFFFFF   /* Card surface */
--success:    #22C55E
--warning:    #F59E0B
--error:      #EF4444
--neutral-50: #F8FAFC
--neutral-100: #F1F5F9
--neutral-200: #E2E8F0
--neutral-300: #CBD5E1
--neutral-500: #64748B
--neutral-700: #334155
--neutral-900: #0F172A
```

Source of truth: this doc (section 14 Foundations page).

### 15.3 Why they're not unified

The broadcast palette is designed for **video overlay legibility** against live camera content with varying light. Dark muted tones + warm gold provide contrast against any background footage.

The product palette is designed for **screen UI readability** on monitors in daylight. Brighter colors + white surfaces + standard SaaS conventions reduce cognitive load for dashboard users.

These are two different display targets with different constraints. Forcing them to use the same hex values would compromise both. **Brand identity unifies through the gold thread** (`#c7af4f` broadcast / `#F5C542` product) and the CWN wordmark, not through pixel-identical hex.

---

## 16. Developer profile guidance

When hiring or contracting a frontend engineer for Phase 2, the right profile is:

**Strong in:**
- Next.js + TypeScript (App Router specifically, not legacy Pages Router)
- Design system mindset (has shipped a component library before)
- Dashboard SaaS apps (has built products with job queues, role-based views, async UIs)
- React Query / TanStack Query for server state
- Tailwind + shadcn/ui workflow
- Figma → code handoff
- Understands async job UIs — loading states, error states, polling, optimistic updates

**Not looking for:**
- Landing page / marketing site specialists (too cosmetic for this work)
- Pure backend engineers (the frontend here is the customer-facing product, it has to feel right)
- Pure designers (need someone who can SHIP code, not hand-off to another dev)
- Full-stack generalists who know everything but master nothing (Next.js expertise matters more than breadth)

**Soft skills that matter:**
- Comfortable with ambiguity (spec will evolve during the 6-week build)
- Cares about UX (will push back on bad designs, not just implement pixel-perfect wireframes)
- Writes clean TypeScript (strict mode, no `any`, types are documentation)
- Ships small PRs frequently (no week-long branches)

---

## 17. Jira sprint mapping — when Jira is online

Once Jira is online (per Aider's overnight task shipping the Atlassian client tonight + Rob configuring the `CPD` project), the 6-week plan maps to sprints as follows:

- **Epic:** Phase 2 — Client Layer (CPD-1 or whatever the first epic ID is)
- **Sprints:** 2-week sprints, 3 sprints total for Phases 1-6 build
  - Sprint 1 = Week 1 + Week 2 = Foundation + Auth/Onboarding
  - Sprint 2 = Week 3 + Week 4 = Job creation + Scheduler
  - Sprint 3 = Week 5 + Week 6 = Publishing + Operator layer + Alpha
- **Stories per sprint:** each numbered section in Weeks 1-6 becomes 1 story
- **Sub-tasks:** individual bullet points inside each week become sub-tasks

**Jira labels to attach:**
- `phase-2`
- `frontend` / `backend` / `database` / `design` / `ops`
- `alpha-blocker` for must-have-by-week-6 items
- `post-alpha` for nice-to-have items that can slip

**Story point estimation:** defer until sprint 1 kickoff. Scope feels like ~40-60 story points per sprint at 1.5 engineers full-time, but that's a guess until actual velocity data lands.

**Aider's morning-Jira-report script** (currently queued as overnight task #2) will pull active sprint state into `MORNING_JIRA_REPORT.md` so Rob has daily visibility without opening Jira itself.

---

## 18. Gate 3 rebuild note

**Flag for Phase 2 engineering work:** rebuild Gate 3's clip-presence verification using deterministic file-level checks (FFmpeg frame extraction, ffprobe, file listing in tmp) instead of Gemini sample prompts.

This lesson came out of News smoke test #8 (2026-04-13): Gemini 2.5 Flash hallucinated 4 of 5 clip presences when prompted with "there should be 5 clips." Frame-by-frame extraction proved only 1 clip existed. Temperature 0.1 did not prevent the hallucination.

Captured in `GATED_PIPELINE_ARCHITECTURE.md` as a process rule (after Fix 27 ships in the News smoke test #9 handoff). Phase 2's Week 3-4 job pipeline migration should implement Gate 3 with:

- Deterministic file checks for presence/count/timing claims
- Gemini reserved for subjective judgment (lip sync, audio quality, tone)
- Cross-validation: if Gemini says X is present and the file check says X is absent, trust the file check

Not a Phase 2 blocker, but write it into the ported `apps/worker/src/handlers/gate-qa.ts` from day one rather than carrying forward the unreliable Gemini-only pattern.

---

## 19. What this doc does NOT cover

- **Stack architecture fundamentals** → `AUTONOMOUS_PRODUCTION_ROADMAP.md` section 12
- **Business positioning, ICP, pricing, GTM** → `BUSINESS_STRATEGY.md`
- **Chrome template unification across content types** → `SHARED_NEWSCAST_SET_MIGRATION.md`
- **Active smoke test fix lists for Phase 1** → `CLINE_HANDOFF_NEWS_SMOKE_TEST_9_FIXES.md`
- **NBA voiceover V2 technical details** → `CLINE_HANDOFF_NBA_VOICEOVER_FFMPEG_V2.md` (parked)
- **Specific Figma wireframe content** → lives in the Figma file, not this doc
- **API contract detail beyond endpoint shapes** → full request/response schemas land in `packages/types/` TypeScript definitions during Week 2
- **Legal, contracts, billing setup, Stripe integration detail** → handled as separate ops/legal work, not engineering
- **Hiring plan** → business ops, not engineering spec
- **Financial projections** → not engineering scope

---

## 20. Next action

Rob reads this doc, annotates anything that doesn't match his intent, pushes back on scope/timeline/architecture.

Then:

1. **This doc lives dormant until Phase 1 locks.** News, NBA, and at least one short-form smoke test all need to pass before Week 1 starts.
2. **When Phase 1 locks,** Rob confirms "Phase 2 go" and this doc becomes the execution reference.
3. **Incoming from Rob (flagged):** wireframe shells, initial React components, pre-Jira dev tickets — these will be added to the doc or its companions when they land.
4. **Jira imports:** once `CPD` project is configured, this doc's Weeks 1-6 structure becomes the epic/story hierarchy.
5. **No code changes triggered by this doc.** Phase 1 smoke test work continues unchanged.

Until Rob approves, this is a proposal. After approval, it's the engineering execution spec for Phase 2.
