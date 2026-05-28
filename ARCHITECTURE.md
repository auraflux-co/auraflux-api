# AuraFlux — System Architecture

> **Single source of truth for system design.** Decisions live in Confluence (linked below). This file covers the runtime topology, key data flows, and extension points. Update it when the topology changes.
>
> Confluence CTO Architecture Diagram: [Page 5931010](https://aurafluxco.atlassian.net/wiki/spaces/CP/pages/5931010)

---

## Service Topology

```
┌─────────────────────────────────────────────────────────────┐
│                        Customer Browser                      │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTPS
              ┌──────────▼───────────┐
              │   auraflux-app       │  Next.js 14 (App Router)
              │   Render Web Service │  app/ directory
              │   app.auraflux.co    │  Clerk frontend SDK
              └──────────┬───────────┘
                         │ HTTPS + Clerk JWT
              ┌──────────▼───────────┐
              │   auraflux-api       │  Express 4 (Node 20)
              │   Render Web Service │  server.js (bootstrap)
              │   api.auraflux.co    │  lib/routes/ + lib/services/
              └──┬──────┬──────┬─────┘
                 │      │      │
        ┌────────▼─┐  ┌─▼────┐ └──────────────────────────┐
        │ Postgres │  │Redis │   External Services:        │
        │ (Render) │  │(BullMQ│   • RunPod (WAN 2.2/2.7)  │
        │ 16 tables│  │queue)│   • Gemini 2.5 Flash        │
        └──────────┘  └──────┘   • ElevenLabs TTS          │
                                  • HeyGen Avatar           │
              ┌───────────────┐   • Stripe Billing          │
              │ Cloudflare R2 │   • Clerk Auth              │
              │ Video/Asset   │   • Apify (Kick scraping)   │
              │ Storage       │   • Upload-Post (social)    │
              └───────────────┘                             │
                                                            │
```

---

## API Server (`auraflux-api`)

**Entry point:** `server.js` — registers middleware, mounts route files, starts crons and workers.

### Key directories

| Path | Purpose |
|---|---|
| `lib/routes/` | Express route files — one file per domain |
| `lib/services/` | External service wrappers and cron jobs |
| `lib/portals/` | Portal workers (0–5) and extension workers |
| `lib/auth/` | Clerk JWT adapter (`requireAuth`, `requireRole`) |
| `lib/ai/` | RunPod / WAN video generation client |
| `lib/presets/` | Content preset definitions (per-customer configs) |
| `migrations/` | PostgreSQL migration SQL files (run on deploy) |

### Route files

| File | Routes | Auth |
|---|---|---|
| `jobs_c1.js` | `POST /jobs`, `GET /jobs`, `GET /jobs/:id` | requireAuth + Customer |
| `billing.js` | `GET/POST /billing/payment-method`, `POST /billing/setup-intent`, `GET /billing/invoices` | requireAuth |
| `credits.js` | `GET /credits/balance`, `GET /credits/history`, `GET /credits/packs`, `POST /credits/purchase-pack` | requireAuth |
| `admin.js` | `GET /admin/users`, `PATCH /admin/users/:id/role` | requireAuth + Superadmin |
| `admin_crm.js` | `GET /admin/crm`, `GET /admin/activity-overview` | requireAuth + Superadmin |
| `source.js` | `GET /source/content`, `GET /source/channels` | requireAuth |
| `publish.js` | `POST /publish/:jobId` | requireAuth |
| `social_connect.js` | OAuth connect flows for YouTube/TikTok/Instagram | requireAuth |
| `developer_api.js` | `POST /v1/jobs`, `GET /v1/jobs/:id` | API key (Bearer af_live_…) |

### Startup sequence (server.js)

1. Connect to PostgreSQL (`lib/db.js`)
2. Run pending migrations
3. Mount security middleware (Helmet, CORS, 1MB body limit)
4. Register Clerk middleware (`clerkInit()`)
5. Mount all route files
6. Start `scheduling_cron` (5-min interval: deferred publish, scheduled starts, upload cleanup)
7. Start BullMQ worker (if `REDIS_URL` set) or fall back to in-process `setImmediate`
8. Start HTTP server on `PORT` (default 3000)

---

## Frontend (`auraflux-app`)

**Framework:** Next.js 14 with App Router.
**Auth:** `@clerk/nextjs` — all `(app)` routes are protected via middleware.

### Route structure

```
app/src/app/
  (app)/           ← authenticated routes (Clerk-protected)
    home/          ← dashboard home
    myjobs/        ← job list + active/history
    billing/       ← subscription + billing/payment page
    credits/       ← credit balance + history
    review/        ← review queue (approve/reject staged jobs)
    schedule/      ← scheduled jobs
    settings/      ← profile, social connect, API keys, team
    templates/     ← recurring content templates
    admin/         ← superadmin only (CRM, users, health)
    support/       ← support inbox
  auth/            ← sign-in / sign-up (Clerk hosted)
  api/             ← Next.js API routes (minimal — most logic in auraflux-api)
```

### Key frontend patterns

- **API calls:** `app/src/lib/api.ts` — all `apiFetch()` calls go to `auraflux-api`
- **Auth tokens:** Clerk `getToken()` in every API call — never stored in localStorage
- **Design system:** `app/src/components/ui/` — shadcn/ui + `af-*` semantic tokens in `globals.css`
- **State:** React hooks + context (`PlanContext`, `SidebarContext`) — no global state library

---

## Portal Pipeline

The AuraFlux production pipeline is **spec-driven** — the job spec declares which portals run. Portals not in the spec are skipped.

```
Job Spec Created
      │
      ▼
  Portal 0 ──── Source validation (ffprobe, Gemini clip check)
      │
      ▼
  Portal 1 ──── Script generation + QA (Gemini 2.5 Flash)
      │
  [HeyGen Ext] ── Optional: AI avatar render (if addOns.heygen.active)
      │
  [TTS Ext] ───── Optional: ElevenLabs voice narration (if addOns.tts.active)
      │
      ▼
  Portal 1b ─── Video reviewer (Gemini)
      │
      ▼
  Portal 2 ──── Render quality check
      │
      ▼
  Portal 3a ─── Assembly QA
      │
      ▼
  Portal 3b ─── FFmpeg assembly (final video)
      │
  [Shoppable] ── Optional: TikTok shoppable tag injection
  [Thumbnail] ── Optional: Thumbnail generation (Gemini / VectCut / Imagen 3)
      │
      ▼
  Portal 4 ──── Broadcast readiness check
      │
      ▼
  Portal 5 ──── Publish (Upload-Post API → YouTube/TikTok/Instagram)
```

**Files:** `lib/portals/portal0.js` through `portal5.js`, `portal_*_ext.js`

**Contract every portal exports:**
```js
{ canProduce(jobSpec), run(jobSpec, context) }
// run() always returns: { passed: bool, outcome: string, ...metadata }
// Never throws — catches and returns passed: false
```

---

## Auth & Roles

```
Clerk (hosted) ──→ JWT ──→ requireAuth (lib/auth/clerk.js)
                                │
                    ┌───────────┴───────────┐
                    │                       │
              requireRole               API Key
           (platform-level)         (Bearer af_live_…)
                    │                       │
          ┌─────────┴──────┐       lib/auth/api_key.js
          │                │
      superadmin        customer
    (platform-wide)   (per-account)
          │
    Account-level roles (per account_members row):
      owner / admin / member / billing
```

**Key files:**
- `lib/auth/clerk.js` — `requireAuth`, `requireRole`, `ROLES`
- `lib/auth/api_key.js` — Developer API key resolution
- `lib/auth/account_access.js` — Account-level membership checks

---

## Data Layer

**Database:** PostgreSQL (Render managed, 16 tables).

Key tables:
| Table | Purpose |
|---|---|
| `jobs` | Job spec + status for every pipeline run |
| `credit_ledger` | Append-only credit deductions/grants |
| `accounts` | Multi-tenant customer accounts |
| `account_members` | Per-account role assignments |
| `job_templates` | Recurring content templates |
| `oauth_tokens` | Social platform tokens (encrypted) |
| `api_keys` | Developer API keys (hashed) |
| `notifications` | In-app notification inbox |

**Migrations:** `migrations/001_*.sql` through `016_*.sql` — run automatically on startup via `lib/db.js`.

**File storage:** Cloudflare R2 — videos, thumbnails, branding assets. SDK: `@aws-sdk/client-s3`.

**Queue:** Redis (Render) + BullMQ — pipeline job queue. Falls back to `setImmediate` if `REDIS_URL` unset.

---

## Credit System

Credits are the billing unit — one credit = one pipeline run (weight varies by feature add-ons).

```
Customer submits job
  → createJobSpec() bakes planTier + featureFlags into spec
  → consumeCredits() debits credit_ledger at job start
  → Portal 5 completes → credits are final (no refund on failure at/after assembly)
  → Monthly cron (billing_cron.js) resets balances on renewal date
```

**Feature gating:** `lib/services/feature_gate.js` — `isFeatureEnabled(key, planTier)`.
Plan tiers: `operate` < `guided` < `managed` < `custom`.

---

## External Services

| Service | SDK/client | Purpose | Credential |
|---|---|---|---|
| Clerk | `@clerk/express` | Auth + user management | `CLERK_SECRET_KEY` |
| Stripe | `stripe` npm | Billing, subscriptions, credit packs | `STRIPE_SECRET_KEY` |
| Google Gemini | `@google/genai` | Script gen, QA, clip analysis | `GEMINI_API_KEY` |
| RunPod | REST API | WAN 2.2/2.7 video generation | `RUNPOD_API_KEY` |
| ElevenLabs | REST API | TTS narration | `ELEVENLABS_API_KEY` |
| HeyGen | REST API | AI avatar video | `HEYGEN_API_KEY` |
| Cloudflare R2 | `@aws-sdk/client-s3` | Asset storage | `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` |
| Upload-Post | REST API | Social media publishing | `UPLOADPOST_API_KEY` |
| Apify | REST API | Kick.com content scraping | `APIFY_API_TOKEN` |

---

## Security

- **Rate limiting:** `lib/rateLimiter.js` — per-IP, sliding window (strict/api/publish tiers)
- **CORS:** Allowlist from `ALLOWED_ORIGINS` env var (`app.auraflux.co` in production)
- **Body limit:** 1MB JSON (CPD-320). Upload routes use multer (multipart, unaffected).
- **Helmet:** X-Frame-Options, X-Content-Type-Options, HSTS, Referrer-Policy active. CSP off (JSON API).
- **Secrets:** Never in code — all via env vars. See `.env.example` for full list.
- **Upload validation:** `ffprobe` validates every uploaded file post-receive (CPD-326).

---

## C0 vs C1+ Boundary

- **C0** = ClipzWorld News localhost reference client (Rob's machine only). Files: `lib/routes/c0_*.js`, `lib/routes/jobs.js` (legacy). No auth required — internal only.
- **C1+** = AuraFlux SaaS multi-tenant. Files: `lib/routes/jobs_c1.js`, `lib/auth/`, `lib/presets/`. All routes require `requireAuth`.
- **Never** let C0-only logic (hardcoded branding, CWN strings, `streamers.json`) into shared `lib/` paths.

---

## Environment Variables

See `.env.example` for the canonical list with comments. Critical ones:

| Var | Service | Required |
|---|---|---|
| `DATABASE_URL` | PostgreSQL | Yes |
| `REDIS_URL` | BullMQ | Prod only |
| `CLERK_SECRET_KEY` | Auth | Yes |
| `STRIPE_SECRET_KEY` | Billing | Yes |
| `GEMINI_API_KEY` | AI | Yes |
| `RUNPOD_API_KEY` | Video gen | Yes |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Storage | Yes |
| `ALLOWED_ORIGINS` | CORS | Prod only |
| `NODE_OPTIONS` | Memory | Render: `--max-old-space-size=1536` |
| `PIPELINE_WORKER_CONCURRENCY` | BullMQ | Default: 2 |

---

*Last updated: 2026-05-25 (CPD-323)*
