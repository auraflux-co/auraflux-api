# Railway Migration — Jira Epic Breakdown

**Author:** Claude Code, 2026-04-15
**Status:** Ready to import into Jira (CPD project) when Aider's pipe-open ships
**Depends on:** Phase 1 gates passed (News locked + NBA locked + 1 short-form locked)
**Stack reference:** `docs/strategy/PHASE_2_BUILD_SPEC.md` — authoritative. This doc is the Jira-ready task breakdown only.

---

## Overview — 5 Epics

| Epic | Name | Weeks | Owner |
|------|------|-------|-------|
| E1 | Monorepo scaffold + Railway project setup | Week 1 | Claude Code + Cline-A |
| E2 | Postgres schema + Drizzle ORM | Week 2 | Cline-A |
| E3 | Next.js app shell + Clerk auth | Week 2–3 | Cline-C |
| E4 | Customer dashboard UI | Week 3–5 | Cline-C |
| E5 | Pipeline migration (localhost → Railway) | Week 4–6 | Cline-A + Cline-B |

Phase 2 is sequential — E1 unlocks E2+E3, E2 unlocks E5, E3 unlocks E4.

---

## Epic 1 — Monorepo scaffold + Railway project setup

**Goal:** Working monorepo structure, Railway project created, CI/CD wired, env vars migrated. End state: `railway up` deploys the API service and returns a health check.

### Stories

**E1-S1: Create monorepo structure**
- Subtask: Init Turborepo at repo root (`npx create-turbo@latest` or manual)
- Subtask: Create `apps/api/` — copy existing `server.js` + `lib/` as starting point
- Subtask: Create `apps/web/` — Next.js App Router scaffold (`npx create-next-app@latest --app`)
- Subtask: Create `apps/worker/` — minimal Node process, health endpoint, cron stub
- Subtask: Create `packages/shared/` — shared types, Zod schemas, constants
- Subtask: Update `.gitignore` for monorepo (`node_modules/` at root + each app)
- Subtask: Verify `node -c apps/api/server.js` passes (no regressions from move)

**E1-S2: Railway project + services**
- Subtask: Create Railway project `cwn-production` (Rob does this in Railway UI)
- Subtask: Add 3 services: `api`, `worker`, `web`
- Subtask: Add Postgres plugin to project
- Subtask: Set `DATABASE_URL` on api + worker services (Railway auto-injects for plugin)
- Subtask: Create `railway.toml` at repo root defining all 3 services + build commands
- Subtask: Wire `apps/api/` deploy: `npm start` → `node server.js`
- Subtask: Wire `apps/web/` deploy: `npm run build && npm start`
- Subtask: Wire `apps/worker/` deploy: `node worker.js`

**E1-S3: Env var migration**
- Subtask: Audit all `.env` vars currently in use (grep across `lib/`, `server.js`)
- Subtask: Add all required vars to Railway service env (manual, not checked into git)
- Subtask: Update `server.js` env validation block to use `process.env` (already does — verify nothing hardcoded)
- Subtask: Test `GET /health` on deployed Railway URL returns 200

**E1-S4: Cloudflare DNS setup**
- Subtask: Rob flips DNS from GoDaddy to Cloudflare nameservers for `auraflux.co`
- Subtask: Add CNAME `app.auraflux.co` → Railway web service URL
- Subtask: Add CNAME `api.auraflux.co` → Railway api service URL (internal only, not public)
- Subtask: Verify SSL auto-issued by Cloudflare for both subdomains

---

## Epic 2 — Postgres schema + Drizzle ORM

**Goal:** All pipeline state persisted to Postgres, `data/jobs.json` retired. Drizzle migrations checked into git.

### Stories

**E2-S1: Drizzle setup + initial schema**
- Subtask: `npm install drizzle-orm drizzle-kit pg` in `apps/api/`
- Subtask: Create `apps/api/src/db/schema.ts` with all 8 tables from `PHASE_2_BUILD_SPEC.md §6.3`: `users`, `clients`, `brand_configs`, `client_integrations`, `jobs`, `schedules`, `publish_records`, `gate_results`
- Subtask: Create `drizzle.config.ts` pointing at Railway `DATABASE_URL`
- Subtask: Run `drizzle-kit push` to create tables on Railway Postgres
- Subtask: Add `drizzle-kit generate` + `drizzle-kit migrate` to `package.json` scripts

**E2-S2: Job persistence migration**
- Subtask: Replace `data/jobs.json` read/write with Drizzle `jobs` table CRUD in `apps/api/`
- Subtask: `saveJobCard()` → `db.insert(jobs).values(...).onConflictDoUpdate(...)`
- Subtask: `GET /jobs` → `db.select().from(jobs).where(...)` with same filter logic
- Subtask: `POST /job/:id/dismiss` → `db.update(jobs).set({status:'dismissed'})...`
- Subtask: Seed a `clients` row for Rob: `id='client_000_rob'`, plan=`unlimited_internal`
- Subtask: All new jobs get `client_id='client_000_rob'` (hardcoded for Phase 2 alpha)

**E2-S3: Gate results migration**
- Subtask: Gate 1/2/3 outcomes currently written to `output/qa_failures/*.txt` — write to `gate_results` table instead (keep file write as backup)
- Subtask: Expose `GET /jobs/:id/gates` endpoint returning gate history for a job

**E2-S4: Verify localhost still works**
- Subtask: Both `data/jobs.json` (local) and Railway Postgres work — use `DATABASE_URL` env var to switch. If `DATABASE_URL` is set → Postgres. If not → fall back to JSON file.
- Subtask: This ensures localhost dev doesn't require Railway Postgres running

---

## Epic 3 — Next.js app shell + Clerk auth

**Goal:** `app.auraflux.co` loads, Clerk sign-in works, authenticated users see a protected dashboard shell.

### Stories

**E3-S1: Next.js App Router scaffold**
- Subtask: `apps/web/` already created in E1-S1 — set up Tailwind + shadcn/ui
- Subtask: `npx shadcn-ui@latest init` — choose slate theme, CSS variables
- Subtask: Install core shadcn components: Button, Card, Badge, Input, Textarea, Separator, Skeleton, Toast
- Subtask: Create root layout `app/layout.tsx` with `ClerkProvider` wrapper
- Subtask: Create `app/page.tsx` → redirect to `/dashboard` if signed in, else `/sign-in`

**E3-S2: Clerk auth wiring**
- Subtask: Rob creates Clerk app at clerk.com for `auraflux.co`
- Subtask: Add `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` to Railway web + api service env
- Subtask: `app/sign-in/[[...sign-in]]/page.tsx` — Clerk `<SignIn />` component
- Subtask: `app/sign-up/[[...sign-up]]/page.tsx` — Clerk `<SignUp />` component (invite-only for alpha: disable in Clerk dashboard)
- Subtask: `middleware.ts` — protect all `/dashboard/*` routes, allow `/sign-in`, `/sign-up`, `/api/health`
- Subtask: `app/dashboard/layout.tsx` — sidebar nav shell (Jobs, Schedule, Settings)

**E3-S3: API auth middleware**
- Subtask: In `apps/api/`, install `@clerk/clerk-sdk-node`
- Subtask: Add `requireAuth` middleware that validates Clerk session token on all `/api/*` routes except `/health`
- Subtask: Attach `req.userId` (Clerk user ID) and `req.clientId` to every authenticated request
- Subtask: Seed Rob's user: on first login, auto-create `users` row with `role='operator'` + `client_id='client_000_rob'`

---

## Epic 4 — Customer dashboard UI

**Goal:** Customers can view their job queue, see job status live, trigger manual runs, and view published videos. Rob can see all clients.

**Depends on:** E2 (jobs in Postgres), E3 (auth working)

### Stories

**E4-S1: Job queue page**
- Subtask: `app/dashboard/page.tsx` — `JobQueuePage` component
- Subtask: `GET /api/jobs` — returns jobs for `req.clientId`, paginated, status filter
- Subtask: `JobCard` component: shows status badge, content type, form type, created time, action buttons
- Subtask: Status badges: Queued / Scripting / Rendering / Assembling / Published / Failed (color-coded)
- Subtask: Real-time updates: poll `GET /api/jobs` every 10s (no websockets in Phase 2)
- Subtask: Empty state: "No jobs yet — your first video will appear here"

**E4-S2: Job detail page**
- Subtask: `app/dashboard/jobs/[id]/page.tsx`
- Subtask: Shows script preview (first 500 chars), Gate 1/2/3 scores, stage timeline
- Subtask: "View on YouTube / TikTok / Instagram" links from `publish_records`
- Subtask: Rob-only: raw gate report JSON collapsible

**E4-S3: Manual run trigger (operator only)**
- Subtask: Operator sidebar section: "New Run" button → modal with content type + form type selector
- Subtask: `POST /api/jobs` → creates job row, triggers pipeline (same as current dashboard flow)
- Subtask: Customers see read-only queue — no trigger button (role check)

**E4-S4: Schedule page**
- Subtask: `app/dashboard/schedule/page.tsx`
- Subtask: Shows current schedules from `schedules` table
- Subtask: Toggle active/inactive per schedule
- Subtask: "Add schedule" form: content type, form type, days of week, time, timezone, platforms

---

## Epic 5 — Pipeline migration (localhost → Railway)

**Goal:** Full pipeline runs on Railway. `localhost:3000` becomes `api.auraflux.co`. Rob's production runs go through Railway, not his laptop.

**Depends on:** E1 (Railway services deployed), E2 (Postgres), E3 (auth)

### Stories

**E5-S1: Assembly service isolation**
- Subtask: Move FFmpeg-heavy assembly work from API service to Worker service
- Subtask: Job queue pattern: API creates job row → Worker polls for `status='queued'` jobs → Worker runs assembly → updates job row
- Subtask: Polling interval: 15s (simple, no Redis needed for Phase 2)
- Subtask: Worker health check includes `activeJobs` count

**E5-S2: File storage migration (R2)**
- Subtask: Replace `output/*.mp4` local file writes with Cloudflare R2 uploads
- Subtask: `uploadToR2(localPath, key)` helper in `packages/shared/`
- Subtask: Final assembled MP4 → R2 `output/{clientId}/{jobId}/final.mp4`
- Subtask: Pre-signed URL for playback (7-day TTL)
- Subtask: Keep Google Drive upload as secondary (clients may prefer Drive link)
- Subtask: `tmp/` files stay local to worker (ephemeral, cleaned after job)

**E5-S3: HeyGen segment caching on R2**
- Subtask: Downloaded HeyGen segments → R2 `tmp/{jobId}/segments/` instead of local `tmp/`
- Subtask: Enables worker restart recovery (segments still accessible after crash)
- Subtask: Auto-delete R2 tmp prefix after job completes or 48h TTL

**E5-S4: Smoke test Railway end-to-end**
- Subtask: Run News long-form smoke test against Railway API (not localhost)
- Subtask: Verify Gate 1 → HeyGen → Assembly → Gate 3 → R2 upload → Drive upload → publish
- Subtask: Check `jobs` table in Railway Postgres for complete state history
- Subtask: Rob visual review: assembled MP4 quality identical to localhost output

---

## What Aider should do with this doc

When Jira pipe opens:
1. Create project `CPD` (CWN Production Development) in Jira if not exists
2. Import each Epic as a Jira Epic with the label `railway_migration`
3. Import each Story as a Story under its Epic
4. Import each Subtask as a Subtask under its Story
5. Assign epics: E1 → Claude Code, E2+E5 → Cline-A, E3+E4 → Cline-C, E1-S2 Rob-action items → flagged with `rob_action` label
6. Set all stories to `To Do` status

---

*Reference: `docs/strategy/PHASE_2_BUILD_SPEC.md` is authoritative for stack decisions. This doc is execution breakdown only.*
