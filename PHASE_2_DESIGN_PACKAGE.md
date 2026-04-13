# PHASE_2_DESIGN_PACKAGE.md

**Author:** Claude Code, drafted 2026-04-13 evening from Rob's wireframe + component map + dev tickets + PRD drop
**Status:** Design and spec package companion to `PHASE_2_BUILD_SPEC.md`
**Companion docs:**
- `PHASE_2_BUILD_SPEC.md` — 6-week execution plan, monorepo structure, API contract, Figma page map
- `AUTONOMOUS_PRODUCTION_ROADMAP.md` section 12 — stack architecture (already locked)
- `BUSINESS_STRATEGY.md` — positioning, ICP, pricing

**Not a handoff.** Reference material for when Phase 2 actually starts. This doc contains the concrete text-wireframe content, component map, dev ticket list, and PRD that Rob drafted 2026-04-13. It becomes the source of truth for Figma wireframes, React component naming, and Jira story imports.

---

## 1. Purpose

`PHASE_2_BUILD_SPEC.md` captures the **execution plan** — what gets built in which week, which services run where, which libraries to pick. This doc captures the **content**:

- What every screen actually says (onboarding copy, dashboard headlines, error messages)
- Text wireframes structured so a designer or frontend dev can build directly from them
- React component map with props
- Dev tickets written in build order (ready for Jira import)
- PRD (problem, vision, scope, target users, success metrics)

The two docs are intentionally split. Build spec = architecture and timeline. Design package = concrete product surface content. Neither duplicates the other.

---

## 2. Cross-reference — what's already in PHASE_2_BUILD_SPEC.md

Do NOT re-read these from PHASE_2_BUILD_SPEC.md:

- **§2** Hard prerequisites (News + NBA locked + one short-form locked before Phase 2 starts)
- **§4** Monorepo + folder structure
- **§5** Library choices (React Query, Zod, Drizzle/Prisma, pnpm+Turborepo, Vitest, Playwright)
- **§6** Railway service breakdown + full Postgres schema
- **§7** API contract REST endpoints
- **§8–13** Week 1–6 execution plan
- **§14** Figma page map (5 top-level pages, screen list)
- **§15** Dual palette note (broadcast vs product colors)
- **§16** Developer profile guidance
- **§17** Jira sprint mapping

This doc adds:
- §3 — Product Requirements Document (PRD)
- §4 — Text wireframes for every key screen
- §5 — React component map with props
- §6 — Dev tickets in build order (Epics 1–8)
- §7 — Onboarding + dashboard copy
- §8 — Build now vs later scope list
- §9 — Handoff format for frontend dev

---

## 3. Product Requirements Document (PRD)

### 3.1 Product name (working)

**Content Engine OS (Twitch-first SaaS)**

### 3.2 Problem statement

Creators — especially Twitch streamers — produce hours of high-value content daily, but:

- Only a small portion is turned into clips
- Distribution across platforms is inconsistent
- Editing, formatting, and posting require time or a team
- Most creators lose 80–90% of their content value

Existing tools:

- Require manual uploads
- Focus on editing, not distribution
- Do not automate the full workflow

**Core problem:** creators have content, but no system to turn it into consistent, multi-platform output automatically.

### 3.3 Product vision

A fully automated content engine that turns raw Twitch content into daily, multi-platform video output without user effort.

**Vision statement:** "Creators should be able to set their content once and have a system that continuously produces and publishes content for them."

### 3.4 Solution overview

The platform:

1. Pulls clips from Twitch automatically
2. Processes and formats them into short-form content
3. Optionally enhances content (AI narrative, overlays, etc.)
4. Runs QA validation
5. Publishes to YouTube Shorts, TikTok, Instagram Reels
6. Repeats daily based on schedule

**Internal system (NOT exposed to users):**
- Clip ingestion (Twitch API)
- AI scripting (Gemini)
- QA validation (Claude)
- Scene orchestration
- Video rendering (FFmpeg)
- Optional enhancement layer (overlays, narration)
- Publishing (Upload-Post)
- Multi-stage pipeline with retries

**Customer experience:** the user only sees "Your content is being created and posted automatically."

### 3.5 Target users (ICP)

**Primary users:**
- Twitch creators (10K–250K followers)
- Stream consistently
- Lack time or systems for distribution

**Secondary users (later phases):**
- YouTubers with long-form content
- Podcasters
- Coaches / content creators

Matches `BUSINESS_STRATEGY.md` §3 ICP definition.

### 3.6 MVP scope (Alpha)

**Included — core features:**
- Account creation + login
- Twitch username input
- Platform selection
- Schedule configuration
- Job creation and tracking
- Video publishing (short-form)
- Video history dashboard

**Output modes:**
- **Default: Auto Clips** — clip extraction, formatting, captions, posting
- **Optional (Beta): Enhanced Videos** — AI scripting, scene stitching, optional overlays/narration

**NOT included in MVP:**
- Billing system
- Full analytics
- Deep customization
- Multi-content types (News, NBA, etc.)
- Mobile app
- Public marketplace features

### 3.7 User flow

**Primary flow:**
1. User signs up
2. Enters Twitch username
3. Selects platforms
4. Sets schedule
5. Starts engine
6. System generates content daily
7. User views results in dashboard

**Secondary flow:**
- User checks dashboard
- Views videos
- Edits schedule
- Reviews performance

### 3.8 Key screens

**Customer App:**
- Login / Signup
- Onboarding (5-step flow)
- Dashboard
- Videos list
- Video detail
- Schedule
- Integrations
- Settings
- Billing (Phase 4+, placeholder in Phase 2)

**Operator App (internal):**
- Jobs table
- Job detail
- Alerts
- Clients
- Metrics

### 3.9 Technical architecture

Already locked in `AUTONOMOUS_PRODUCTION_ROADMAP.md` section 12:
- Frontend: Next.js on Vercel
- Backend: Node/Express on Railway
- Database: Postgres (Railway add-on)
- Storage: Cloudflare R2

### 3.10 API surface (high-level)

See `PHASE_2_BUILD_SPEC.md` section 7 for full REST endpoint shapes. Summary:

- **Auth:** `POST /auth/login`, `POST /auth/signup`
- **Onboarding:** `POST /onboarding`
- **Jobs:** `GET /jobs`, `POST /jobs`, `GET /jobs/:id`
- **Videos:** `GET /videos`, `GET /videos/:id`
- **Schedule:** `GET /schedule`, `POST /schedule`
- **Integrations:** `POST /integrations/twitch`, `POST /integrations/platform`

### 3.11 Success metrics

**Product metrics:**
- % of users completing onboarding
- Time to first generated video
- Jobs per user per week
- Publish success rate

**Engagement metrics:**
- Daily active users
- Videos generated per user
- Retention (7-day, 30-day)

**System metrics:**
- Job success rate
- Average processing time
- Failure rate per stage

### 3.12 Alpha success criteria

**You win if:**
- 1–3 Twitch creators use the system
- Content is generated and published automatically
- Minimal manual intervention required
- Users understand the product without explanation

### 3.13 Risks & constraints

**Technical risks:**
- Twitch API reliability
- Video processing performance
- Pipeline failure edge cases

**Product risks:**
- Overcomplex UI
- Too many options early
- Misaligned expectations

**Strategic risks:**
- Competing as a "tool" instead of a "system"
- Overbuilding before usage

### 3.14 Non-goals (critical — do NOT build)

- Full SaaS complexity
- Advanced customization
- Multiple niches (news, sports) in customer-facing UI
- Heavy analytics dashboards
- Complex UI controls

### 3.15 Product principles

1. **Simplicity over power** — user should not think, just configure and go
2. **Outcome over features** — focus on "content is posted daily"
3. **Automation first** — every feature should reduce user effort
4. **Hide complexity** — pipeline is invisible to customers
5. **Speed to value** — user should see activity within minutes

### 3.16 High-level roadmap

**Phase 1 (now):** Twitch-only MVP, short-form content, basic scheduling, dashboard
**Phase 2:** Multi-client system, improved automation, stability
**Phase 3:** Enhanced videos (AI narrative), overlays, advanced visuals
**Phase 4:** SaaS onboarding at scale, billing, self-serve growth

Maps to the 5 phases in `AUTONOMOUS_PRODUCTION_ROADMAP.md` section 2.

### 3.17 Final summary

You are building a **content engine that replaces manual workflows and runs continuously in the background.**

NOT a video tool. NOT a clip editor. NOT a scheduler.

---

## 4. Text wireframes

Structured so a designer or frontend dev can build directly from them. No ASCII art — these describe layout, content, and interaction.

### 4.1 Login

**Layout:** centered card on light background, ~480px wide, vertical stack.

**Content top-to-bottom:**
- CWN logo (top)
- Headline: **"Run your content engine automatically"**
- Subtext: "Turn your Twitch content into daily videos across YouTube, TikTok, and Instagram."
- Email address input
- Password input
- **Sign In** button (primary, full width)
- "Forgot password?" link (below button, subtle)
- "No account yet? Create one" link (bottom, subtle)

**Notes:**
- Clean and minimal
- No feature overload
- Strong outcome-based headline
- No marketing clutter

### 4.2 Signup

**Layout:** same centered card pattern as login.

**Content:**
- CWN logo
- Headline: **"Create your account"**
- Subtext: "Get your content engine running in minutes."
- Full name input
- Email address input
- Password input
- Confirm password input
- **Create Account** button (primary, full width)
- "Already have an account? Sign in" link

### 4.3 Onboarding — Step 1: Twitch username

**Layout:** centered card with stepper at top showing "Step 1 of 5" progress.

**Content:**
- Stepper: 5 dots, first filled, rest empty — "Step 1 of 5"
- Headline: **"Connect your Twitch source"**
- Subtext: "We'll use your channel to pull clips and create daily content automatically."
- Twitch username input (single text field, placeholder: "your_username")
- Helper text below input: "Enter the creator account you want us to monitor."
- **Continue** button (primary, full width)

### 4.4 Onboarding — Step 2: Platform selection

**Content:**
- Stepper: "Step 2 of 5"
- Headline: **"Choose where to publish"**
- Subtext: "Select the platforms where your videos should go."
- Three checkbox rows, all checked by default:
  - ✓ YouTube Shorts
  - ✓ TikTok
  - ✓ Instagram Reels
- **Back** button (secondary, left) | **Continue** button (primary, right)

### 4.5 Onboarding — Step 3: Output mode

**Content:**
- Stepper: "Step 3 of 5"
- Headline: **"Choose your output style"**
- Subtext: "Start simple and expand later."
- Two radio cards stacked:
  - **(●) Auto Clips** — "Short-form videos made from your Twitch clips, formatted and posted automatically."
  - **(○) Enhanced Videos (Beta)** — "AI-structured videos with optional voiceover, scene orchestration, overlays, and richer edits."
- **Back** | **Continue** buttons

**Default:** Auto Clips selected.

### 4.6 Onboarding — Step 4: Schedule

**Content:**
- Stepper: "Step 4 of 5"
- Headline: **"Set your posting schedule"**
- Subtext: "Choose when you want content delivered and posted."
- Days picker: 7 toggleable day buttons — Mon Tue Wed Thu Fri Sat Sun
- Preferred publish time: dropdown (default 4:00 PM)
- Timezone: dropdown (default America/New_York or user's detected timezone)
- Frequency: radio group
  - (●) Once per day
  - (○) Twice per day
  - (○) Custom
- **Back** | **Continue** buttons

### 4.7 Onboarding — Step 5: Review

**Content:**
- Stepper: "Step 5 of 5"
- Headline: **"Review your setup"**
- Summary list (read-only):
  - Twitch source: `@creatorname`
  - Platforms: `YouTube Shorts, TikTok, Instagram Reels`
  - Output mode: `Auto Clips`
  - Schedule: `Daily at 4:00 PM ET`
- **Back** button (secondary) | **Start My Content Engine** button (primary, emphasized)

### 4.8 Customer Dashboard

**Layout:** sidebar nav left, main content area right with header + body.

**Sidebar nav items:** Dashboard, Videos, Schedule, Integrations, Settings, User

**Main content top-to-bottom:**

**Page header:**
- Headline: **"Your content engine"**
- Subtext: "Everything is running from your Twitch source and publishing automatically."

**KPI cards row (3 cards, horizontal):**
- **Card 1 — Next Scheduled Post**
  - Big text: "Tomorrow at 4:00 PM ET"
  - Status badge: "On Track" (green)
- **Card 2 — Engine Health**
  - Big text: "Healthy"
  - Subtext: "No action needed"
- **Card 3 — Platforms**
  - Big text: "3 connected"
  - Subtext: "YouTube, TikTok, Instagram"

**Section — Recent Jobs:**
- Section header: "Recent Jobs"
- Horizontal scrollable row of 3-5 Job Cards

**Job Card shape:**
- Thumbnail (top, 16:9 or 9:16 depending on form)
- Title: "Twitch Highlights - Apr 14"
- Status badge: "Processing" (blue)
- Platform chips: YT / TT / IG
- Created time: "2 hours ago"
- Progress bar if status is in-flight: "62%"

**Section — Latest Published Videos:**
- Section header: "Latest Published Videos"
- Horizontal scrollable row of 3-5 Video Cards

**CRITICAL — do NOT show anywhere in customer dashboard:**
- Gate 1 / Gate 2 / Gate 3 scores or reports
- Rollback button
- Force advance button
- Internal diagnostics
- Pipeline stage names (pulling_clips, scripting, rendering, assembling, etc.)

### 4.9 Videos Page

**Content:**
- Page header: **"Your videos"**
- Filter row:
  - "All Statuses" dropdown
  - "All Platforms" dropdown
  - "Last 30 Days" dropdown
- Search input: "Search videos..."
- Grid or list of Video Cards (toggle view optional)

**Video Card shape:**
- Thumbnail
- Title
- Publish date
- Status
- Platform icons
- **View Details** button

### 4.10 Video Detail

**Content:**
- Back link: "Back to Videos"
- Title: "Twitch Highlights - Apr 14"
- Status: "Published"
- Video preview player (or thumbnail fallback)
- **Platforms section:**
  - YouTube Shorts — [View] link
  - TikTok — [View] link
  - Instagram Reels — [View] link
- **Metadata section:**
  - Title
  - Caption / description
  - Hashtags
  - Tags
- **Timeline section:**
  - Created timestamp
  - Processing started timestamp
  - Published timestamp
- **Actions:**
  - **Download MP4** button
  - **Copy Metadata** button

### 4.11 Schedule Page

**Content:**
- Page header: **"Schedule"**
- Subtext: "Control when your content engine posts."
- Weekly Schedule section:
  - Mon — 4:00 PM
  - Tue — 4:00 PM
  - Wed — 4:00 PM
  - Thu — 4:00 PM
  - Fri — 4:00 PM
  - (Sat/Sun empty or grayed out)
- **Edit Schedule** button
- Optional toggles:
  - ☐ Pause engine
  - ☐ Skip weekends

### 4.12 Integrations

**Content:**
- Page header: **"Integrations"**
- **Twitch section:**
  - Status: "Connected"
  - Source: `@creatorname`
  - **Reconnect** button
- **Upload Destinations section:**
  - YouTube Shorts — "Connected" badge
  - TikTok — "Connected" badge
  - Instagram — "Connected" badge
- **Manage Connections** button (links to platform-specific reconnect flows)

### 4.13 Settings

**Content:**
- Page header: **"Settings"**
- **Profile section:**
  - Name input
  - Email input (read-only or editable per Clerk rules)
- **Content Preferences section:**
  - Default output mode dropdown
  - Caption style dropdown
- **Timezone section:**
  - Timezone dropdown
- **Notifications section:**
  - ☐ Email me if publishing fails
  - ☐ Email me when videos go live
- **Save Changes** button

### 4.14 Billing (Phase 4+, placeholder in Phase 2)

**Content:**
- Page header: **"Billing"**
- Current Plan: "Beta / Founder / Pro"
- Next billing date: "May 14, 2026"
- Payment method: "Visa ending in 4242"
- **Update Plan** button
- **Update Payment Method** button

### 4.15 Operator — All Jobs

**Content:**
- Page header: **"All Jobs"**
- Filter row: Client / Status / Platform / Date Range dropdowns
- Table columns:
  - Job ID
  - Client
  - Type
  - Status
  - Stage
  - Created
  - Actions
- Row actions: [View] [Retry]

### 4.16 Operator — Job Detail

**Content:**
- Page header: **"Job Detail"**
- Client: creator_001
- Type: twitch_short
- Status: "failed"
- **Internal Timeline:** queued → pulling clips → scripting → assembly → publishing (visual pipeline)
- **Gate Summary:**
  - Gate 1: pass
  - Gate 2: pass
  - Gate 3: fail
- **Actions:**
  - **Retry** button
  - **Rollback** button
  - **Force Advance** button
  - **View Logs** button

### 4.17 Operator — Alerts

**Content:**
- Page header: **"Alerts"**
- **Critical Alerts section:**
  - Publish failure
  - Retry exhaustion
  - Integration disconnected
- Each alert card:
  - Client
  - Job
  - Severity badge
  - Message
  - Quick action button

### 4.18 Operator — Clients

**Content:**
- Page header: **"Clients"**
- Client table/cards:
  - Name
  - Twitch source
  - Platforms
  - Last activity
  - Status
  - Plan
- Row actions: [View] [Edit]

### 4.19 Operator — Metrics

**Content:**
- Page header: **"Metrics"**
- KPI cards row:
  - Jobs today
  - Publish success rate
  - Failures
  - Average processing time
- Charts section:
  - Jobs per day
  - Failures by stage
  - Platform distribution

---

## 5. React component map

Components live in `packages/ui/` (shared across apps/web) or `apps/web/components/` (app-specific). Naming matches the monorepo structure in `PHASE_2_BUILD_SPEC.md` section 4.

### 5.1 Layout components

**`AppShell`** — root layout wrapper, wraps children with sidebar and top nav
- Props: `children`, `sidebar`, `topNav`

**`SidebarNav`** — left sidebar navigation
- Props: `items` (array of `{href, label, icon}`), `activeItem`

**`TopNav`** — top navigation bar
- Props: `title`, `user` (current user), `actions` (optional right-side actions)

**`PageHeader`** — per-page header (headline + subtext + actions)
- Props: `title`, `subtitle?`, `actions?`

### 5.2 Form components

**`TextInput`**
- Props: `label`, `placeholder?`, `value`, `onChange`, `error?`

**`PasswordInput`**
- Props: same as `TextInput` plus show/hide toggle

**`SelectField`** — dropdown select
- Props: `label`, `options` (array of `{value, label}`), `value`, `onChange`

**`ToggleCard`** — radio card for output mode or platform selection
- Props: `title`, `description`, `selected`, `onSelect`, `badge?` (e.g., "Beta")

**`StepWizard`** — multi-step onboarding wrapper
- Props: `currentStep`, `steps` (array of step labels), `children`, `onNext`, `onBack`

### 5.3 Dashboard components

**`StatCard`** — KPI card for dashboard top row
- Props: `title`, `value`, `subtext?`, `status?` (affects color)

**`HealthCard`** — engine health status card
- Props: `status` ('healthy' | 'warning' | 'critical'), `message`

**`JobCard`** — dashboard job tile
- Props: `title`, `status`, `platforms`, `createdAt`, `progress?`, `thumbnailUrl?`

**`VideoCard`** — published video tile
- Props: `title`, `thumbnailUrl`, `publishedAt`, `platforms`, `status`

**`StatusBadge`** — small pill with status indicator
- Variants: `queued`, `processing`, `publishing`, `published`, `failed`
- Props: `variant`, `label?`

**`PlatformChip`** — platform indicator pill
- Variants: `youtube`, `tiktok`, `instagram`, `twitch`
- Props: `variant`, `size?` ('sm' | 'md' | 'lg')

### 5.4 Detail components (video detail page)

**`VideoPreview`** — embedded video player
- Props: `videoUrl`, `thumbnailUrl?`, `autoplay?`

**`MetadataPanel`** — video metadata display
- Props: `title`, `description`, `hashtags`, `tags`

**`TimelineList`** — vertical timeline of events
- Props: `events` (array of `{timestamp, label, status?}`)

**`ActionBar`** — bottom action bar with buttons
- Props: `actions` (array of `{label, onClick, variant?}`)

### 5.5 Schedule components

**`ScheduleEditor`** — schedule creation/edit form
- Props: `days`, `time`, `timezone`, `frequency`, `onChange`

**`WeeklyScheduleCard`** — read-only weekly schedule display
- Props: `entries` (array of `{day, time}`)

### 5.6 Operator components (role-gated, only in `app/(operator)/`)

**`JobsTable`** — full operator jobs table
- Props: `jobs`, `filters`, `onRetry`, `onView`

**`AlertCard`** — operator alert tile
- Props: `severity`, `clientName`, `message`, `actions`

**`ClientTable`** — operator client list
- Props: `clients`

**`MetricCard`** — operator KPI with trend
- Props: `label`, `value`, `trend?` ('up' | 'down' | 'flat'), `trendValue?`

### 5.7 Shared utility components

**`EmptyState`** — empty state illustration + message
- Props: `icon?`, `title`, `description?`, `action?`

**`LoadingSpinner`** — loading indicator
- Props: `size?`

**`ErrorState`** — error display
- Props: `title`, `message`, `retryAction?`

**`Toast`** — notification toast
- Variants: `success`, `warning`, `error`, `info`
- Props: `variant`, `title`, `description?`, `duration?`

---

## 6. Frontend dev tickets (build order)

Ready for Jira import. Organized into 8 epics matching Weeks 1-6 of `PHASE_2_BUILD_SPEC.md` execution plan. Each ticket has acceptance criteria that can become Jira done-criteria.

### Epic 1: App foundation (Week 1)

**Ticket 1.1 — Initialize Next.js frontend app with TypeScript, Tailwind, and shadcn/ui**
- Acceptance:
  - App boots locally via `pnpm dev`
  - Tailwind configured with design tokens
  - shadcn/ui installed with at least 3 baseline components (Button, Input, Card)
  - Basic layout renders at localhost

**Ticket 1.2 — Create shared design tokens and app theme**
- Acceptance:
  - Colors, spacing, typography tokens exported from `packages/ui/src/tokens.ts`
  - Status color system defined (queued, processing, publishing, published, failed)
  - Reusable styles documented in `packages/ui/README.md`

**Ticket 1.3 — Build base layout shell for customer and operator apps**
- Acceptance:
  - Sidebar and top nav rendering
  - Protected layouts separated (`(customer)` vs `(operator)` route groups)
  - Route groups created per `PHASE_2_BUILD_SPEC.md` section 4.2

### Epic 2: Authentication (Week 2)

**Ticket 2.1 — Build login and signup screens**
- Acceptance:
  - Forms render
  - Validation works (Zod schema)
  - Error states display correctly
  - Clerk `<SignIn />` / `<SignUp />` components integrated

**Ticket 2.2 — Implement session-aware route protection**
- Acceptance:
  - Logged-out users redirected to login
  - Customer routes protected at layout level
  - Operator routes protected by role check
  - 403 page for unauthorized access

### Epic 3: Onboarding (Week 2)

**Ticket 3.1 — Build multi-step onboarding wizard shell**
- Acceptance:
  - 5-step flow renders with stepper
  - Progress stepper visible at top
  - State persists across step navigation (React Query + local state)
  - Back/Continue buttons work

**Ticket 3.2 — Add Twitch username step (Step 1)**
- Acceptance:
  - User can input Twitch username
  - Invalid states handled (empty, bad format, API validation)
  - Helper text visible

**Ticket 3.3 — Add platform selection step (Step 2)**
- Acceptance:
  - User can choose YouTube, TikTok, Instagram via checkboxes
  - Defaults persist (all checked)
  - At least one platform required to continue

**Ticket 3.4 — Add output mode selection step (Step 3)**
- Acceptance:
  - Auto Clips default selected
  - Enhanced Videos marked with "Beta" badge
  - Radio card interaction works

**Ticket 3.5 — Add schedule selection step (Step 4)**
- Acceptance:
  - Days, time, timezone, frequency captured
  - User can continue with minimum 1 day selected
  - Timezone defaults to user's detected timezone

**Ticket 3.6 — Add onboarding review and submit step (Step 5)**
- Acceptance:
  - Summary shows all prior selections
  - Back button allows edit
  - Submit triggers backend `POST /onboarding/finish`
  - Redirects to dashboard on success

### Epic 4: Customer dashboard (Week 3)

**Ticket 4.1 — Build customer dashboard header and stat cards**
- Acceptance:
  - Next scheduled post card renders
  - Engine health card renders
  - Connected platforms card renders
  - All 3 cards pull from API via React Query

**Ticket 4.2 — Build recent jobs list with job cards**
- Acceptance:
  - Job cards render from `GET /jobs?limit=5` API
  - Status badges work (5 variants)
  - Progress bar visible for in-flight jobs
  - Click-through to job detail page
  - Polling interval 10 seconds via React Query

**Ticket 4.3 — Build latest published videos section**
- Acceptance:
  - Video cards render from `GET /videos?limit=5` API
  - Click-through to video detail page
  - Empty state when no videos

### Epic 5: Videos experience (Week 5)

**Ticket 5.1 — Build videos listing page**
- Acceptance:
  - List/grid toggle (optional for alpha)
  - Filters visible (status, platform, date range)
  - Pagination ready (cursor-based)
  - Empty state when filtered results are zero

**Ticket 5.2 — Build video detail page**
- Acceptance:
  - Preview player embedded
  - Metadata panel shows title, description, hashtags, tags
  - Timeline visible with created/processing/published timestamps
  - Download MP4 action
  - Copy Metadata action

### Epic 6: Schedule and settings (Week 4-5)

**Ticket 6.1 — Build schedule page with editable recurring schedule**
- Acceptance:
  - User can see weekly schedule
  - Edit action opens modal with `ScheduleEditor` component
  - Save persists via `PATCH /schedule/:id`
  - Pause engine toggle works

**Ticket 6.2 — Build integrations page**
- Acceptance:
  - Twitch source shown with status
  - Platform connections shown with status
  - Reconnect CTAs available per platform

**Ticket 6.3 — Build settings page**
- Acceptance:
  - Profile, timezone, notifications editable
  - Save triggers `PATCH /settings` API
  - Success toast on save

### Epic 7: Operator app (Week 6)

**Ticket 7.1 — Build operator jobs table**
- Acceptance:
  - All jobs visible (across all clients)
  - Filters by client and status
  - Actions visible (View, Retry)
  - Role-gated — 403 if not operator/admin

**Ticket 7.2 — Build operator job detail page**
- Acceptance:
  - Internal pipeline stages shown
  - Gate 1/2/3 results visible
  - Retry, rollback, force advance buttons functional
  - Role-gated

**Ticket 7.3 — Build alerts page**
- Acceptance:
  - Critical alerts listed from `/operator/alerts`
  - Severity levels styled (info/warning/error/critical)
  - Quick action buttons (acknowledge, retry)

**Ticket 7.4 — Build clients page**
- Acceptance:
  - Clients list visible
  - Status and activity shown
  - Row click navigates to client detail

**Ticket 7.5 — Build metrics page**
- Acceptance:
  - Basic KPI cards render
  - Placeholder charts supported (real data in Phase 3)

### Epic 8: Polish and usability (Week 6)

**Ticket 8.1 — Add loading, empty, and error states across customer app**
- Acceptance:
  - Every page has proper loading state
  - Empty states informative with CTAs
  - Failure copy is non-technical (no stack traces)

**Ticket 8.2 — Add responsive support for tablet and laptop widths**
- Acceptance:
  - Pages render correctly at 1280, 1024, 768 widths
  - Mobile not required for alpha

**Ticket 8.3 — Add toast notifications for key actions**
- Acceptance:
  - Success, warning, error toasts supported
  - Saved form → success toast
  - Failed API call → error toast

---

## 7. Onboarding + dashboard copy

Use these strings verbatim in Figma and in code. No paraphrasing.

### 7.1 Login

- **Headline:** "Run your content engine automatically"
- **Subtext:** "Turn your Twitch content into daily videos across YouTube, TikTok, and Instagram."
- **Primary button:** "Sign In"
- **Forgot password link:** "Forgot password?"
- **Signup link:** "No account yet? Create one"

### 7.2 Signup

- **Headline:** "Create your account"
- **Subtext:** "Get your content engine running in minutes."
- **Primary button:** "Create Account"
- **Login link:** "Already have an account? Sign in"

### 7.3 Onboarding Step 1

- **Headline:** "Connect your Twitch source"
- **Subtext:** "We'll use your channel to pull clips and create daily content automatically."
- **Helper text:** "Enter the creator account you want us to monitor."

### 7.4 Onboarding Step 2

- **Headline:** "Choose where to publish"
- **Subtext:** "Select the platforms where your videos should go."

### 7.5 Onboarding Step 3

- **Headline:** "Choose your output style"
- **Subtext:** "Start simple and expand later."
- **Auto Clips description:** "Short-form videos made from your Twitch clips, formatted and posted automatically."
- **Enhanced Videos description:** "AI-structured videos with optional voiceover, scene orchestration, overlays, and richer edits."
- **Enhanced Videos badge:** "Beta"

### 7.6 Onboarding Step 4

- **Headline:** "Set your posting schedule"
- **Subtext:** "Choose when you want content delivered and posted."

### 7.7 Onboarding Step 5

- **Headline:** "Review your setup"
- **Subtext:** "Your content engine is almost ready."
- **Primary button:** "Start My Content Engine"

### 7.8 Dashboard

- **Headline:** "Your content engine"
- **Subtext:** "Everything is running from your Twitch source and publishing automatically."

### 7.9 Customer-facing error messages

**When publishing fails** (Week 6 deliverable):

- "We had trouble processing this one. Our team has been notified and will look into it."
- (NO technical detail, NO stack traces, NO retry button — operator handles retry)

**When scheduling conflicts:**

- "This time conflicts with your existing schedule. Want to update it?"

**When Twitch integration fails:**

- "We couldn't reach your Twitch channel. Try reconnecting or contact support."

**When platform reconnection is needed:**

- "Your [Platform] connection expired. Reconnect to keep publishing."

### 7.10 Status labels (customer-facing simplification)

Internal job status → customer-facing display string:

| Internal `jobs.status` | Customer label |
|---|---|
| `queued` | "Scheduled" |
| `pulling_clips` | "Processing" |
| `scripting` | "Processing" |
| `rendering` | "Processing" |
| `assembling` | "Processing" |
| `publishing` | "Publishing" |
| `published` | "Posted" |
| `failed` | "Needs attention" |

Customer never sees the granular internal stage names. Only operator dashboard shows internal stages.

---

## 8. Build now vs later scope

### 8.1 Build now (Weeks 1-6 alpha)

- Customer auth (Clerk)
- Onboarding (5-step wizard)
- Dashboard
- Jobs (list + detail + create)
- Videos (list + detail)
- Schedule (create, edit, list)
- Integrations (Twitch, YouTube, TikTok, Instagram connections)
- Operator jobs view
- Operator alerts view
- Customer-friendly error states

### 8.2 Build later (Phase 3+)

- Billing integration (Stripe)
- Advanced analytics
- Customer preset editing (brand config, script templates)
- Full long-form controls
- Deep customization
- Public marketing site integrations
- Mobile app
- Complex role hierarchy beyond customer/operator/admin
- Full support system with ticket queue
- API access for customers

### 8.3 Never build

- Multi-niche content types in customer UI (News, NBA) until each is locked in operator-side first
- Customer-exposed pipeline details (gates, rollback, force advance)
- Feature flags for experimental pipeline stages on customer side
- Raw video editing tools
- Manual per-video approval flow (defeats the "set and forget" promise)

---

## 9. Handoff format for frontend dev

When Phase 2 starts and a frontend engineer is hired or assigned, give them exactly these four things:

### 9.1 Figma file

With these pages (per `PHASE_2_BUILD_SPEC.md` section 14):
- Foundations
- Components
- Customer App
- Operator App
- Flows (clickable prototypes)

### 9.2 Build spec

`PHASE_2_BUILD_SPEC.md` — the 6-week technical plan, monorepo structure, library choices, API contract.

### 9.3 Design package

This doc (`PHASE_2_DESIGN_PACKAGE.md`) — text wireframes, component map, copy strings, dev tickets, PRD.

### 9.4 API contract

The endpoints and payload shapes in `PHASE_2_BUILD_SPEC.md` section 7, plus the future `packages/types/` TypeScript definitions that get written during Week 2.

### 9.5 Dev tickets

Section 6 of this doc — ready-to-import into Jira as Epic 1–8 with individual tickets. Suggested import command once Jira CPD project is online:

```bash
# Placeholder — actual import script ships as part of Aider's overnight task queue
# node scripts/jira_import_tickets.js --file PHASE_2_DESIGN_PACKAGE.md --epic-prefix CPD
```

---

## 10. What this doc does NOT cover

- **Execution timeline** → `PHASE_2_BUILD_SPEC.md`
- **Stack architecture** → `AUTONOMOUS_PRODUCTION_ROADMAP.md` section 12
- **Business positioning** → `BUSINESS_STRATEGY.md`
- **Current Phase 1 smoke test work** → `CLINE_HANDOFF_NEWS_SMOKE_TEST_9_FIXES.md` (active)
- **Specific Figma frame content** → lives in the Figma file when it exists
- **Monorepo folder structure** → `PHASE_2_BUILD_SPEC.md` section 4
- **Database schema** → `PHASE_2_BUILD_SPEC.md` section 6.3
- **React Query, Zod, Drizzle library choices** → `PHASE_2_BUILD_SPEC.md` section 5
- **Phase 2 hard prerequisites** → `PHASE_2_BUILD_SPEC.md` section 2

---

## 11. Next action

Rob reads this doc alongside `PHASE_2_BUILD_SPEC.md`, annotates anything that doesn't match his intent.

Then:

1. **This doc lives dormant until Phase 1 locks.** Same prerequisite as the build spec — News, NBA, and at least one short-form content type all pass smoke tests.
2. **When Phase 1 locks,** both docs become active reference material for the Phase 2 execution.
3. **When Figma work starts,** this doc's text wireframes (§4) and copy strings (§7) drive the initial Figma frames.
4. **When Jira is online,** this doc's dev tickets (§6) import as Epic 1–8 with individual stories.
5. **When the frontend dev is hired,** hand over the 4-item handoff package (§9).
6. **No code changes triggered by this doc.** Phase 1 smoke test loop continues unchanged.

Until Rob approves, this is a proposal. After approval, it's the design and content source of truth for Phase 2.
