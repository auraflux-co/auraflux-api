# AuraFlux App Scaffold Spec — app.auraflux.co

**Author:** Claude Code, 2026-04-15
**Status:** Pre-build reference — implement in Railway Epic E3+E4
**Stack locked:** Next.js App Router + Tailwind + shadcn/ui + Clerk + Drizzle + Railway
**URL:** `app.auraflux.co` (subdomain → Railway web service)
**Brand:** `docs/strategy/AURAFLUX_BRAND.md` — colors, typography, tone

---

## 1. Directory structure

```
apps/web/
├── app/
│   ├── layout.tsx                    # Root layout — ClerkProvider, fonts, globals
│   ├── page.tsx                      # Root → redirect to /dashboard or /sign-in
│   ├── sign-in/[[...sign-in]]/
│   │   └── page.tsx                  # Clerk SignIn component
│   ├── sign-up/[[...sign-up]]/
│   │   └── page.tsx                  # Clerk SignUp (invite-only for alpha)
│   └── dashboard/
│       ├── layout.tsx                # Protected shell — sidebar + topbar
│       ├── page.tsx                  # Job queue (default landing)
│       ├── jobs/
│       │   └── [id]/
│       │       └── page.tsx          # Job detail
│       ├── schedule/
│       │   └── page.tsx              # Schedule manager
│       └── settings/
│           └── page.tsx              # Brand config, integrations
├── components/
│   ├── ui/                           # shadcn/ui primitives (auto-generated)
│   ├── job-card.tsx                  # Single job card with status badge
│   ├── job-queue.tsx                 # List of job cards with polling
│   ├── sidebar-nav.tsx               # Left nav: Jobs / Schedule / Settings
│   ├── status-badge.tsx              # Color-coded status pill
│   ├── gate-score.tsx                # Gate 1/2/3 score display
│   └── content-type-icon.tsx         # News/NBA/Twitch icon
├── lib/
│   ├── api.ts                        # fetch wrappers for /api/* endpoints
│   └── utils.ts                      # cn(), formatDate(), etc.
├── middleware.ts                      # Clerk auth — protect /dashboard/*
└── public/
    └── logo.svg                       # AuraFlux wordmark
```

---

## 2. Component tree — Dashboard layout

```
DashboardLayout
├── SidebarNav
│   ├── Logo (AuraFlux wordmark)
│   ├── NavItem: Jobs (/dashboard)
│   ├── NavItem: Schedule (/dashboard/schedule)
│   ├── NavItem: Settings (/dashboard/settings)
│   └── UserButton (Clerk — avatar + sign out)
└── Main content area
    └── {children}
```

---

## 3. Job card states + UI

Every job maps to one `JobCard` component. State drives the badge and available actions:

| Status | Badge color | Actions shown |
|--------|-------------|---------------|
| `queued` | Gray | — |
| `scripting` | Blue | — |
| `rendering` | Blue | — |
| `assembling` | Blue | — |
| `manual_review` | Yellow | Approve / Reject |
| `published` | Green | View links |
| `failed` | Red | Retry (operator only) |
| `dismissed` | — | Hidden from queue |

**JobCard props:**
```typescript
interface JobCardProps {
  id: string
  contentType: 'news' | 'nba' | 'twitch'
  formType: 'compilation' | 'short'
  status: string
  stage: string | null
  createdAt: Date
  gate1Score: number | null
  gate2Score: number | null
  gate3Score: number | null
  publishedUrl?: string
}
```

---

## 4. Clerk auth setup

**Roles:** `operator` (Rob) | `customer` | `admin`

Role stored in Clerk's `publicMetadata.role`. Set via Clerk dashboard for alpha users.

**Route protection in `middleware.ts`:**
```typescript
import { authMiddleware } from '@clerk/nextjs'

export default authMiddleware({
  publicRoutes: ['/', '/sign-in(.*)', '/sign-up(.*)', '/api/health'],
})

export const config = {
  matcher: ['/((?!_next|favicon.ico).*)'],
}
```

**API auth in `apps/api/`:**
```typescript
// middleware: extract Clerk session, attach userId + clientId to req
import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node'

app.use('/api', ClerkExpressRequireAuth())
app.use('/api', async (req, res, next) => {
  const user = await db.select().from(users).where(eq(users.id, req.auth.userId)).limit(1)
  if (!user[0]) return res.status(403).json({ error: 'User not provisioned' })
  req.clientId = user[0].clientId
  req.role = user[0].role
  next()
})
```

---

## 5. API contract — endpoints the Next.js app calls

All prefixed `/api/` — all require Clerk session token in `Authorization: Bearer` header.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/jobs` | List jobs for req.clientId — `?status=&limit=&offset=` |
| GET | `/api/jobs/:id` | Single job detail with gate results |
| POST | `/api/jobs` | Create job (operator only) — `{contentType, formType}` |
| POST | `/api/jobs/:id/dismiss` | Dismiss job card |
| POST | `/api/jobs/:id/rollback` | Roll back one stage (operator only) |
| POST | `/api/jobs/:id/advance` | Force-advance stage (operator only) |
| GET | `/api/schedules` | List schedules for req.clientId |
| POST | `/api/schedules` | Create schedule |
| PATCH | `/api/schedules/:id` | Update schedule (active toggle, time change) |
| DELETE | `/api/schedules/:id` | Delete schedule |
| GET | `/api/brand-config` | Brand config for req.clientId |
| PATCH | `/api/brand-config` | Update brand config |
| GET | `/api/health` | Health check (unauthenticated) |

---

## 6. Design tokens — AuraFlux UI

From `docs/strategy/AURAFLUX_BRAND.md`:

```css
/* globals.css */
:root {
  --background: 222 47% 6%;          /* near-black background */
  --foreground: 213 31% 91%;         /* off-white text */
  --card: 222 47% 9%;                /* card background */
  --border: 215 28% 17%;             /* subtle borders */
  --primary: 265 89% 66%;            /* AuraFlux purple */
  --primary-foreground: 0 0% 100%;
  --muted: 215 28% 17%;
  --muted-foreground: 215 20% 65%;
  --accent: 265 89% 66%;
  --destructive: 0 63% 55%;
  --ring: 265 89% 66%;
}
```

**Typography:** Inter (body) + JetBrains Mono (code/scores/IDs)
**Radius:** `--radius: 0.5rem` (subtle rounding, not pill-shaped)
**Animation:** minimal — status badge transitions only, no heavy framer-motion in Phase 2

---

## 7. Pages — what each one shows

### `/dashboard` (Job Queue)
- `<JobQueue />` — polls `GET /api/jobs` every 10s
- Filter tabs: All / Active / Published / Failed
- Empty state: "No jobs yet" with content type selector if operator

### `/dashboard/jobs/[id]` (Job Detail)
- Job metadata header (content type, form type, created, duration)
- Gate score row: Gate 1 `[score]/100` Gate 2 `[score]/100` Gate 3 `[score]/100`
- Script preview (first 500 chars, expandable)
- Stage timeline (visual sequence of stages with timestamps)
- Publish links (YouTube / TikTok / Instagram — from publish_records)
- Operator section (role-gated): raw gate report JSON, rollback/advance buttons

### `/dashboard/schedule`
- Schedule list: content type, days, time, timezone, platforms, active toggle
- "Add Schedule" button → inline form (no modal for Phase 2)

### `/dashboard/settings`
- Brand Config section: primary hex, accent hex, show name per content type
- Integrations section: platform connection status (YouTube/TikTok/Instagram)
- Phase 2: read-only display. Editing in Phase 3.

---

## 8. What Rob designs himself (Equinox template)

Rob is designing `auraflux.co` (marketing site) directly in the Equinox template — no wireframes needed from Claude Code. That site is on Cloudflare Pages, completely separate from the Next.js app.

Claude Code's scope for AuraFlux UI = `app.auraflux.co` only (the operator/customer dashboard). No marketing site pages, no landing pages, no pricing pages — those are Rob's Equinox template work.

---

## 9. Phase 2 alpha scope — what is NOT built yet

- No customer self-signup (invite-only, Rob manually provisions users in Clerk)
- No Stripe billing (comped for alpha)
- No multi-tenant brand config editing (Rob sets brand via Drizzle seed)
- No notification emails (Slack DM to Rob is sufficient for alpha)
- No mobile app (responsive web is fine for Phase 2)
- No analytics dashboard (job metrics in Postgres, queryable directly)

---

*This spec becomes Jira stories E3 + E4 in `RAILWAY_MIGRATION_JIRA_EPICS.md`.*
