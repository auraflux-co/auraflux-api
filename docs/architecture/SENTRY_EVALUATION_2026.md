# Sentry — removed Aug 2026

**Status:** **Removed.** Error tracking uses `lib/error_logger.js` (`logError` → `logs/errors.jsonl`). No `@sentry/node`, no `SENTRY_DSN`.

**Why removed:** Duplicated New Relic + local logs; Sentry Uptime was polling `GET /` on the API (~500 KB/check), driving Render bandwidth on Hobby plan.

**Manual cleanup (Rob):**
1. [sentry.io](https://sentry.io) → delete **Uptime** monitor on `auraflux-api.onrender.com` (or point to `/health` if keeping free tier for something else).
2. Cancel paid plan if subscribed; delete AuraFlux project optional.

**History:** CPD-554 (June 2026) evaluated Sentry; full removal shipped Aug 2026.
