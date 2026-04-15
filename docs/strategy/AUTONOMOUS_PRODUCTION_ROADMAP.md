# AUTONOMOUS_PRODUCTION_ROADMAP.md

**Author:** Claude Code, drafted 2026-04-13
**Status:** Technical roadmap — Rob's decisions captured, reviewed against `BUSINESS_STRATEGY.md`
**Companion doc:** `BUSINESS_STRATEGY.md` — why we're building this; this doc is how we're building it
**Not a handoff.** No commit template, no Cline checklist. This is the engineering north-star for the 5-phase build from current state (dashboard mode) to autonomous public-facing production.

---

## 1. Executive summary

CWN currently runs in **operator mode**: Rob types into a dashboard, picks content manually, clicks generate, watches gates pass, intervenes on failures. This works for Rob's own show production but does not scale to external customers or public launch.

The target state is a **unified role-based platform** where:

- **One codebase, one UI.** Customers and operators use the same frontend with different permission levels.
- **Autonomous execution is a backend property**, not a UI mode. The same pipeline that runs Rob's show runs Customer 1's show, Customer 5's show, Customer N's show.
- **Customers schedule deliveries**; system works backward from the scheduled time to kick off the pipeline N hours earlier and hit the target window within ±5 minutes.
- **Operators (Rob + support team) get elevated permissions** on the same UI: see all jobs, manual override gates, resolve permission errors, edit customer settings, trigger manual retries, force-advance or rollback stuck jobs.
- **Failures are handled by the system first**, with rollback + retry up to a configured cap. Final failures produce 3 simultaneous alerts: customer dashboard, operator dashboard, Slack `#cwn-alerts` channel.

**Hard prerequisite for public launch:** 30 consecutive days of Railway soak testing under multi-client load with zero unrecoverable failures. Earliest feasible public launch window = **Q3 2026 (July-September)**, anchored on Railway migration happening by end of Q2 and the 30-day soak starting immediately after.

**Rob's own show becomes "Customer 0"** — an admin account with elevated permissions but otherwise running through the same customer path as external users. Smoke testing Rob's show IS battle-testing the customer platform.

---

## 2. The 5-phase plan

Each phase is gated on objective completion criteria, not calendar dates. Phase N+1 cannot start until Phase N's exit trigger fires.

### Phase 1 — Operator Product (CURRENT)

**State:** Rob produces his own show through the dashboard. Pipeline is built, gates work, publishing works, rollback works. Content types News, NBA, Twitch all exist but none has passed enough smoke tests to call "locked."

**Goal:** Lock all 3 content types through iterative smoke test loops. Produce 3+ reference-quality episodes of each type for Rob's YouTube channel.

**Active work:**
- News smoke test loop (test #8 in flight as of this writing, 10 fixes from `CLINE_HANDOFF_NEWS_SMOKE_TEST_7_FIXES.md` just shipped)
- NBA smoke test loop (queued behind News)
- Twitch smoke test loop (queued behind NBA)
- Shared newscast set migration (queued behind all 3 content types locked — see `SHARED_NEWSCAST_SET_MIGRATION.md`)

**What "locked" means per content type:**
- 3 consecutive smoke tests pass end-to-end with Gate 3 ≥90
- No new gaps surface in 2+ consecutive tests (gap backlog is stable)
- Rob's visual review is "ship it" without caveats
- The content type produces an 8-15 minute video per the target length
- Multi-episode splitting works when source material exceeds 5 items

**Exit trigger for Phase 1:** All 3 content types locked. Rob's own show running daily through the dashboard without manual intervention on routine production. Every feature needed for a single-operator single-customer production flow is stable.

**Estimated duration:** 2-6 weeks depending on smoke test cadence and HeyGen/Anthropic reliability windows.

---

### Phase 2 — Client Layer (Customer 1 → 2)

**Goal:** Add multi-tenant support to the existing pipeline. Onboard Customer 1. Prove the system can run a second production alongside Rob's without state collisions.

**Technical work:**

**2.1 Client abstraction in data layer**

Every job card currently has a flat structure (jobId, contentType, segments, etc.). Phase 2 adds a `clientId` field to every job, episode counter, publish history, and metrics entry. Data schema:

```json
{
  "clientId": "client_000_rob",
  "jobId": "script_twitch_1776094684574",
  "contentType": "twitch",
  "formType": "compilation",
  "platforms": ["youtube", "tiktok", "instagram"],
  "brandConfig": "default_twitch_soup",
  "scheduledDeliveryAt": "2026-04-15T14:00:00Z",
  "createdAt": "2026-04-15T08:00:00Z",
  ...
}
```

**Migration:** existing Rob-produced jobs get retroactively tagged `clientId: client_000_rob`. No data loss, just a field added to every row in `data/jobs.json`, `data/episode_counters.json`, `data/upload_status.json`.

**2.2 Template system per content type**

Each content type already has implicit templates (News uses the newscast chrome set, NBA has the TV card, Twitch has the intro card). Phase 2 extracts these into explicit per-client overridable templates:

- Script templates (script prompt per-client variant — default CWN voice, override to client brand voice)
- Caption templates (per-platform, per-client tone)
- Hashtag sets (per-client curated list, default to CWN auto-generated)
- Thumbnail templates (per-client Canva template ID)
- Top bar show title per content type per client (default = CWN show names, override for external clients)

**2.3 Content presets**

The 3 existing content types become the baseline for **content presets** — customer-selectable configurations:

- `preset_twitch_highlights` — Twitch GQL fetcher + 2-clip gate + Twitch Soup chrome
- `preset_news_daily` — RSS scraper + News scoring + newscast chrome
- `preset_sports_nba` — ESPN API + NBA voiceover + Other Side of the Pillow chrome
- `preset_custom_upload` — customer uploads their own source clips + custom script OR auto-generated script

Presets are entry points, not restrictions. Customer can pick a preset, customize within it, or go off-preset. Phase 2 ships the 3 baseline presets as code-defined; future phases let operators add presets through UI.

**2.4 Role-based permissions**

Single authentication layer with two role levels:

- **Customer role:**
  - View own jobs
  - Trigger own production runs
  - View own publish history
  - Edit own schedule + brand config
  - Approve/reject own Gate 3 manual reviews
  - View own gate reports
- **Operator role (Rob + support team):**
  - Everything customer role can do
  - PLUS: view all clients' jobs
  - PLUS: manual override any gate (force-pass, force-fail)
  - PLUS: rollback/force-advance any job regardless of owner
  - PLUS: edit customer brand configs, presets, permissions
  - PLUS: resolve permission errors (re-auth Drive / HeyGen / Upload-Post per client)
  - PLUS: view cost metrics, token usage, system health
  - PLUS: trigger manual retries on failed jobs
  - PLUS: edit customer schedule on their behalf

Auth mechanism: session-based login at UI, role stored in session + database. No JWT, no OAuth for launch — simple email+password with role claim.

**2.5 Customer dashboard view (simplified)**

Customer-facing dashboard is the SAME code as Rob's current dashboard, with operator-only sections hidden via role check. Customer sees:

- Their jobs (in-flight + historical)
- Schedule picker
- Brand config (colors, show name, platforms)
- Publish history
- Simple gate status (pass / hold / failed — not the full 100-point deduction breakdown)
- Download links for produced MP4s

Customer does NOT see:
- Other customers' jobs
- Operator-only gate detail
- Rollback/force-advance buttons
- Token/cost metrics
- Server logs

**2.6 Autonomous Gate-to-Gate Progression (REQUIRED for Customer 1)**

This is a hard requirement before the first customer goes live. A customer cannot be expected to manually intervene on gate failures — the system must handle recovery automatically.

**Gate outcome → system action (per gate):**

| Outcome | Action |
|---|---|
| `pass` | Auto-advance to next gate immediately |
| `manual_review` | Retry up to 2x with same parameters. If still manual_review after retries → hold for operator alert |
| `fail` | Rollback to previous gate, retry with adjusted parameters (see below). If still failing after retry cap → triple alert (customer dashboard + operator dashboard + Slack `#cwn-alerts`) |
| `pre_flight_fail` | Call `/assemble/:asmId/retry` automatically — re-run FFmpeg from existing tmp segments before escalating. No HeyGen credits spent. |

**Retry parameters per gate:**
- **Gate 1 fail:** Re-run script generation with increased temperature / different style guide variant. Cap: 2 retries.
- **Gate 2 fail:** Re-download failed segments from HeyGen. If HeyGen render actually failed, re-submit that segment only. Cap: 3 retries per segment.
- **Gate 3 fail:** If `pre_flight_fail` → retry assembly from tmp segments. If Gemini QA fail → retry assembly (different random seed for ticker). Cap: 2 retries.
- **Gate 6 fail:** Retry Upload-Post call. Cap: 3 retries with exponential backoff.

**Rollback/force-advance buttons remain** — but as operator-only escape hatches when the autonomous loop exhausts its retry cap. Customers never see them.

**Alert format (triple alert on cap exhaustion):**
```
Job {jobId} failed at Gate {N} after {retryCount} retries.
Content type: {contentType} | Client: {clientId}
Last error: {error}
Gate report: {qaReport summary}
Action required: [View Job] [Force Advance] [Rollback]
```

**Exit trigger for Phase 2:** Customer 1 onboarded, posting daily for 30 consecutive days with ≤1 operator intervention per week. No data leakage between customers (Customer 1 cannot see Rob's jobs, Rob sees both with operator role). Job state isolation verified through manual + automated tests. **Autonomous gate progression running with zero manual touchpoints on routine production.**

**Estimated duration:** 4-8 weeks.

---

### Phase 3 — Automation Layer

**Goal:** Remove Rob from the routine production loop. Customer jobs run end-to-end without operator touchpoint ≥80% of the time.

**Technical work:**

**3.1 Auto QA thresholds**

Every gate already has pass/manual-review/hard-fail thresholds. Phase 3 makes these **per-client tunable** and introduces auto-approval logic:

- Customer sets their quality tolerance (strict / standard / permissive)
- Strict: manual-review items hold for customer approval
- Standard: manual-review items hold for operator approval
- Permissive: manual-review items auto-proceed (log only)
- Hard-fail: always holds regardless of setting

Rob's Customer 0 account defaults to Permissive (he's willing to eat the risk on his own show for throughput). Paying customers default to Standard (operator approval) until they've seen enough output to downgrade to Permissive.

**3.2 Default approvals**

Currently Gate 3 >= 70 auto-proceeds to publish. Phase 3 extends this to all stages:

- Gate 1 script >= customer threshold → auto-proceed
- Gate 2 segments >= threshold → auto-proceed
- Gate 3 assembly >= threshold → auto-proceed
- Gate 6 publish verification auto-confirms if Upload-Post returns job_id

Manual review holds only fire when:
- Score between customer's hold and pass thresholds
- Critical failure flag fires (e.g., clipsExpectedButMissing, video freeze)
- Explicit customer setting to always-review

**3.3 Model Routing by Task Type**

Not every task needs the most capable (most expensive) model. Route each pipeline task to the model best matched to its requirements — quality where it matters, cost efficiency where it doesn't.

**Routing table:**

| Task | Current | Target Model | Reason |
|---|---|---|---|
| Script generation (Twitch/NBA/News) | Gemini 2.5 Flash | Gemini 2.5 Pro | Highest quality output — this is the creative core |
| Gate 1 script QA | Claude Sonnet 4.6 | Claude Opus 4.6 | Deep reasoning on script structure and quality |
| Gate 2 segment QA | Gemini 2.5 Flash | Gemini 2.5 Flash | Visual check — Flash is sufficient |
| Gate 3 assembly QA | Gemini 2.5 Flash | Gemini 2.5 Flash | Visual check — Flash is sufficient |
| Publish copy generation | Claude Sonnet 4.6 | Claude Sonnet 4.6 | SEO copywriting — Sonnet is right size |
| Hook moment extraction | Claude Haiku 4.5 | Claude Haiku 4.5 | Simple extraction task — Haiku sufficient |
| Clip scoring / ranking | Gemini 2.5 Flash | Gemini 2.5 Flash | Fast multi-clip analysis |
| Error diagnosis / retry decisions | Claude Sonnet 4.6 | Claude Sonnet 4.6 | Reasoning on gate failures |

**Implementation:** Add `modelConfig` to `channelConfig` per client. Operator-tunable per content type. Default routing table above is the baseline. High-volume clients can opt down to Flash/Haiku across the board for cost. Premium clients can opt up to Opus/Pro for max quality.

```json
{
  "modelConfig": {
    "scriptGeneration": "gemini-2.5-pro",
    "gate1QA": "claude-opus-4-6",
    "gate2QA": "gemini-2.5-flash",
    "gate3QA": "gemini-2.5-flash",
    "publishCopy": "claude-sonnet-4-6",
    "hookExtraction": "claude-haiku-4-5"
  }
}
```

**Cost impact:** Routing script gen to Pro + Gate 1 to Opus adds ~$0.15/job. Routing everything else to Flash/Haiku saves ~$0.05/job. Net: ~$0.10/job premium for quality routing vs flat Flash. At 60 jobs/month = $6/month — negligible against HeyGen costs.

**3.4 Scheduled publishing with backward-time calculation**

Core feature of Phase 3. The current scheduling UI is a flat image placeholder. Phase 3 wires it up:

- Customer picks desired publish time (e.g., "Tuesday 2pm ET")
- System estimates pipeline duration based on content type + recent performance:
  - News: ~18 min average (script gen 2m + HeyGen 7m + assembly 4m + gates 3m + publish 2m)
  - NBA: ~22 min average (voiceover mix adds ~4m)
  - Twitch: ~15 min average
- System schedules pipeline kickoff = deliveryTime - estimatedDuration - 10 min buffer
- At kickoff time, scheduler fires the same endpoints the dashboard "generate" button fires today
- If pipeline runs faster than estimate, finished job waits in Upload-Post queue for scheduled publish
- If pipeline runs slower than estimate, system alerts customer + operator ASAP and publishes as soon as possible with apology flag

**Accuracy target:** ≥95% of scheduled jobs publish within ±5 minutes of the customer's requested time during Railway soak.

**3.4 Retry logic with configured cap**

Every external API call (Anthropic, Gemini, HeyGen, Upload-Post, Brightcove CDN, Twitch GQL) gets wrapped in retry logic with exponential backoff and a configured cap:

- Network/5xx errors: retry up to 3 times with 2s, 4s, 8s backoff
- Rate limit (429): retry after Retry-After header OR 60s default, up to 3 attempts
- Anthropic 529 overloaded: backoff 30s, 60s, 120s, up to 3 attempts
- HeyGen rendering stuck >30min: alert, do not auto-retry (escalate to operator)
- Upload-Post failure: retry 3x with 5m, 10m, 20m backoff
- Script generation validation failure (Gate 1 content fail): regenerate up to 3 times (current behavior)

**Each retry context is tracked in `logs/retries.jsonl`** for post-mortem analysis.

**3.5 Three-channel alerting**

Final failures (after retry cap exhausted) produce simultaneous alerts on 3 channels:

1. **Customer dashboard** — red alert card on the affected job with error summary and "contact support" button
2. **Operator dashboard** — new alerts panel showing all active customer incidents
3. **Slack webhook** — POST to `#cwn-alerts` channel with job ID, customer ID, error, retry history

Alert escalation rules:
- Customer-visible: always on final failure
- Operator-visible: always on final failure
- Slack: always on final failure; ALSO on any unrecoverable state (stuck >2h, disk full, OOM)

**Not in Phase 3:** PagerDuty. That's Phase 5 when CWN has 24/7 customer SLAs.

**Exit trigger for Phase 3:** ≥80% of customer jobs complete end-to-end without operator intervention. Alerts fire correctly on test failures. Scheduled publishing hits ±5 min target on ≥90% of runs during a 2-week trial.

**Estimated duration:** 3-6 weeks.

---

### Phase 4 — SaaS Prep

**Goal:** Simplify the UI so a new customer can onboard and publish their first video in <10 minutes without operator help.

**Technical work:**

**4.1 Customer onboarding flow**

New multi-step wizard UI (separate from the current operator-heavy dashboard):

1. **Step 1 — Account creation:** email, password, name, company (optional)
2. **Step 2 — Platform connections:** OAuth flow for YouTube, TikTok, Instagram via Upload-Post connector
3. **Step 3 — Content source:** pick preset OR upload files OR connect source URL (YouTube channel / podcast feed / Twitch channel)
4. **Step 4 — Brand config:** show name, primary color, accent color, logo upload, tagline
5. **Step 5 — First run:** pick a recent piece of source material, click generate, watch first video ship

Total time target: **<10 minutes from signup to first video in production.**

**4.2 Simplified production view**

Customer view hides all gate detail. Shows:

- Jobs list: "In progress" / "Ready for review" / "Published" / "Failed"
- Click a job → see simple status (current stage), progress bar, published links
- No gate reports, no deduction breakdowns, no rollback buttons
- Operator view preserves all the detail; customer view is a thin layer on top

**4.3 Scheduling UI v2**

Current scheduling (from Phase 3) is functional but operator-grade. Phase 4 adds:

- Calendar view with drag-drop for rescheduling
- Recurring schedules ("every Tuesday at 2pm")
- Time zone awareness
- Bulk scheduling (schedule 30 videos for the next 30 days in one action)
- Preview: "if you kick this off at 12:00, it publishes at 2:00"

**4.4 Simplified preset editor**

Operator can create new presets in code. Phase 4 adds a UI for operators to clone existing presets and tweak them without code changes. Customer-level preset editing (full customization) is Phase 5.

**4.5 Billing integration**

First integration with Stripe for monthly subscription billing:
- Customer billed monthly on anniversary of signup
- Plan tiers: Starter ($1.5K), Standard ($2K), Premium ($3K)
- Failed payment → pause production, alert customer + operator
- Cancellation → archive jobs, preserve data for 90 days

**Exit trigger for Phase 4:** New test customer can sign up, onboard, and publish first video in <10 minutes with zero operator intervention. Billing works end-to-end for 1 month.

**Estimated duration:** 4-8 weeks.

---

### Phase 5 — SaaS MVP (Public Launch Readiness)

**Goal:** Full self-serve SaaS. Customer finds CWN, signs up, uses it, pays, churns or upgrades — all without Rob touching anything.

**Technical work:**

**5.1 Product Hunt / Twitter launch prep**
- Landing page (marketing site separate from the app)
- Pricing page with tier comparison
- Case studies from Phase 2-4 customers
- Demo video showing onboarding → first video
- FAQ / help docs
- Support email + response SLA

**5.2 Free trial mechanic**
- 7-day trial: limited output (3 videos), full features
- **Credit card required on file to start trial** — Rob's rule, filters tire-kickers while letting real prospects preview the product
- Auto-converts to paid plan on day 8 unless cancelled
- Trial-to-paid conversion email sequence
- Only active in Phase 5 SaaS motion; Phase 1-4 service customers never see a trial flow

**5.3 Single-flow UI**

```
Input → Generate → Publish
```

Eliminate pipeline visibility from customer view entirely. Customer uploads, clicks one button, sees a progress bar, gets videos. All the gate complexity is invisible. Operators still see everything.

**5.4 Customer support queue**

Support tickets from customer dashboard land in an operator-accessible queue. Operator claims tickets, resolves, marks done. Simple Zendesk-lite. Can replace with real Zendesk/Intercom later.

**5.5 Analytics + dashboards**

Customer analytics:
- Total videos published
- Views / likes / comments per platform per video
- Trending topics from their own content
- Revenue generated (if YouTube Partner Program integrated)

Operator analytics:
- MRR / churn / LTV per customer cohort
- System load / cost per job / profit margin
- Gate pass rates across all customers
- Alert frequency / incident counts

**Exit trigger for Phase 5 → Public Launch:**

1. **Railway soak test passed** (see section 4 for criteria)
2. **Phases 1-4 all complete** with exit triggers fired
3. **3+ beta customers happy** and willing to be public references
4. **Support queue response SLA documented** (e.g., "response within 4 hours Mon-Fri")
5. **Legal review complete** — ToS, Privacy Policy, acceptable use policy
6. **Rob's explicit "go live" call** — not automated, Rob decides based on gut + data

**Estimated duration:** 6-12 weeks.

---

## 3. Unified UI architecture

**One codebase. One UI. Role-based access.**

### Routing pattern

```
/login               — public
/dashboard           — customer or operator (both see this, operator sees more)
/dashboard/jobs      — jobs list (customer = own, operator = all)
/dashboard/schedule  — schedule picker
/dashboard/brand     — brand config per client
/dashboard/publish   — publish history
/dashboard/admin     — operator-only (hidden for customer role)
/dashboard/admin/clients       — manage all clients
/dashboard/admin/alerts        — active incidents
/dashboard/admin/metrics       — system + cost metrics
/dashboard/admin/presets       — preset editor
/dashboard/admin/permissions   — grant/revoke roles
```

### Role-based component rendering

Every React (or vanilla JS) component that could expose operator-only data wraps its content in:

```js
if (session.role === 'operator' || session.role === 'admin') {
  // render sensitive content
} else {
  // render customer-safe version or nothing
}
```

Backend API endpoints also enforce at the data layer:

```js
app.get('/jobs', requireAuth, (req, res) => {
  if (req.session.role === 'operator' || req.session.role === 'admin') {
    res.json(getAllJobs());
  } else {
    res.json(getJobsForClient(req.session.clientId));
  }
});
```

**Never trust the frontend alone to hide operator features.** Every endpoint re-validates role before returning data.

### Support team onboarding path

When CWN hires a support team (Phase 3-5), new support members:
1. Get an email invite from Rob's operator account
2. Accept → create operator-role account
3. Can view all customers, all jobs, all alerts
4. Can resolve customer issues: re-auth failed platforms, edit brand configs, manual override stuck gates, trigger manual retries
5. Cannot change billing, cannot delete customer accounts, cannot promote other users to operator role (admin-only)

**3 role levels total:**
- `customer` — own data only
- `operator` — all customer data, all operational controls, no admin functions
- `admin` — everything + user management (Rob at launch, possibly 1-2 trusted support leads later)

---

## 4. Railway soak test criteria (pre-public-launch gate)

The 30-day Railway soak test is a **hard gate** before public launch. Rob's call:

> "have to be on railway for at least a month while working on the roadmap items and pressure testing the environment that it can remain stable on railway with multiple jobs running"

**Measurable exit criteria:**

### 4.1 Duration

- **30 consecutive days** on Railway without critical incident
- A critical incident resets the counter. Critical = unrecoverable job, data loss, >1h of downtime, or security issue
- Non-critical incidents (temporary API outages, single-job retries) do NOT reset the counter but are logged

### 4.2 Concurrent load

- **Minimum 3 content types running simultaneously** at least 1× per week during soak
- **Minimum 2 concurrent customer jobs** running at least 1× per week during soak (starting from Phase 3 when multi-client is live)
- **Peak load test** at least 1× during soak: 5 concurrent jobs for 1 hour, all must complete

### 4.3 Reliability

- **Zero unrecoverable failures** — every job completes OR fails cleanly with rollback + alert
- **No stuck-in-limbo jobs** — no jobs sitting in a state for >2h without status progression (HeyGen outages don't count as stuck; actively-polled-in-waiting does not equal stuck)
- **Gate pass rates ≥80%** per content type across the soak window:
  - News: ≥80% of runs pass Gate 3 at ≥70 without intervention
  - NBA: ≥80% of runs pass Gate 3 at ≥70 without intervention
  - Twitch: ≥80% of runs pass Gate 3 at ≥70 without intervention
- **Scheduled-delivery accuracy** (Phase 3+): ≥95% of scheduled jobs publish within ±5 minutes of customer-requested time

### 4.4 Cost discipline

- **Token budget** — monthly Anthropic + Gemini cost stays within declared cap (TBD, Rob sets based on customer count)
- **HeyGen segment cost** — stays within $2 per long-form video average
- **No retry-loop cost explosions** — Gate 1 529 retries don't burn >$1 per occurrence
- **Upload-Post** — flat monthly fee, no per-upload surprises

### 4.5 Infrastructure

- **Memory stays below Railway plan limit** — no OOM kills
- **Disk stays below Railway plan limit** — auto-cleanup fires at 80% full, never hits 100%
- **CPU stays below sustained 80%** for any 10-minute window
- **Network egress** — stays within Railway plan limit
- **Startup reliability** — Railway container restarts cleanly on every deploy / config change / crash

### 4.6 Observability

- **All alerts fire correctly** during induced failure tests (manually trigger a bad job, verify 3-channel alert)
- **Metrics dashboard** shows current system state at any time (active jobs, queue depth, error rates)
- **Logs are searchable** via Railway's native log viewer OR a forwarded destination (Datadog / Logtail / etc)

**If any of these criteria fail during soak:** the soak counter resets. Fix the root cause, restart the 30-day clock. No shortcuts.

### 4.7 Why 30 days specifically

Rob's call. Rationale: 30 days is long enough to catch weekly usage patterns, month-end cost spikes, and real-world edge cases that don't surface in a 1-week burn-in. Shorter (14 days) misses the monthly cycle. Longer (60 days) delays launch without proportionally increasing confidence.

---

## 5. Failure handling policy (detailed)

Per Rob: system handles rollback/force-forward autonomously up to a configured cap, then alerts 3 channels. Here's the detail.

### 5.1 Retry cap per stage

| Stage | Automatic retries | Retry condition | Post-cap action |
|---|---|---|---|
| Twitch GQL resolution | 2 | Timeout or 5xx | Drop streamer from episode, continue |
| News RSS scrape | 2 | Timeout or 5xx | Drop story from episode, continue |
| News article scrape | 2 | Timeout or 404 | Drop clip, continue with avatar-only story |
| Gemini clip analysis | 2 | Timeout or 429 | Fall back to thumbnail analysis |
| Gemini script gen | 3 | Timeout or 429 | Hard fail, alert |
| Claude Gate 1 QA | 3 | 5xx / 429 / 529 | Hard fail, alert (NOT regenerate script on 5xx — distinguish network from content fails) |
| HeyGen /video/generate | 2 | 5xx or 429 | Hard fail, alert |
| HeyGen poller | infinite with 30m stuck timeout | any transient | Alert operator at 30m stuck, no auto-retry |
| Brightcove HLS download | 2 | 5xx or timeout | Drop clip, continue with silence placeholder |
| FFmpeg assembly | 1 | Unknown error | Hard fail, alert |
| Gemini Gate 2/3 QA | 2 | Timeout or 5xx | Manual review hold |
| Upload-Post publish | 3 | 5xx or 429 | Hard fail, alert |

### 5.2 Rollback on failure

When a stage hard-fails post-retries, the system attempts rollback to the previous stable checkpoint:

- Gate 1 fail → no rollback needed, nothing was produced yet. Alert + halt.
- HeyGen fail → rollback to `script_ready` state, allow retry or manual intervention
- Gate 2 fail → rollback to `all_sent` state (segments exist but not assembled)
- Assembly fail → rollback to `all_sent` state (keep HeyGen segments, clear partial assembly artifacts)
- Gate 3 fail → rollback to `assembled` state (keep MP4, clear publish attempt)
- Publish fail → rollback to `assembled` state, retry publish later

Each rollback logs to `logs/rollbacks.jsonl` for audit.

### 5.3 Force-advance policy

Currently force-advance is an operator-only manual action (`POST /job/:id/advance`). Phase 3 keeps it operator-only — automation never auto-advances. Reason: auto-advance on a questionable score is risky. Better to alert and hold than ship bad content.

### 5.4 Alert channels (3 simultaneous)

When a job hard-fails (post-retry-cap, post-rollback-if-applicable), system fires 3 alerts in parallel:

**Channel 1 — Customer dashboard**
- Red banner on the affected job card
- Error category (script gen failed / video render failed / publish failed / etc)
- Suggested action ("We're looking into this. Support has been notified.")
- Link to contact support

**Channel 2 — Operator dashboard**
- New row in alerts panel
- Full error detail (stack trace, retry history, input context)
- Quick-action buttons: retry, manual override, contact customer, escalate
- Links to job state, logs, related gate reports

**Channel 3 — Slack webhook to `#cwn-alerts`**
- Message format:
  ```
  🚨 CWN ALERT — [severity] [customer name]
  Job: [jobId]
  Stage: [failed stage]
  Error: [summary]
  Retries attempted: [N]
  Rolled back to: [state]
  Dashboard: [deep link]
  ```
- Operator acknowledges in Slack via emoji reaction
- Unacknowledged alerts re-ping every 15 minutes until acknowledged or resolved

**No PagerDuty at launch.** PagerDuty is Phase 5+ when CWN has paying customers on 24/7 SLAs. For launch and early scale, Slack + email is sufficient.

### 5.5 Customer never sees token-level detail

Customers see abstracted errors:
- "Script generation failed — we're investigating"
- NOT: "Claude API 529 overloaded after 3 retries"

Operators see full detail. Customer's view is always simplified.

---

## 6. Data architecture for multi-tenancy

### 6.1 Runtime state files

Current state:
- `data/jobs.json` — in-memory + disk persistence of all jobs
- `data/episode_counters.json` — per-content-type counter
- `data/upload_status.json` — publish history
- `data/streamers.json` — Twitch roster
- `data/cwn_style_guides.json` — Gemini style fingerprints
- `data/brand_configs.json` — (proposed in shared-set migration doc) per-brand config

Phase 2 additions:
- **`data/clients.json`** — client registry (clientId, email, name, plan, role, created, suspended)
- **`data/brand_configs.json`** — per-client brand configs (currently proposed per-content-type; Phase 2 makes it per-client instead, with content-type sub-configs)
- All existing files get a `clientId` field on every row

**Rob as Customer 0:**
```json
{
  "client_000_rob": {
    "email": "gregory.robert.c@gmail.com",
    "name": "Rob Gregory",
    "role": "admin",
    "plan": "unlimited_internal",
    "created": "2026-04-15T00:00:00Z",
    "suspended": false
  }
}
```

All existing jobs get retroactively tagged `clientId: "client_000_rob"` during Phase 2 migration.

### 6.2 Episode counter per client per content type

Current: `{twitch: 38, nba: 27, news: 32}` — global per content type.

Phase 2 restructure:
```json
{
  "client_000_rob": {"twitch": 38, "nba": 27, "news": 32},
  "client_001": {"twitch": 3, "nba": 0, "news": 7}
}
```

Each client has their own episode counter per content type. Customer 1's "Twitch Soup Episode 3" is independent of Rob's "Twitch Soup Episode 38."

### 6.3 Episode counter reset trigger (from section 10.5 of shared-set migration)

**Trigger:** After BOTH News long-form AND NBA long-form pass smoke tests cleanly.

At that point, reset `client_000_rob` episode counters to `{twitch: 0, nba: 0, news: 0}`. The next successfully-produced-and-published episode for each content type becomes Episode 1. This is a clean-slate marker for Rob's production, not a renumbering of past episodes.

Customer clients are unaffected — they start at 1 when onboarded.

### 6.4 Database question

Current: flat JSON files on disk, loaded into memory on startup. Works for single-operator / single-customer. Works for Customer 1 in Phase 2.

At Customer 3+, JSON file I/O becomes a bottleneck. Phase 3 or 4 needs a real database:

- **SQLite** — simplest migration, single file, fine for 10-100 customers
- **Postgres on Railway** — more scalable, native Railway add-on, better for >100 customers

Decision point: Phase 3 start. Rob picks SQLite or Postgres based on how fast customer count is growing. Migration is a known-complexity task (read JSON → write schema → update server.js queries) — not a surprise.

---

## 7. Candidate selection layer (Phase 3+)

Current state: Rob types into the dashboard. Dashboard fields ARE the candidate selection.

Target state (Phase 3): for each content type, the system autonomously surveys candidates and picks N items that pass the gates and fit the episode length target.

### 7.1 News candidate selection

- **Survey:** RSS fetch from Al Jazeera + any other diversified sources (diversification is a separate task in `LONGFORM_FIX_ROTATION.md`)
- **Score:** existing `prioritizeNewsStories()` urgency keyword detector + recency weight
- **Gate:** og:image scrape success, clip scrape success (if Road A), Gemini analysis success
- **Pick:** top 5 stories that pass the gate; if <5 pass, either produce a smaller episode or wait for more source material
- **Split:** if >5 stories pass, produce 2 episodes of 5 per the multi-episode split logic (see `SHARED_NEWSCAST_SET_MIGRATION.md` section 11.3)

### 7.2 NBA candidate selection

- **Survey:** ESPN API for last 24h games
- **Score:** game importance (playoff > regular, close game > blowout), recency, duration fit
- **Gate:** highlight clip available via ESPN CDN, clip duration 20-45s, Gemini analysis success
- **Pick:** 3-4 games that pass the gate and fit the 8-15 min target
- **Split:** if source material exceeds 4 games, produce 2 episodes

### 7.3 Twitch candidate selection

- **Survey:** GQL fetch across 12 active streamers (roster from `data/streamers.json`, per-client override in Phase 2)
- **Score:** clip recency, clip view count, clip resolution success rate
- **Gate:** streamer has ≥ `clipsPerStreamer` valid clips after GQL resolution (see `SHARED_NEWSCAST_SET_MIGRATION.md` section 10.4)
- **Pick:** first 5 streamers that pass the gate
- **Split:** if >5 streamers pass, produce 2 episodes of 5 each

### 7.4 NFL candidate selection (August 2026 target)

- **Survey:** TBD — NFL public API? ESPN NFL API? Third-party?
- **Score:** TBD
- **Gate:** TBD
- **Pick:** TBD
- **Split:** TBD

**NFL is a forcing function.** An August 2026 launch for NFL means the candidate selection framework must be flexible enough to add a new content type by dropping in a new selector module. Phase 3 architecture should explicitly make this easy — each content type implements a `CandidateSelector` interface (survey, score, gate, pick, split) and the pipeline is indifferent to which type is running.

### 7.5 Custom upload flow (for Phase 2+ external customers)

External customers may not want News/NBA/Twitch at all. They may want:
- "Here are my Twitch clips, make me videos from them"
- "Here's my YouTube channel URL, pull new uploads and make shorts from them"
- "Here's my podcast RSS, make clips from each new episode"

The custom upload flow is a **content preset category**:
- `preset_custom_upload` — customer-provided clip files
- `preset_custom_youtube_feed` — customer-provided YouTube channel URL
- `preset_custom_podcast_feed` — customer-provided RSS URL
- `preset_custom_twitch_channel` — customer-provided single Twitch username (vs the CWN multi-streamer roster)

All custom presets bypass the candidate survey (customer provides the source directly) and jump straight to the gate + pick stage.

**This answers the open product question** from `BUSINESS_STRATEGY.md` section 13 about "content type vs content engine." The answer is **both**: 3 pre-built content types for the CWN use case + an open "bring your own source" flow for everyone else. Presets are entry points, not restrictions.

---

## 8. What this doc does NOT cover

Intentional scope limits:

- **Business strategy / positioning / GTM / pricing** — see `BUSINESS_STRATEGY.md`
- **Specific smoke test fix lists** — see active handoff docs (`CLINE_HANDOFF_NEWS_SMOKE_TEST_7_FIXES.md`, etc)
- **Shared newscast set migration** — see `SHARED_NEWSCAST_SET_MIGRATION.md`
- **NBA voiceover V2 technical details** — see `CLINE_HANDOFF_NBA_VOICEOVER_FFMPEG_V2.md`
- **Legal / contracts / ToS / privacy** — separate legal work, not engineering scope
- **Hiring plan for support team** — business strategy + recruiting concern, not in this doc
- **Financial projections** — business strategy, not here

---

## 9. Open technical questions

These are NOT blockers for Phase 1 but must be resolved before or during the phases noted.

**Q-T0. Stack architecture (Rob locked 2026-04-13):** split frontend from backend. See section 12 for full decision.

**Q-T1. Database choice (by end of Phase 2):** SQLite vs Postgres on Railway. Depends on expected customer count in Phase 3. **Updated 2026-04-13:** Postgres on Railway is the preferred answer per Q-T0 stack decision — the frontend/backend split means the database lives with the backend in Railway, and Postgres is the natural choice for a multi-tenant SaaS dashboard (vs SQLite which is single-writer and doesn't scale past ~10 customers).

**Q-T2. Authentication library (by start of Phase 2):** ~~Passport.js vs Auth0 vs roll-your-own session auth~~. **Updated 2026-04-13 per Q-T0:** with Next.js as the frontend, the preferred answer is **Clerk** (Next.js-native, drop-in auth components, free tier covers first customers) or **Supabase Auth** (if we use Supabase for anything else). Clerk is the default unless Supabase enters the stack for another reason. Both have first-class Next.js App Router integration. Passport.js and roll-your-own are retracted — neither matches the frontend stack anymore.

**Q-T3. Billing integration (by start of Phase 4):** Stripe directly vs Stripe via Paddle for international tax. Rob's call based on target customer geography.

**Q-T4. Slack webhook setup (by start of Phase 3):** which workspace, which channel name, who has access. Rob sets this up 1 hour before Phase 3 alerts ship.

**Q-T5. NFL content type survey API (by July 2026):** which API to use for NFL data. Rob or a support hire researches during Phase 3-4.

**Q-T6. Railway plan sizing (by start of Phase 4):** which Railway tier to use. Depends on expected customer count and content volume. Starts on Hobby/Starter, upgrades as needed during soak test.

**Q-T7. Customer file upload handling (by start of Phase 4):** where do customer-uploaded files live (Railway disk vs S3 vs other). Disk is fine for small scale, S3-like service for bigger.

**Q-T8. Video delivery CDN (by Phase 5):** produced MP4s need to be served to customers for download. Google Drive works for Rob + a few customers but doesn't scale. Cloudflare R2 or S3 at scale.

**Q-T7/T8 preferred answer (Rob direction 2026-04-13):** see section 12 for the full stack architecture. Binary asset storage follows a 3-tier pattern:

- **Tier 1 — Railway persistent volume:** hot/active job state only (tmp/ renders in flight, job cards, current pipeline artifacts). Wiped on container redeploy tolerable because data is short-lived.
- **Tier 2 — Cloudflare R2 (preferred) or S3:** cold storage for music library (`assets/audio/*`), customer-uploaded source material, produced MP4 archive, Gemini-uploaded QA evidence. R2 preferred over S3 because zero egress fees save money on video delivery at scale. S3-compatible API so existing Node libraries (aws-sdk, @aws-sdk/client-s3) work without rewrite.
- **Tier 3 — CDN (Cloudflare, Bunny) for customer-facing downloads:** produced MP4s served via signed URLs to customers who downloaded their own content. Not needed until multi-customer Phase 2+.

**Current state (localhost, 2026-04-13):** everything lives on Rob's MacBook disk — `assets/audio/` music library, `tmp/` hot state, `output/` MP4 archive, `data/jobs.json` persisted state. Works fine because single-operator single-machine. MP3 library committed to git is fine at current scale because file count is low (~10) and size is small (few MB each). This entire architecture migrates during the Phase 2 → Phase 3 transition when Railway becomes the primary host.

---

## 12. Stack architecture — locked 2026-04-13

Captured from Rob's stack decision 2026-04-13 PM. This is the target architecture for Phase 2 onward. Phase 1 (current) continues on localhost Node + vanilla HTML dashboard with no changes — the stack migration happens at the Phase 1 → Phase 2 transition.

### 12.1 The split

**Frontend** and **backend** are separate deployments on separate hosts:

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  Frontend (Vercel)          │         │  Backend (Railway)           │
│                             │         │                              │
│  Next.js (App Router)       │  HTTPS  │  Node / Express              │
│  Tailwind + shadcn/ui       │ ──────▶ │  FFmpeg pipeline             │
│  Clerk or Supabase Auth     │         │  HeyGen / Gemini / Claude    │
│                             │  JSON   │  Upload-Post integration     │
│  UI only                    │ ◀────── │  Job queue + gates           │
│  calls backend API          │         │  Postgres (Railway add-on)   │
└─────────────────────────────┘         └──────────────────────────────┘
                                                       │
                                                       ▼
                                        ┌──────────────────────────────┐
                                        │  Storage (Cloudflare R2)     │
                                        │                              │
                                        │  Music library               │
                                        │  Customer uploads            │
                                        │  Produced MP4 archive        │
                                        │  Gemini QA evidence          │
                                        └──────────────────────────────┘
```

### 12.2 Why this split beats Railway-only

**Rob's rule:** *"Railway is PERFECT for your engine. But not ideal for your UI."*

Frontend on Vercel:
- Instant page loads via edge caching and static generation
- Global CDN for landing pages and dashboard assets
- Built-in Next.js optimization (image, font, code splitting)
- First-class auth integrations (Clerk, Supabase Auth)
- Preview deployments per git branch for QA

Backend on Railway:
- Persistent long-running processes (FFmpeg, Puppeteer, Gemini polling)
- Persistent volume for hot job state
- Postgres add-on native
- Health checks + auto-restart on container failure
- Predictable pricing for compute-heavy workloads (FFmpeg is NOT cheap on serverless)

Splitting them means each host does what it's best at. A Railway-only option exists (Next.js can run on Railway) but **loses the edge rendering and global performance** that make the customer-facing dashboard feel professional.

### 12.3 The full stack

| Layer | Technology | Host | Why |
|---|---|---|---|
| **Frontend framework** | Next.js (App Router) | Vercel | Full-stack capability, SSR + client rendering, best-in-class SaaS dashboard tooling |
| **UI components** | Tailwind CSS + shadcn/ui | Vercel (static) | Unstyled accessible primitives + utility-first styling, no runtime cost |
| **Auth** | Clerk (default) OR Supabase Auth | Vercel (client-side SDK) | Drop-in Next.js integration, free tier covers launch, role-based permissions built in |
| **API layer** | Node / Express REST | Railway | Existing `server.js` migrates as-is, minimal refactor, Railway-native |
| **Job queue** | In-process + persistent job cards | Railway | Current pattern works; upgrade to BullMQ+Redis later if needed |
| **Video pipeline** | FFmpeg + Puppeteer + HeyGen/Gemini/Claude SDKs | Railway | Compute-heavy, existing code, requires persistent disk for tmp/ |
| **Database** | Postgres (Railway add-on) | Railway | Multi-tenant SaaS standard, supersedes JSON file persistence |
| **Hot storage** | Railway persistent volume | Railway | tmp/ renders in flight, job cards, pipeline artifacts |
| **Cold storage** | Cloudflare R2 | external | Music library, customer uploads, MP4 archive, zero egress fees |
| **CDN delivery** | Cloudflare (default) | external | Customer-facing MP4 download, signed URLs |
| **Monitoring** | Slack webhook `#cwn-alerts` | external | Alert destination, no PagerDuty until Phase 5+ |
| **Error tracking** | TBD — Sentry candidate | Vercel + Railway | Probably Phase 3, not launch blocker |

### 12.4 Phase-by-phase migration path

**Phase 1 (now):** everything on Rob's MacBook. Vanilla HTML dashboard. Node server.js. JSON file persistence. MP3s in local `assets/audio/`. No change.

**Phase 2 (first external customer):** **First touch of the new stack.**
- Spin up a Vercel project with Next.js App Router skeleton
- Stand up a Railway project with `server.js` deployed
- Railway Postgres add-on provisioned, `data/jobs.json` migrated to schema via one-time script
- Clerk auth integrated on Vercel frontend
- Customer dashboard (Next.js) calls Railway API for job state
- Operator dashboard (vanilla HTML on localhost) still functional as admin override — Rob uses both during transition
- Music library and customer uploads migrated to Cloudflare R2

**Phase 3 (automation layer):** operator dashboard retired in favor of Next.js admin panel with role-based views. Both frontend and backend fully on hosted infra.

**Phase 4 (SaaS prep):** onboarding wizard + billing integration (Stripe) on Next.js. Customer self-serve flows.

**Phase 5 (SaaS MVP):** public launch from the Next.js + Railway + R2 stack that's been soak-tested for 30 days.

### 12.5 What this does NOT change about Phase 1 work

- Current localhost smoke test loop continues unchanged
- Current dashboard (`cwn_production.html`) stays as operator UI until Phase 3
- Current `server.js` Node/Express backend is the SAME code that deploys to Railway — no rewrite
- Current JSON file persistence stays until Phase 2 migration
- Music library stays committed to git at current scale (Rob's call 2026-04-13)

**The stack decision is a destination, not an immediate action item.** Phase 1 work (smoke tests, fixes, chrome migration) all ships on localhost as it does today. Migration begins at Phase 2 start.

### 12.6 Rob's anti-patterns list

Rules captured from Rob's stack notes to prevent scope drift:

1. **Customer dashboard must be "stupid simple"** — the backend is extremely advanced, the UI should feel trivial to use
2. **Do NOT expose pipeline view to customers** — no Gate 3 deductions, no segment counts, no internal job state
3. **Do NOT expose QA gate detail to customers** — they see "processing / posted / failed," nothing else
4. **Do NOT expose technical controls to customers** — no rollback, no force-advance, no manual overrides (those are operator-only)
5. **Customer UI contains only three things:** onboarding (enter source + select platforms + click start), dashboard (videos generated + status + later performance), and billing

### 12.7 Figma → dev workflow (Rob's preferred)

When Phase 2 frontend work begins, the path is:

1. **Design in Figma** — onboarding wizard, dashboard, video card component
2. **Componentize** — extract buttons, cards, status indicators as shadcn/ui components
3. **Hand to dev (or build directly)** — Next.js + Tailwind + shadcn is the stack, no framework debates

### 12.8 Binary storage 3-tier detail (consolidated from Q-T7/T8)

- **Tier 1 — Railway persistent volume:** hot/active job state only (tmp/ renders in flight, job cards being written, current pipeline artifacts). Wiped on container redeploy is tolerable because data is short-lived.
- **Tier 2 — Cloudflare R2 (preferred) or S3:** cold storage for music library (`assets/audio/*`), customer-uploaded source material, produced MP4 archive, Gemini-uploaded QA evidence. R2 preferred over S3 because zero egress fees save money on video delivery at scale. S3-compatible API so existing Node libraries work without rewrite.
- **Tier 3 — CDN (Cloudflare default):** customer-facing MP4 download via signed URLs. Not needed until multi-customer Phase 2+.

### 12.9 What's still open

Even with the stack locked, some sub-decisions remain:

- **Clerk vs Supabase Auth** — lean Clerk unless we add Supabase for another reason
- **Sentry vs Logtail vs Railway native logs** — pick during Phase 2 when we're actually shipping errors
- **Next.js App Router vs Pages Router** — App Router is the default (newer, preferred), Pages Router only if shadcn or Clerk has integration gaps
- **Deployment branching strategy** — Vercel preview per PR, Railway staging vs prod — design during Phase 2 ops planning
- **Domain / DNS** — which domain points where, Cloudflare as registrar or not

None of these block Phase 1 work.

---

## 13. Cross-references

This doc is ONE OF SEVEN active planning docs. Agents working on CWN must read the relevant ones for their task:

| Doc | Scope | When to read |
|---|---|---|
| `CLAUDE.md` | Architecture + rules + gotchas | Every session start |
| `STATUS.md` | Current work state, last agent actions | Every session start |
| `GATED_PIPELINE_ARCHITECTURE.md` | Pipeline principles + gate semantics | Any pipeline / gate work |
| `BUSINESS_STRATEGY.md` | Positioning, GTM, pricing, competitive | Any customer-facing copy, pricing decision, or positioning question |
| `AUTONOMOUS_PRODUCTION_ROADMAP.md` (this doc) | Technical roadmap to public launch | Any work touching multi-tenant, autonomous execution, Railway migration |
| `SHARED_NEWSCAST_SET_MIGRATION.md` | Chrome template unification across content types | Any work on the newscast overlay system |
| Active `CLINE_HANDOFF_*.md` | Current smoke-test-cycle fixes | Whichever handoff is active |

Old handoff docs in `docs/archive/` are historical reference only.

---

## 14. Next action

Rob reads both `BUSINESS_STRATEGY.md` and `AUTONOMOUS_PRODUCTION_ROADMAP.md`, pushes back on anything that doesn't match his read, approves.

Then:

1. **Current cycle continues unchanged.** News smoke test #8 completes when HeyGen recovers. Test #7 handoff's 10 fixes are already shipped. Test #9 handoff gets drafted post-test-8 review.

2. **Phase 2 work does NOT start until Phase 1 exits.** All 3 content types must lock first. No premature multi-tenancy refactoring.

3. **Every smoke test gap gets tagged with which phase it unblocks** when added to the handoff queue. Gaps that only matter for public-launch autonomous mode (multi-client isolation, retry caps, scheduling accuracy) go to the Phase 2/3 backlog, not the current smoke test handoff.

4. **Cross-reference additions:** after approval, update `CLAUDE.md` session-start instructions to include both new docs in the "read these three files" list. Currently it says CLAUDE.md + STATUS.md + GATED_PIPELINE_ARCHITECTURE.md. Should become "those three" for engineering work + "those three + BUSINESS_STRATEGY.md + AUTONOMOUS_PRODUCTION_ROADMAP.md" for roadmap/strategy work.

5. **Phase 2 planning begins after Phase 1 exit**, not now. This doc is the spec; the phase-specific handoff is written when we're ready to execute.

Until Rob approves, both docs are proposals. After approval, they're the engineering + business north-stars for every CWN decision.
