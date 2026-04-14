# CWN Overnight Task Schedule

**Window:** 1:00 AM – 7:00 AM Eastern (daily)
**Agent:** Aider (gemini/gemini-2.5-pro)
**Output:** Morning briefing written to `MORNING_BRIEFING.md` after each run
**Status:** 🟢 OPEN (2026-04-11 evening) — pause lifted. See context banner below for recent activity and preference ordering.

---

## 🟢 2026-04-11 Evening — Sprint wind-down, queue fully open

**Context:** Cline completed a massive shipping day on 2026-04-11:

- `a1439b6` — Gate 2 parseSegments_v2 + validator (Phase 1 of gated pipeline)
- `8929a47` — Gemini clip analysis truncation fix (Task #14, Gate 1 100/100)
- `7016d6b` — Ticker pre-warm + clip ordering restore
- `6cd184a` — Video freeze fix (xfade cumulativeDur drift → concat demuxer)
- `1503a37` — Gate 3 false positive + CTA placement
- `919eb19` — Dashboard clear jobs server sync
- `09f9502` — Human-readable auto-assembly filenames
- `6028820` — Ticker `await` + Twitch circle→TV migration
- `0497b19` — Dashboard persistence after auto-assembly
- `33ed559` — Layout dimensions (TV 840×472, logo 80/10/100, ticker 72px, config-driven filters)
- `f4b5577` — Handoff confirmations (handoffs 1-4 marked shipped)
- **`0b613af` — TV card exact 16:9 (720×405 at 1160,100) + ticker FPS 15→30** (latest)

**Pipeline status:** 4 full smoke tests run today (Jason 2-clip), Gate 1 scoring 100/100, Gate 2/3 passing, scenes in correct order, ticker visible, logo clear of mic arm. **5th smoke test pending** to verify the exact-16:9 TV card + 30fps ticker fixes. Rob handles manual testing; Claude Code verifies frames.

**Active handoffs remaining in repo root:**
- `CLINE_HANDOFF_GATE1_CLIP_DIAGNOSTIC_UPGRADE.md` — Phase 2 of gated pipeline, not yet shipped, lower priority
- `CLINE_HANDOFF_LAYOUT_DIMENSIONS_AND_HANDOFF_CONFIRMATION.md` — shipped as `33ed559`, kept until 4th smoke test final sign-off
- `CLINE_HANDOFF_TICKER_STABILITY_TV_REPOSITION.md` — shipped as `0b613af`, will archive after 5th smoke test passes

**Aider queue: fully open.** Previous narrow pause lifted. All tasks available, including the new INDEPENDENT section below. Standard atomic-staging rules still apply per COMMIT_CHECKLIST.md — if two agents try to write to the same file concurrently, we still lose.

**Coordination hint for Aider:** tasks in the new "🟢 INDEPENDENT — Safe Any Night" section below are explicitly designed to NOT touch `server.js` or `cwn_production.html`, so they're safe even if Cline picks up another handoff mid-week. Prefer these tasks over the legacy "QUEUED" section until the 12-test suite completes a full clean run.

**If Aider hit a stale version of this file and ran a blocked task tonight:** abort, revert any uncommitted changes, note in `MORNING_BRIEFING.md`, and move to a task in the "🟢 INDEPENDENT" section.

---

**Normal Status:** APPROVED — all tasks cleared to run during overnight window

---

## How the Overnight System Works

1. `launchd` triggers `scripts/overnight_runner.sh` at 1:00 AM daily (macOS scheduler)
2. The runner script starts Aider non-interactively with `--message` — no terminal needed
3. Aider reads this file, picks the first `[ ]` task, works on it, commits, and pushes
4. After completing, Aider updates `MORNING_BRIEFING.md` with what changed
5. When Rob/Claude/Cline start their day, they read `MORNING_BRIEFING.md` first

**Morning startup command:**
```bash
# Read this first every morning before touching anything
cat MORNING_BRIEFING.md
```

## Automation Setup (One-Time Install)

```bash
# Install the launchd scheduler (runs overnight_runner.sh at 1am daily)
cp scripts/com.cwn.overnight.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.cwn.overnight.plist

# Verify it's loaded
launchctl list | grep cwn
```

**To check if it ran:** `cat logs/overnight_$(date +%Y-%m-%d).log`
**To run manually right now:** `bash scripts/overnight_runner.sh`
**To stop/uninstall:** `launchctl unload ~/Library/LaunchAgents/com.cwn.overnight.plist`

**Important:** Your Mac must be awake at 1am for launchd to fire. If it's asleep, the job runs the next time the Mac wakes up after 1am. Keep the Mac plugged in and awake overnight (or use `pmset` to schedule a wake).

---

## Aider Task Queue

Tasks are listed in priority order. Aider works through them top-to-bottom each night.
Mark `[x]` when complete. Add new tasks at the bottom with a date.

### 🟢 APPROVED — Ready to Run (1am-7am ET)

> **⭐ TONIGHT'S PRIORITY (2026-04-14) — Atlassian rebuild first.**
> Before picking up any other `[ ]` task tonight, scroll down to **"Rebuild Atlassian integration from scratch"** (around line 340). That task builds `lib/clients/jira_client.js`, `lib/clients/confluence_client.js`, and `scripts/jira_ping.js` — it unblocks the Jira morning report and the eventual `jira_sync.js`. Rob is moving toward Jira (epics/stories/tasks/subtasks) + Confluence as the canonical home for work tracking and reference docs, which means the current `CLINE_HANDOFF_*.md` / `STATUS.md` / `ROADMAP.md` ecosystem is transitional — it goes away once Atlassian is live. Getting the pipe open tonight is the first step. Task is fully specced, all new files, zero risk to `server.js` or the dashboard. If Rob's `.env` isn't filled in yet, ship the code anyway — the ping script's "ATLASSIAN_API_TOKEN not set" error is the expected failure mode and Rob handles auth separately.
>
> After the Atlassian task ships, fall back to normal top-to-bottom queue order (server.js module split next, then the QUEUED section).

#### [~] server.js Module Split — IN PROGRESS
**Priority:** High — reduces context limit issues for all agents
**Estimate:** 2-3 modules per night × 5 nights
**Why overnight:** Safe to do when no one is actively using the server
**Phase 1 DONE (Cline, 2026-04-09):** lib/config.js, lib/logger.js, lib/metrics.js extracted ✅
**Next:** lib/streamers.js (item 4 in SERVER_SPLIT_PLAN.md)
**What Aider does each night:**
- Extract 2-3 modules per the order in SERVER_SPLIT_PLAN.md (start at item 4)
- Run `node --check server.js` after each extraction
- Update SERVER_MAP.md with new function locations
- Commit each module separately with clear message
- Write summary to MORNING_BRIEFING.md

### 🟡 QUEUED — Ready When Module Split Reduces Context

These tasks were identified by Aider but couldn't be completed due to the server.js context limit error. Once the module split reduces server.js size, these become executable.

#### [x] Fix News Thumbnail Generation 500 Error
**File:** `server.js` (thumbnail generation endpoint)
**What:** Debug and fix 500 error in `/generate-thumbnail` for `contentType: 'news'`
**Evidence:** QA session shows `POST /generate-thumbnail` (news) returns 500 status
**Likely causes:** Missing image processing, invalid Canvas operations, or missing dependencies
**Risk:** Low — isolated to news thumbnail logic, doesn't affect other content types
**Estimate:** 1 hour
**Safe for Aider:** ✅ Thumbnail generation is separate from dashboard JS and assembly flow

#### [x] Fix NBA Thumbnail Generation 500 Error  
**File:** `server.js` (thumbnail generation endpoint)
**What:** Debug and fix 500 error in `/generate-thumbnail` for `contentType: 'nba'`
**Evidence:** QA session shows `POST /generate-thumbnail` (nba) returns 500 status
**Likely causes:** Missing NBA background image, team color processing, or Canvas issues
**Risk:** Low — isolated to NBA thumbnail logic
**Estimate:** 1 hour
**Safe for Aider:** ✅ Thumbnail generation is separate from dashboard JS and assembly flow

#### [ ] Investigate QA Session Console Errors
**File:** `output/qa_sessions/errors_*.json` + related server code
**What:** Review and fix 3 console errors detected during automated QA session
**Evidence:** QA recorder detected 3 console errors during endpoint testing
**Action:** Read error log, identify root causes, fix underlying issues
**Risk:** Low — diagnostic task, fixes likely small
**Estimate:** 30 min
**Safe for Aider:** ✅ Error investigation doesn't touch dashboard JS

#### [x] Input Validation & Sanitization (Security)
**File:** `server.js` → after split: `lib/routes/*.js`
**What:** Add `express-validator` checks to all POST endpoints
**Specific endpoints needing validation:**
- `/assemble` — validate `asmId`, `segments[]`, `contentType`, `formType`
- `/generate-full-script` — validate `type`, `items[]`, `formType`
- `/publish` — validate `driveUrl`, `platforms[]`, `title`
- `/generate-thumbnail` — validate `contentType`, `streamers[]`
**Risk:** Low — additive only, doesn't change existing logic
**Estimate:** 2 hours

#### [ ] Rate Limiting per Endpoint
**File:** `server.js` → after split: `lib/routes/*.js`
**What:** Add `express-rate-limit` middleware
**Limits:**
- `/generate-full-script`: 10 req/min (Gemini cost protection)
- `/assemble`: 5 req/min (FFmpeg resource protection)
- `/publish`: 20 req/min (Upload-Post API protection)
- `/generate-thumbnail`: 30 req/min
- All others: 60 req/min default
**Risk:** Low — additive middleware
**Estimate:** 1 hour

#### [ ] Structured Logging Enhancement
**File:** `lib/error_logger.js`
**What:** Add log levels (DEBUG/INFO/WARN/ERROR), request IDs, and duration tracking
**Current state:** Basic JSON logging exists, needs levels + correlation IDs
**Risk:** Low — lib/error_logger.js is small and isolated
**Estimate:** 1 hour

#### [ ] Remove Duplicate `/generate-thumbnail` Route
**File:** `server.js` lines 9242 and 9575 — TWO routes with same path
**What:** The second definition (line 9575) silently overrides the first (line 9242)
**Fix:** Audit both, keep the correct one, remove the duplicate
**Risk:** Medium — need to verify which one is actually being used
**Estimate:** 30 min

#### [ ] Fix Legacy Publish Stub Routes
**File:** `server.js` lines 7539–7705
**What:** `/publish/youtube`, `/publish/tiktok`, `/publish/instagram` are stubs that just call `/publish`
**Fix:** Either remove them (if dashboard doesn't use them) or document they're intentional
**Risk:** Low — stubs only, no logic
**Estimate:** 30 min

#### [x] Add `.env.example` File
**File:** New `.env.example`
**What:** Document all required env vars with placeholder values (no real keys)
**Why:** New agents/sessions don't know what's needed without reading CLAUDE.md
**Risk:** None — new file only
**Estimate:** 20 min

#### [ ] Phonetic Auto-Injection from streamers.json
**File:** `server.js` (HeyGen send function)
**What:** Read `phonetic` field from `streamers.json` at script gen time, auto-inject into HeyGen `input_text`
**Why:** Currently manual — Bobby G mispronounces names that have phonetic entries
**Risk:** Medium — touches HeyGen send logic
**Estimate:** 1 hour
**Blocked by:** Scene count fix must be validated first ✅ (done)

---

### 🟢 INDEPENDENT — Safe Any Night (no server.js edits required)

Added 2026-04-11 evening after Rob asked what else Aider could do beyond the nightly module split. These tasks are explicitly designed to NOT touch `server.js` or `cwn_production.html`, so they're safe regardless of whether Cline is mid-handoff on those files. Prefer these over the legacy `🟡 QUEUED` section until the 12-test suite completes a full clean run.

Each task is self-contained — Aider picks one per night, ships it, moves on. Do not bundle multiple unless they're explicitly related.

---

#### [ ] Jira morning report script (`scripts/jira_morning_report.js`)
**Files:** NEW `scripts/jira_morning_report.js`, NEW output `MORNING_JIRA_REPORT.md`
**What:** Node script that reads `JIRA_PROJECT_KEY` (=`CPD`) from `.env`, hits `/rest/api/3/search` via the `lib/clients/jira_client.js` built by the previous task, pulls issues in the active sprint / board, formats them into a markdown summary, and writes the result to `MORNING_JIRA_REPORT.md` at the repo root. Designed to run nightly alongside Aider's existing overnight work so Rob has a fresh Jira snapshot every morning next to `MORNING_BRIEFING.md`.
**Why:** Rob wanted a "Rovo morning report" but Rovo has no public API and can't self-schedule. A deterministic Node-based report delivers the same capability (Jira state summarized to markdown) without waiting on Atlassian's Rovo rollout. If/when Rovo gets a real API, we can swap the script for an agent call — interface stays identical (markdown file in the repo root).
**How:**
1. Require `lib/clients/jira_client.js` (built by the previous task — this task is DEPENDENT on it shipping first)
2. Load `.env` via `dotenv`, read `ATLASSIAN_DOMAIN`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`, `JIRA_PROJECT_KEY`
3. Instantiate the Jira client, run 3 JQL queries:
   - `project = CPD AND sprint in openSprints()` — active sprint content
   - `project = CPD AND status = "In Progress"` — currently-worked items
   - `project = CPD AND created >= -1d` — new issues in last 24h
4. For each query, extract `key`, `summary`, `status`, `assignee.displayName`, `priority.name`, `updated`
5. Format output as:
   ```markdown
   # Jira Morning Report — YYYY-MM-DD

   **Project:** CPD | **Generated:** ISO-8601 timestamp

   ## 🏃 Active Sprint (N issues)
   - **CPD-123** [In Progress] summary — @assignee (Priority: High, updated 2h ago)
   - ...

   ## 🔧 Currently In Progress (N issues)
   - ...

   ## 🆕 New Since Yesterday (N issues)
   - ...
   ```
6. Write to `MORNING_JIRA_REPORT.md` at repo root (same folder as `MORNING_BRIEFING.md`). Overwrite each run.
7. Exit 0 on success. Exit 1 with a clear error in stderr on failure (e.g., "Jira auth failed — check ATLASSIAN_API_TOKEN in .env")
8. Add `"jira-report": "node scripts/jira_morning_report.js"` to `package.json` scripts
9. Hook into `scripts/overnight_runner.sh` — after Aider's nightly task completes, add a line that runs `npm run jira-report` so the file regenerates every morning
10. Add `MORNING_JIRA_REPORT.md` to `.gitignore` — it's runtime output, not source
**Test:** After shipping, Rob runs `npm run jira-report` manually. If the file is created with real Jira data, task is done. If auth fails, Rob fills in `.env` and retries.
**Risk:** Low — new script only, depends on the Jira client module from the prior task
**Estimate:** 1.5 hours
**Dependencies:** **BLOCKED until the "Rebuild Atlassian integration from scratch" task above ships.** If that task isn't complete yet, skip this task and run a different INDEPENDENT task instead.
**Safe for Aider:** ✅ New file + 1-line overnight runner edit + 1-line package.json edit + 1-line .gitignore edit

---

#### [ ] Write unit tests for `parseSegments_v2` + Gate 2 validator
**Files:** NEW `test/parseSegmentsV2.test.js` and `test/gate2_validator.test.js`
**What:** Take the 10 test cases documented in `test/GATE2_TEST_CASES.md` and turn them into executable Jest or node:test test cases. Each test asserts segment count, labels, clip order against a hand-crafted script input. Second file tests the `gate2_validateSegmentStructure` 6-check logic with good/bad inputs.
**Why:** Gate 2 is the foundation of the gated pipeline (Phase 1). Having automated tests that prove parseSegments_v2 produces exactly 9 segments for a 2-clip Jason script prevents regressions when future changes land.
**How:**
1. Read `test/GATE2_TEST_CASES.md` for the test case descriptions
2. Read `cwn_production.html` to understand how `parseSegments_v2` and `gate2_validateSegmentStructure` are exposed
3. Extract the functions into a testable form (either duplicate the logic in the test file, or refactor them into `lib/parseSegments.js` — caution: refactor path touches cwn_production.html, stay in test-file-only mode)
4. Write the test file with `node:test` (built-in, no new dependency)
5. Add `npm test` script to `package.json`
6. Commit the test files + package.json update
**Risk:** Low — new files only, doesn't touch existing code
**Estimate:** 2 hours
**Dependencies:** none
**Safe for Aider:** ✅ Pure new-file creation

---

#### [ ] Write `/health` endpoint as `lib/routes/health.js`
**File:** NEW `lib/routes/health.js`
**What:** A tiny Express route module exporting a `/health` endpoint that returns 200 OK plus a JSON summary: `{status: "ok", uptime, version, node_version, memory_usage_mb, active_jobs_count, last_commit_hash}`. Read `active_jobs_count` from `data/jobs.json` without importing server.js. Version from `package.json`. Last commit from `git rev-parse HEAD` via `child_process.execSync`.
**Why:** Railway (and any load balancer) needs a `/health` endpoint to know if the instance is alive. Currently there's no lightweight health check — load balancers would fall back to TCP checks or hit a heavy endpoint.
**How:**
1. Create `lib/routes/health.js` with a single `module.exports = function(app) { app.get('/health', handler); }` pattern
2. Handler returns the JSON above with <10ms latency (no FFmpeg, no external API calls)
3. Requires registration in `server.js` via `require('./lib/routes/health')(app);` — **this IS a server.js edit so coordinate with Cline timing**. Alternatively, make the route module self-registering via a `register(app)` export and leave the server.js wire-up as a separate follow-up task for Cline.
4. Test: `curl http://localhost:3000/health` returns 200 + JSON
**Risk:** Low — new file + 1-line server.js edit
**Estimate:** 45 min
**Dependencies:** none
**Safe for Aider:** ✅ New file; server.js 1-line edit can be skipped if concurrent Cline work is active — leave a note in MORNING_BRIEFING.md asking Cline to wire it up

---

#### [ ] Write `/metrics` endpoint as `lib/routes/metrics.js`
**File:** NEW `lib/routes/metrics.js`
**What:** Prometheus-format metrics endpoint returning counters and gauges for: total_jobs_processed, jobs_per_gate_pass, jobs_per_gate_fail, ffmpeg_assembly_seconds_histogram, gemini_api_calls_total, heygen_segment_count_total, current_active_jobs. Read from `data/jobs.json` + parse `logs/gate_fixes.jsonl`.
**Why:** Enables Grafana dashboard integration when we deploy to Railway. Prometheus scraping is the standard pattern for SaaS monitoring. Getting this early means the production deploy already has observability hooks in place.
**How:**
1. Create `lib/routes/metrics.js` with a metrics collector that reads from `persistedJobs` and `logs/gate_fixes.jsonl`
2. Format output as Prometheus exposition format (plain text, specific syntax: `# HELP`, `# TYPE`, `metric_name{label="value"} value`)
3. Register via `require('./lib/routes/metrics')(app);` in server.js (same coordination caveat as /health)
4. Test: `curl http://localhost:3000/metrics` returns text/plain with metrics
**Risk:** Low — new file + 1-line server.js edit
**Estimate:** 2 hours
**Dependencies:** requires `/health` route module pattern established first
**Safe for Aider:** ✅ New file primarily

---

#### [ ] Clean up old files in `output/qa_failures/`
**File:** NEW `scripts/rotate_qa_failures.sh`
**What:** Write a bash script that keeps the N=50 most recent files per gate kind (`gate1_*.txt`, `gate2_*.txt`, etc.) and compresses older files into `output/qa_failures/archive_YYYY-MM-DD.tar.gz`. Delete the original `.txt` files after successful compression. Delete the tar.gz archives older than 90 days.
**Why:** `output/qa_failures/` currently has 343 files and growing. At production scale with 100 jobs/day × 6 gates = 600 files/day = 18,000/month. Without rotation, the directory becomes unreadable and disk space blows up.
**How:**
1. Create `scripts/rotate_qa_failures.sh` with the rotation logic
2. Add a cron entry (via `scripts/com.cwn.overnight.plist` or a new plist) to run nightly at 2am ET
3. Test manually: `bash scripts/rotate_qa_failures.sh` — verify it preserves the 50 newest per kind and archives the rest
4. Commit the script + plist update
**Risk:** Low — only touches `output/qa_failures/` which is not in git
**Estimate:** 45 min
**Dependencies:** none
**Safe for Aider:** ✅ Pure script, no code edits

---

#### [ ] Backup `data/*.json` to Google Drive nightly
**File:** NEW `scripts/backup_data_to_drive.js`
**What:** Node script that reads `data/jobs.json`, `data/streamers.json`, `data/cwn_style_guides.json`, `data/episode_counters.json`, `data/upload_status.json`, tar.gz them, and uploads to a `cwn-backups` folder in the existing Google Drive account (reuse `DRIVE_REFRESH_TOKEN` from `.env`). Retains 30 days of backups in Drive.
**Why:** `data/` files are runtime state, not in git. Losing them loses job history, episode counters, streamer config. Nightly backup is cheap insurance.
**How:**
1. Create `scripts/backup_data_to_drive.js` using existing Google Drive auth code from `cwn-auth.js`
2. Bundle logic: `tar -czf /tmp/cwn-backup-YYYY-MM-DD.tar.gz data/*.json`
3. Upload via Google Drive API
4. Clean old backups (list existing, delete any older than 30 days)
5. Cron entry in `scripts/com.cwn.overnight.plist` at 3am ET
**Risk:** Low — new file, uses existing auth
**Estimate:** 1.5 hours
**Dependencies:** none
**Safe for Aider:** ✅ New script, no server.js edits

---

#### [ ] Audit `logs/errors.jsonl` and write known-errors catalog
**File:** NEW `docs/KNOWN_ERRORS_CATALOG.md`
**What:** Parse `logs/errors.jsonl`, group errors by pattern (same error message, same stack trace), count frequency per pattern. Write a markdown catalog documenting each known error with: pattern signature, frequency, root cause (if known), fix strategy (if known), example occurrences.
**Why:** When a new error surfaces in production, the first question is "have we seen this before?" A searchable catalog cuts diagnosis time from hours to minutes. Also serves as input data for the Gate 1 diagnostic upgrade (Phase 2) which needs to distinguish specific failure modes.
**How:**
1. Read all lines from `logs/errors.jsonl` (currently 2.1KB, small)
2. Group by normalized message (strip file paths, line numbers, timestamps)
3. For each group, write a markdown section with the pattern + examples
4. Start with the 3 existing known errors (JSON parse, ENOENT tools HTML files, etc.)
5. Commit the catalog doc
**Risk:** Low — read-only analysis, new doc only
**Estimate:** 1 hour
**Dependencies:** none
**Safe for Aider:** ✅ Pure docs

---

#### [ ] ⭐ TONIGHT'S PRIORITY — Rebuild Atlassian integration from scratch (replaces deleted 7eb780f scaffolding)
**Priority bumped 2026-04-14:** Rob is transitioning work tracking from `CLINE_HANDOFF_*.md` / `STATUS.md` / `ROADMAP.md` to Jira (epics/stories/tasks/subtasks) + Confluence (reference docs). This task proves the Atlassian pipe is open so follow-up tasks (Jira morning report, jira_sync.js, Confluence page sync) can unblock. **Run this FIRST tonight before any other `[ ]` task.** See priority banner at the top of the APPROVED section for full context.

**Files:** NEW `lib/clients/jira_client.js`, NEW `lib/clients/confluence_client.js`, NEW `scripts/jira_ping.js`
**What:** Rob deleted the 2026-04-12 Atlassian scaffolding (`scripts/atlassian_setup.js`, `scripts/jira_sync.js`, `scripts/confluence_sync.js`, `docs/JIRA_CONFLUENCE_MIGRATION_PLAN.md`) on 2026-04-13 because it was half-built — the scripts imported `lib/clients/jira_client` and `lib/clients/confluence_client` which were never written. Rebuild the CLIENT layer only, no sync logic yet. Goal: prove the pipe is open and reachable from localhost.
**Atlassian details (confirmed by Rob):**
- Domain: `robertsworkspace-18914505.atlassian.net`
- Jira project key: `CPD` (NOT `CWN` — the old scaffolding guessed wrong)
- Confluence space key: `CP`
- Auth: API token from https://id.atlassian.com/manage-profile/security/api-tokens + Rob's Atlassian email, both via `.env` (`ATLASSIAN_DOMAIN`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`, `JIRA_PROJECT_KEY=CPD`, `CONFLUENCE_SPACE_KEY=CP`)
**How:**
1. Create `lib/clients/jira_client.js` — ~100 lines, axios-based. Exports a class with constructor `{domain, email, apiToken, projectKey}`, Basic auth header (`Buffer.from(email+':'+apiToken).toString('base64')`), and methods: `healthCheck()` (hits `/rest/api/3/myself`, returns `{status, accountId, email, displayName}`), `getProject()` (hits `/rest/api/3/project/{projectKey}`), `listIssues(jql, maxResults)` (hits `/rest/api/3/search` with JQL). No write methods yet — read-only proof of pipe.
2. Create `lib/clients/confluence_client.js` — same shape, constructor `{domain, email, apiToken, spaceKey}`, methods: `healthCheck()` (hits `/wiki/rest/api/user/current`), `getSpace()` (hits `/wiki/rest/api/space/{spaceKey}`), `listPages(limit)` (hits `/wiki/rest/api/space/{spaceKey}/content/page`). Read-only.
3. Create `scripts/jira_ping.js` — a ~40-line CLI script that loads `.env` via dotenv, instantiates both clients, calls `healthCheck()` + `getProject()` + `getSpace()`, and prints results. Exit 0 on success, exit 1 with a clear error message on failure. This is the smoke test that proves Rob's credentials work.
4. Add `.env.example` entries for the 5 new variables (leave the actual values for Rob to fill in manually — NEVER commit a real token).
5. **DO NOT** write `scripts/jira_sync.js`, `scripts/confluence_sync.js`, or any sync/write logic in this task. That's a follow-up task once the pipe is proven open.
6. **DO NOT** add `npm run` script entries in `package.json` for anything beyond maybe `"jira-ping": "node scripts/jira_ping.js"`.
7. **DO NOT** recreate the deleted migration plan doc — Rob is rewriting that with Claude Code.
**Test:** Rob runs `node scripts/jira_ping.js` the next morning. If it prints his account + project `CPD` + space `CP`, task is done. If it errors, leave a clear message in `MORNING_BRIEFING.md` under Issues.
**Risk:** Low — all new files, no server.js or dashboard edits. Only package.json touch is optional (one script entry).
**Estimate:** 1.5 hours
**Dependencies:** Rob must fill in `.env` with real credentials before the test runs (otherwise ping script errors with `ATLASSIAN_API_TOKEN not set`, which is the expected failure mode — Aider still ships the code, Rob does the auth separately)
**Safe for Aider:** ✅ Pure new-file creation, read-only API client layer

---

#### [ ] Write `scripts/jira_sync.js` (once Rob has Jira set up)
**File:** NEW `scripts/jira_sync.js`
**What:** Deterministic sync script that reads `STATUS.md` Last Agent Action table + `logs/gate_fixes.jsonl` + commit log, creates or updates Jira tickets via the Atlassian REST API. Handles: STATUS.md row → Jira ticket creation, stale ticket detection (no git activity >7d), label enforcement from file path patterns.
**Why:** Atlassian's native GitHub integration handles commit↔issue linking automatically. This script handles the custom sync needs (STATUS.md → Jira, stale detection) that the native integration doesn't cover. See `JIRA_CONFLUENCE_MIGRATION_PLAN.md` when it exists for full spec.
**How:**
1. **BLOCKED until Rob sets up Jira and `JIRA_CONFLUENCE_MIGRATION_PLAN.md` is written**
2. Read the migration plan for project key, ticket ID format, label taxonomy
3. Use `fetch` or `axios` to call Atlassian REST API with credentials from `.env` (new keys: `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`)
4. Cron entry in `scripts/com.cwn.overnight.plist` at 4am ET (after backup, before next day's work)
5. Log results to `MORNING_BRIEFING.md`
**Risk:** Medium — hits a live SaaS API with write access
**Estimate:** 3 hours
**Dependencies:** BLOCKED on Jira setup + migration plan
**Safe for Aider:** ✅ New script once unblocked

---

#### [ ] Extract `cleanAvatarText` helper into `lib/text_cleanup.js`
**File:** NEW `lib/text_cleanup.js`
**What:** Extract the `cleanAvatarText` function (currently defined inline in `cwn_production.html` parseSegments) into a shared library module so both client and server can use it. Note: this requires a companion change in `cwn_production.html` to import from the module — coordinate with Cline timing.
**Why:** `cleanAvatarText` is used in both `parseSegments_v2` (client) and potentially server-side Gate 2 validation. Duplicating the logic means inconsistencies. Extracting to a shared module is good hygiene.
**How:**
1. Identify the function in `cwn_production.html` (search for `function cleanAvatarText`)
2. Create `lib/text_cleanup.js` with the same function exported
3. **Leave the client-side copy in place** (don't edit `cwn_production.html`) — let Cline wire it up in a separate task
4. Write a unit test for `cleanAvatarText` in `test/text_cleanup.test.js`
**Risk:** Low — new file + test only; no production wire-up
**Estimate:** 1 hour
**Dependencies:** none (intentionally stops short of the client-side rewire)
**Safe for Aider:** ✅ New files only

---

#### [ ] Write `scripts/lint_markdown_links.js` (catch broken cross-references)
**File:** NEW `scripts/lint_markdown_links.js`
**What:** Node script that walks every `.md` file in the repo, extracts all markdown links (`[text](path)` and `[text](#anchor)`), and verifies each link target exists. Reports broken links to stdout, exits 1 if any are broken.
**Why:** The doc corpus has grown to 15+ handoff files plus CLAUDE.md, STATUS.md, architecture docs, etc. Cross-references go stale as files move (e.g., the handoffs that got archived to `docs/archive/` — any doc referencing them by old path is now broken).
**How:**
1. Walk `*.md` files (exclude `node_modules`, `docs/archive/`)
2. Regex extract `\]\(([^)]+)\)` — match markdown link targets
3. For each target: if relative path, check file exists; if anchor, check the anchor exists in target file; if URL, skip
4. Report broken links with file:line context
5. Add to pre-commit hook as optional check (not blocking initially)
**Risk:** Low — read-only analysis
**Estimate:** 1.5 hours
**Dependencies:** none
**Safe for Aider:** ✅ New script only

---

#### [ ] Prompt engineering: review and refine `cwn_style_guides.json`
**File:** `data/cwn_style_guides.json`
**What:** Review the current style guide for each content type (twitch/nba/news) and refine based on observed script quality. Add specific examples of good/bad Bobby G lines. Add per-streamer nuances (e.g., Yonna = YAWN-uh phonetic).
**Why:** `cwn_style_guides.json` drives Gemini's script generation. As production data accumulates, patterns emerge — some lines consistently land, some don't. Refining the guide improves every future script.
**How:**
1. Read the current `cwn_style_guides.json`
2. Read recent Gate 1 passing reports in `output/qa_failures/gate1_script_pass_*.txt` to see what Gemini is producing
3. Read `STREAMER_DISPLAY_NAMES` in `server.js` + `data/streamers.json` for phonetic entries
4. Propose refinements as a diff: specific "do this" / "don't do this" examples
5. Commit the updated JSON
**Risk:** Low — data file only, no code
**Estimate:** 2 hours
**Dependencies:** none
**Safe for Aider:** ✅ Pure text/data editing

---

### Scheduling notes for INDEPENDENT tasks

- Pick one task per night, not multiple
- Order preference: test coverage → observability → backup → housekeeping → refactors → prompt engineering
- If a task in the 🟡 QUEUED section has unblocked (e.g., Cline committed the pending work and it's safe), prefer the queued task over an INDEPENDENT task
- When a task completes, mark `[x]` and add a line to the COMPLETED section below
- If ALL INDEPENDENT tasks are done and the QUEUED section is still blocked, write a new useful task instead of idling — Aider should never skip a night

### Future INDEPENDENT tasks to add later

- Database migration scripts (when we move from JSON files → SQLite/Postgres for multi-tenant)
- TypeScript type definitions for the Gate Output Contract
- Structured logging refactor (`lib/error_logger.js` improvements)
- Pre-commit hook improvements (auto-run markdown link linter, file size check, secrets scan)
- Dependency vulnerability audit (`npm audit` + automated patch PRs)

### 🔒 BLOCKED UNTIL 12-TEST SUITE COMPLETES

These tasks are scoped and ready, but must NOT ship until Rob signals the 12-test phase is done. They either touch `server.js` / `cwn_production.html` in ways that would collide with in-flight Cline work, or represent polish that should happen after the pipeline is proven stable.

**Task POST-12-A — Dashboard metrics panel (unified per-run report)**

- **What:** Build `/metrics/:jobId` endpoint in `lib/routes/metrics.js` that stitches the three separate `run_metrics_*.json` files (`script_twitch_*`, `asm_*`, `publish_*`) into one unified JSON response keyed by the top-level jobId. Then add a "📊 RUN METRICS" collapsible panel to each job card in `cwn_production.html` showing per-stage wall time + totals inline: Script Gen → Gate 1 → HeyGen → Gate 2 → Assembly → Gate 3 → Drive → Gate 6 Publish, with MM:SS format for each stage and a grand total at the bottom.
- **Why:** Rob has been running tests for days and never sees timing data because metrics write to disk only — no UI surface. Three separate files per run instead of one unified report.
- **Files:** `lib/routes/metrics.js` (new), `server.js` (route registration), `cwn_production.html` (UI panel)
- **Dependencies:** Post-12-test signal from Rob; coordinate with any in-flight `server.js` handoffs
- **Rob's decision:** 2026-04-11 — deferred to post-12-test polish (he chose "Option B" over a quick nodemon-log fallback)
- **Scope reminder:** Read-only endpoint. Do NOT modify `finalizeJobMetrics` or the existing `StageTimer` class in `lib/metrics.js` — the data already exists, this task is strictly about surfacing it.

---

### ✅ COMPLETED OVERNIGHT TASKS

_(None yet — system not yet active)_

---

## Aider Session Instructions

When Aider runs overnight, it should:

1. **Read these files first** (already in `.aider.conf.yml` read list):
   - `CLAUDE.md`
   - `STATUS.md`
   - `COMMIT_CHECKLIST.md`
   - `QA_GATES.md`

2. **Pick the top non-blocked task** from the QUEUED section above

3. **Work on ONE task only** — don't try to do multiple in one session

4. **⚠️ Context Limit Rules (CRITICAL — read before adding any files)**

   Sonnet's context limit is 200k tokens. `server.js` alone is ~150k tokens.
   Violating these rules causes `input length + max_tokens > 200000` errors.

   **For tasks that DON'T touch server.js** (new files, small lib files):
   - Add only the specific file(s) needed
   - Do NOT add server.js to the chat
   - Example: `.env.example`, `lib/error_logger.js`

   **For tasks that DO touch server.js:**
   - Start aider with: `aider server.js` (map-tokens 0 is set globally in .aider.conf.yml)
   - Gemini 2.5 Pro has a 1M token context window — server.js fits comfortably
   - Do NOT add any other large files to the chat
   - If you still hit the limit, use `/drop` to remove read-only files

   **If you hit a context error mid-session:**
   - Run `/drop` to remove all files
   - Re-add only the single file you need
   - If still too large, note it in `MORNING_BRIEFING.md` and skip to next task

5. **After completing:**
   - Run `node --check server.js` (or the affected file)
   - Commit with a clear message
   - Update `STATUS.md` → `🤖 Last Agent Action` table (required by pre-commit hook)
   - Update `MORNING_BRIEFING.md` (see template below)
   - Mark task `[x]` in this file

6. **If anything goes wrong:**
   - Do NOT commit broken code
   - Write the error to `MORNING_BRIEFING.md` under "⚠️ Issues"
   - Leave the code unchanged

---

## Morning Briefing Template

Aider writes this file after each overnight run. See `MORNING_BRIEFING.md`.

```markdown
# Morning Briefing — [DATE]

**Overnight Run:** [START TIME] – [END TIME] ET
**Tasks Attempted:** [N]
**Tasks Completed:** [N]
**Commits Made:** [N]

## ✅ What Was Done

### [Task Name]
- What changed: [plain English description]
- Files modified: [list]
- Commit: [hash] — [message]
- Test result: [node --check passed / server started / etc]

## ⚠️ Issues (if any)

### [Issue description]
- What happened: [description]
- Files affected: [list]
- Status: [reverted / left as-is / needs manual review]

## 🔍 Things to Verify Today

- [ ] [Specific thing to check]
- [ ] [Specific thing to check]

## 📋 Next Overnight Queue

Next tasks scheduled:
1. [Task name]
2. [Task name]
```

---

## Scheduling Notes

- **Do not run overnight tasks** if a production job is in progress (check `output/` for recent MP4s)
- **Do not run server.js split** until all agents have been notified and paused feature work
- **Aider should exit cleanly** by 6:45 AM ET to leave buffer before workday starts
- **If Aider hits context limit** — skip that task, note it in MORNING_BRIEFING.md, move to next task
