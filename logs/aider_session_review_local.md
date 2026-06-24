# Aider Session Review — CWN-C0 Local Stack

### 1. Session Summary

This session integrated major features and fixes for the C0 stack, focusing on the live grid (CPD-1005) and the clip compilation workflow (CPD-1049). Key changes include live grid brand overlays, a local rehearsal mode, and stream health monitoring, alongside significant improvements to the clip compilation SEO, reassembly UX, and short-form thumbnail generation. The session also integrated a creator registry (CPD-1027) and a channel stats dashboard (CPD-1026).

### 2. Server Health

- **PM2 Status:** High restart counts for `auraflux` (218) and `broadcast-sidecar` (113) indicate persistent instability that needs investigation. Other services, including `job-monitor` and `stream-av-probe`, appear stable with low restart counts.
- **Recent Errors:** Logs show critical pipeline failures at Gate 3a (Assembly QA hard fail) and Gate 3b (chrome re-burn failure). This suggests issues with video processing, quality checks, or the self-healing pipeline that need to be addressed.

### 3. Pipeline Health

- **Stuck Jobs:** There are no stuck jobs from the last 48 hours, which is a positive sign.
- **Gate Failures:** The errors logged for Gate 3a and 3b point to significant problems in the assembly and post-processing stages. A `GATE3A_HARD_FAIL_SCORE` indicates assembled videos are failing quality checks, and the `GATE3B_REBURN_FAIL` shows that the automated fix for chrome/overlay issues is broken.

### 4. Jira Consistency

- Jira data could not be fetched. The status of development tickets relative to merged code is unknown.

### 5. GitHub + Confluence Consistency

- **Open PRs:** There are no open pull requests.
- **CI Failures:** There are 5 CI failures on various branches, including a feature branch (`feat/cpd-1037-hub-staging`) and multiple Dependabot PRs. Failing CI checks block merges and must be resolved.
- **Confluence:** Confluence data could not be fetched, so documentation currency is unknown.

### 6. Route Integrity

- The provided list of dashboard fetch calls is highly incomplete. A manual scan of `cwn_production.html` reveals dozens of API endpoints in use.
- A full audit is needed to identify unused routes, but endpoints like `/generate-clip-comp` and `/creators/sync` are clearly used by the dashboard while others like `GET /publish/history` and `GET /publish/queue` do not appear to be, making them candidates for deprecation.

### 7. Codebase Structural Integrity

- **Missing Tests:** A very large number of modules in the `lib/` directory lack any test files, creating a high risk of regressions and making maintenance difficult.
- **Missing Env Vars:** Over 200 environment variables are used in the codebase but are not documented in `.env.example`. This is a major barrier to developer onboarding and consistent local setup.
- **Dead Code:** Analysis from the previous session suggested dead code candidates like `geminiQACheck` and `geminiSegmentQA` in `server.js` may have been orphaned by refactoring. A code audit is needed to remove unused functions.

### 8. C0 / C1+ Boundary

- The codebase continues to mix C0 (localhost) and C1+ (Render) concerns. While this session's work was C0-focused (live grid, clip comps), the architectural boundary remains blurred. The presence of C1+-specific logic and environment variables in the C0 stack complicates local development and maintenance.

### 9. Recommendations

- **[BLOCKING]** Investigate and fix the root cause of the high restart counts for the `auraflux` and `broadcast-sidecar` PM2 processes.
- **[BLOCKING]** Resolve all CI failures on GitHub to unblock dependency updates and future merges.
- **[SHOULD FIX]** Debug the Gate 3a and 3b failures to ensure video assembly and quality checks are reliable.
- **[SHOULD FIX]** Update `.env.example` with all missing environment variables. A script to automate this would be beneficial.
- **[SHOULD FIX]** Add unit and integration tests for critical, untested modules, especially those in `lib/assembly.js`, `lib/job_spec.js`, and `lib/gates/`.
- **[NICE TO HAVE]** Conduct a full audit of all backend routes to identify and remove unused endpoints.
- **[NICE TO HAVE]** Refactor shared modules to better separate C0 and C1+ logic.

<!-- last-reviewed-commit: 97ce9d14eb32c70ae3316d09ad2ea42220f711ce -->
<!-- reviewed-at: 2026-06-19T15:35:43Z -->
