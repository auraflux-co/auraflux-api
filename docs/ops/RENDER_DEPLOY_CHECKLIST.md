# Render deploy checklist (Customer 0 API)

**Complements:** `docs/ops/POST_RENDER_TASKS.md` (post-migration work backlog).

**Prerequisite:** Image builds from `Dockerfile` in repo root; Node 22 + system libs for canvas/sharp/puppeteer/ffmpeg.

**Last updated:** 2026-04-21

---

## Pre-deploy

- [ ] **Parity env:** Copy from local `.env` to Render **environment group** (never commit secrets). At minimum: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `HEYGEN_API_KEY`, DB/Redis if used, `NEW_RELIC_LICENSE_KEY` (**40-char license key**, not Ingest key — see `STATUS.md`).
- [ ] **GATE_TEST_MODE:** `false` only when you intend live HeyGen; use `true` for staging smoke to avoid spend.
- [ ] **FFmpeg:** Included in Docker image; do not rely on host FFmpeg on bare Node buildpack unless you add apt layers (Dockerfile already handles this).
- [ ] **Database:** Current prod uses SQLite → plan **Postgres** for Render (per roadmap); run migration when ready.
- [ ] **Health:** After deploy, `GET /health` should report `ok: true` and correct `version` / `gitHash` from `BUILD_INFO`.

## Deploy (high level)

1. Connect repo to Render.  
2. **Docker** deploy type; point to `Dockerfile`.  
3. Set **port** to what `server.js` uses (`process.env.PORT` is standard; confirm `server.js` binds `0.0.0.0` and `PORT`).  
4. **Disk:** if SQLite persists on disk, attach a **persistent disk** or migrate to Postgres first.

## Post-deploy (from `POST_RENDER_TASKS.md`)

- [ ] New Relic alerts, monitoring escalation paths, `TZ=UTC` for logs.  
- [ ] Re-run `npm run load-test:health` against **production URL** in a **low** connection count window.

## Rollback

- Keep **previous** Render deploy ID or Docker tag; one-click rollback in Render dashboard if health checks fail.
