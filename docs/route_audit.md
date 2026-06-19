# Route audit — C0 dashboard vs server.js
Generated: 2026-06-19T16:01:32.788Z
## Summary
- Server routes: **156**
- Dashboard fetch paths: **40**
- Dashboard paths with no server match: **6**
- Server routes not referenced in dashboard (candidates): **120**
## Dashboard paths — no matching route (404 risk)
- `/assemble-progress/`
- `/canva-import-status/`
- `/download/`
- `/gate5-review`
- `/job/`
- `/thumbnail-status/`
## Server routes — not referenced in dashboard (deprecation candidates)
- `/connect/kick-follows`
- `/job/:id`
- `/`
- `/assemble-progress/:id`
- `/broadcast/av-probe`
- `/broadcast/content-board`
- `/broadcast/live-monitor`
- `/broadcast/local-feed`
- `/broadcast/local-watch`
- `/broadcast/ops`
- `/broadcast/playbook`
- `/broadcast/stream-health`
- `/calendar/broadcast-today`
- `/calendar/eligible-jobs`
- `/calendar/plan`
- `/canva-import-status/:id`
- `/capcut/health`
- `/capcut/status/:jobId`
- `/channels/callback/kick`
- `/connect/kick-follows`
- `/connect/twitch`
- `/connect/youtube`
- `/connect/youtube/callback`
- `/connect/youtube/status`
- `/creators`
- `/creators/connect-status`
- `/creators/roster`
- `/cwn_production.html`
- `/dashboard-config`
- `/download/:file`
- `/errors`
- `/job-spec/:jobId`
- `/job/:id`
- `/job/:id/assembly-preflight`
- `/live-grid/allowlist`
- `/live-grid/analytics/hourly`
- `/live-grid/discovery/bench`
- `/live-grid/event-feed/preview`
- `/live-grid/files`
- `/live-grid/followed-bench`

_…and 80 more_
Re-run: `node scripts/route_audit.js --write`