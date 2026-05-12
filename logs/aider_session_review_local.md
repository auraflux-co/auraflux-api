# Aider Session Review — CWN-C0 Local Stack

### 1. Session Summary

This session integrated a significant number of features and fixes primarily for the C1+ production pipeline, including the full 18-test E2E suite, WAN/RunPod video generation, and operational scripts for Render environment backups and pre-deployment guards. Key changes also include fixes for the WAN generation pipeline, RunPod pod management, and a new server-side trigger for Gate 5. Despite the focus on C1+, many core `lib/` modules shared with the C0 stack were modified.

### 2. Server Health

- **PM2 Status:** The main `auraflux` process is online but has a high restart count (62). The `roo-watcher` (33 restarts) and `job-monitor` (38 restarts) processes are in a persistent crash loop (`waiting restart`), which is a critical issue.
- **Recent Errors:** Logs show multiple `MONITORING_RECEIVED_ESCALATION` and `JOB_KILLED_CLEANLY` events for jobs failing at Gate 3a and 3b. A job was automatically killed after being silent at Gate 3a for 10 minutes. A Gate 5 validation failure was also logged due to a missing video title.

### 3. Pipeline Health

- **Stuck Jobs:** No jobs are currently marked as stuck.
- **Gate Failures:** The server errors point to systemic failures in Gate 3 (Assembly QA) and Gate 5 (Publish). These failures are severe enough to trigger monitoring escalations and automatic job termination.

### 4. Jira Consistency

- **Status:** The data fetch failed, so the current state of the Jira board is unknown.

### 5. GitHub + Confluence Consistency

- **Open PRs:** There are 6 open pull requests. 5 are from Dependabot. One is a stale feature branch (`fix/cpd-126...`).
- **CI Failures:** There are 5 CI failures on recent feature branches. Merging PRs should be blocked until CI passes.
- **Confluence:** The data fetch failed, so it is unknown if documentation is up-to-date for recently changed features.

### 6. Route Integrity

- The provided list of dashboard fetch calls is incomplete. A full review of `cwn_production.html` would be needed for a complete audit.
- There are many more backend routes registered in `server.js` than are listed as being called by the dashboard. For example, `GET /publish/upload-status/:trackingId` does not appear to be used.

### 7. Codebase Structural Integrity

- **Missing Tests:** A very large number of modules in `lib/` lack corresponding test files. This is a major gap in code quality and creates high risk for regressions.
- **Missing Env Vars:** Over 30 environment variables are used in the code but are not documented in `.env.example`. This hinders local development setup and CI.
- **Dead Code:** `geminiQACheck` and `geminiSegmentQA` in `server.js` appear to be dead code and should be removed. The recent large-scale refactoring may have orphaned other code.

### 8. C0 / C1+ Boundary

- The codebase significantly mixes C0 (local-only) and C1+ (Render) concerns. Recent work is almost exclusively for C1+.
- C1+ modules contain C0-specific fallbacks, such as the hardcoded `customerId: 'c0'` in `lib/routes/developer_api.js`, violating architectural separation.

### 9. Recommendations

- **[BLOCKING]** Investigate and fix the crash loops for the `roo-watcher` and `job-monitor` PM2 processes.
- **[BLOCKING]** Address all CI failures on GitHub. Branches should not be merged with failing CI checks.
- **[SHOULD FIX]** Investigate the root cause of the Gate 3 and Gate 5 pipeline failures.
- **[SHOULD FIX]** Update `.env.example` with all missing environment variables to improve developer onboarding.
- **[SHOULD FIX]** Prioritize adding test files for critical, untested modules like `lib/assembly_service.js`, `lib/job_spec.js`, and `lib/monitoring.js`.
- **[NICE TO HAVE]** Review and merge or close the open Dependabot PRs and stale feature branch.
- **[NICE TO HAVE]** Fix the data fetching for Jira and Confluence to provide complete context for these reviews.
- **[NICE TO HAVE]** Refactor C1+ modules to remove C0-specific hardcoding.

<!-- last-reviewed-commit: f8b3ab9649f98ec892c44f935a4f32c506ecb612 -->
<!-- reviewed-at: 2026-05-11T05:07:49Z -->
