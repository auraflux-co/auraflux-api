# AuraFlux — Disaster Recovery Runbook

**Version:** 1.0 — 2026-04-30
**Platform:** C1+ (Render) — this runbook does NOT apply to localhost/C0
**Audience:** Rob (primary operator)
**RTO target:** < 2 hours (service fully restored)
**RPO target:** < 24 hours (max data loss = last nightly Render Postgres backup)

---

## Emergency Quick Reference

| System | URL / Location |
|--------|----------------|
| Render dashboard | https://dashboard.render.com |
| AuraFlux API service | Render → Services → `auraflux-api` |
| Postgres backups | Render → Databases → `auraflux-db` → Backups tab |
| Cloudflare R2 media | Cloudflare dashboard → R2 → `auraflux-assets` bucket |
| New Relic | https://one.newrelic.com |
| Health endpoint | `GET https://api.auraflux.co/health` |
| GitHub repo | https://github.com/robertgregory/cwn-production |

---

## Scenario 1 — Render Service Down / Crashed

**Symptoms:** `/health` returns non-200, New Relic alert fires, customers cannot reach dashboard.

**Expected RTO:** 10–30 minutes.

### Steps

```bash
# 1. Confirm the outage
curl -sf https://api.auraflux.co/health || echo "SERVICE DOWN"

# 2. Check Render service status
# Render dashboard → auraflux-api → Logs tab
# Look for: OOM kill, port not bound, crash loop
```

3. **If crash loop:** Render dashboard → auraflux-api → **Manual Deploy** using the last known-good commit (not HEAD if HEAD is suspect).

4. **If OOM:** Render dashboard → auraflux-api → Settings → **Upgrade instance type** (Standard → Pro). Then redeploy.

5. **Verify recovery:**

```bash
curl https://api.auraflux.co/health
# Expected: { "ok": true, "version": "...", "gitHash": "..." }
```

6. Check New Relic to confirm error rate returns to baseline.

---

## Scenario 2 — Cloudflare R2 Media Asset Loss

**Symptoms:** Generated videos / thumbnails return 404 from CDN. `R2_ASSETS_DOMAIN` URLs broken.

**Expected RTO:** 30–90 minutes depending on re-upload volume.

### Steps

```bash
# 1. Confirm scope — is it one asset or all?
curl -I https://<R2_ASSETS_DOMAIN>/test-path

# 2. Check Cloudflare R2 bucket
# Cloudflare dashboard → R2 → auraflux-assets → list objects
```

3. **If bucket deleted:** Contact Cloudflare support immediately. R2 has versioning — recovery may be possible.

4. **If individual files missing:** Re-run the relevant portal job through the AuraFlux API to regenerate outputs.

5. **If CDN config broken (not bucket):** Cloudflare dashboard → Workers & Pages → check custom domain routing for R2.

### Prevention
- Enable Cloudflare R2 object versioning (Cloudflare dashboard → bucket settings)
- Set up nightly R2 inventory snapshot via `rclone` to a separate bucket

---

## Scenario 3 — Postgres Data Loss

**Symptoms:** API errors referencing DB, jobs missing, client records gone.

**Expected RTO:** 30–120 minutes.
**Expected RPO:** Up to 24 hours (Render daily backup cadence). Point-in-time recovery available on Pro plan.

### Steps

**3a — Partial loss (some tables/rows corrupted):**

```bash
# Connect to Render Postgres
# Render dashboard → auraflux-db → Connect → copy psql connection string
psql <connection_string>

# Restore specific table from Render backup
# Render dashboard → auraflux-db → Backups tab → click latest backup → Download
# Then:
pg_restore --table=<table_name> -d <connection_string> <backup_file>
```

**3b — Full database loss:**

```bash
# Render dashboard → auraflux-db → Backups tab
# Click the latest backup → "Restore" (this creates a new Postgres instance)
# Update DATABASE_URL in auraflux-api environment variables to point to new instance
# Redeploy auraflux-api to pick up new DATABASE_URL
```

**3c — Point-in-time recovery (Pro plan only):**

```bash
# Render dashboard → auraflux-db → "Point-in-Time Recovery"
# Select a timestamp before the data loss event
# This creates a new DB instance at that point in time
```

**Verify:**

```bash
curl https://api.auraflux.co/health
# Check that DB connection shows healthy

curl https://api.auraflux.co/api/jobs \
  -H "Authorization: Bearer <AURAFLUX_API_SECRET>"
# Should return job list, not a 500
```

---

## Scenario 4 — Bad Deploy Broke the API

**Symptoms:** Deploy succeeded but `/health` fails, endpoints return 500s, New Relic error rate spikes after a deploy.

**Expected RTO:** 5–15 minutes.

### Steps

```bash
# 1. Confirm it's the new deploy (correlate with deploy timestamp in New Relic)
# 2. One-click rollback in Render
```

Render dashboard → **auraflux-api** → **Deploys tab** → find the last successful deploy → **Rollback to this deploy**.

```bash
# 3. Verify health
curl https://api.auraflux.co/health

# 4. Tag the bad commit in git so it doesn't get re-deployed
git tag bad-deploy-<date> <bad-commit-hash>
git push origin --tags
```

5. Open a CPD bug ticket with `blocker` label for the failing commit. Fix and redeploy in a new PR.

---

## Scenario 5 — Secrets Compromised

**Symptoms:** Unauthorized API usage, unexpected HeyGen/Stripe charges, a secret was accidentally committed.

**Expected RTO:** 30–60 minutes (for full rotation). Service stays up during rotation.

### Rotation order (fastest impact first)

| Secret | Where to rotate | Env var |
|--------|----------------|---------|
| `AURAFLUX_API_SECRET` | Generate new: `openssl rand -base64 32` | Update Render + `app/.env.local` |
| `STRIPE_SECRET_KEY` | Stripe dashboard → API Keys → Roll key | Update Render |
| `STRIPE_WEBHOOK_SECRET` | Stripe dashboard → Webhooks → Re-reveal/rotate | Update Render |
| `HEYGEN_API_KEY` | HeyGen dashboard → API Keys → Revoke + create new | Update Render |
| `GEMINI_API_KEY` | Google Cloud Console → Credentials → Delete + create | Update Render |
| `NEW_RELIC_LICENSE_KEY` | New Relic → Account Settings → API Keys | Update Render |
| `CLERK_SECRET_KEY` | Clerk dashboard → API Keys → Roll | Update Render + `app/.env.local` |

### Steps

```bash
# 1. Immediately revoke the compromised key at the source (links above)
# 2. Generate replacement
# 3. Render dashboard → auraflux-api → Environment → update the env var
# 4. Trigger a redeploy (Render picks up new env var on next deploy)
# 5. Verify service health after redeploy
curl https://api.auraflux.co/health

# 6. If a secret was committed to git, force-remove it from history
git filter-branch --force --index-filter \
  "git rm --cached --ignore-unmatch <file-with-secret>" \
  --prune-empty --tag-name-filter cat -- --all
git push origin --force --all
# Then notify GitHub support to purge cached views
```

6. Review recent API usage logs in New Relic for any unauthorized actions during the exposure window.

---

## Monitoring Alerts (New Relic)

These alerts should be configured in New Relic before launch:

| Alert | Condition | Channel |
|-------|-----------|---------|
| Service down | `/health` non-200 for > 5 minutes | Email + Slack |
| High error rate | 5xx rate > 10% over 5 min | Email |
| Nightly backup missed | Backup cron didn't emit success event by 04:00 UTC | Email |
| Memory pressure | Instance memory > 85% for > 10 minutes | Email |

**Configure at:** New Relic → Alerts → Alert Conditions → create NRQL alert for each row above.

---

## Restore Drill (Run Before Launch)

Before onboarding Customer 1, run a full restore drill:

1. Take a snapshot of the Render Postgres DB (Render dashboard → Backups → Manual backup)
2. Restore it to a **staging** Render service (not production)
3. Point a test instance of `auraflux-api` at the restored DB
4. Run: `GET /health` → verify `ok: true`
5. Run: `GET /api/jobs` → verify job count matches expected
6. Document the elapsed time in this file:

```
Last drill: [DATE NOT YET RUN]
Time to restore DB: [N/A]
Time to verify health: [N/A]
Result: [N/A]
RTO achieved: [N/A]
```

---

## Related Documents

- `docs/ops/RENDER_DEPLOY_CHECKLIST.md` — deploy procedure
- `docs/ops/POST_RENDER_TASKS.md` — post-deploy task backlog
- `docs/ops/PIPELINE_FAILURE_PLAYBOOK.md` — portal-level failures (not service-level)
- Confluence: AuraFlux / Operations / Disaster Recovery (mirrors this doc)

---

*This runbook covers Render C1+ production only. For localhost C0 recovery, see `docs/ops/RENDER_RUNBOOK.md` (C0-era, not deployed).*
