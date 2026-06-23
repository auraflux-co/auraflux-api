# Sentry evaluation — CPD-554 (June 2026)

**Decision:** Keep `@sentry/node` on API at **free Developer tier**; cancel paid plan unless `@sentry/nextjs` is added to `auraflux-app`.

Backend Sentry duplicates New Relic + `logError()` without covering dashboard UX failures. Revisit paid tier when frontend Sentry ships.

Cancel entirely: remove `Sentry.init` from `server.js` and `SENTRY_DSN` from Render / `.env.example`.
