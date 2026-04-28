# AuraFlux Restore Procedure

**Version:** 1.0 — 2026-04-28
**Owner:** Rob Gregory
**Applies to:** auraflux-api on Render (Oregon region)

---

## When to use this

Use this document if:
- The Render persistent disk is corrupted, deleted, or showing missing data
- A deploy accidentally wiped `data/cwn.db` or `data/*.json`
- You are spinning up a new Render service and need to restore from backup

For full disaster recovery scenarios (service down, secrets compromised, etc.) see `docs/ops/DISASTER_RECOVERY.md`.

---

## What is backed up

| Artifact | R2 path | Schedule |
|----------|---------|----------|
| SQLite database (`data/cwn.db`) | `auraflux-backups/sqlite/cwn-YYYY-MM-DD.db.gz` | Nightly 03:00 UTC |
| Runtime state (`data/*.json`) | `auraflux-backups/data/cwn-data-YYYY-MM-DD.tar.gz` | Nightly 03:00 UTC |

Retention: 30 days. The most recent backup is at most 24 hours old (RPO = 24h).

---

## Prerequisites

You need:
- `aws` CLI configured with R2 credentials, **or** `npx @aws-sdk/client-s3` available
- `sqlite3` installed locally
- Access to the Render dashboard

Set these environment variables locally before running any commands:

```bash
export R2_ACCOUNT_ID=<your-cloudflare-account-id>
export R2_ACCESS_KEY_ID=<your-r2-access-key>
export R2_SECRET_ACCESS_KEY=<your-r2-secret>
export R2_ENDPOINT=https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com
```

---

## Step 1 — List available backups

```bash
AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID \
AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY \
aws s3 ls s3://auraflux-backups/sqlite/ \
  --endpoint-url $R2_ENDPOINT \
  --region auto
```

Pick the most recent date (or a specific date to restore to).

---

## Step 2 — Download the backup

```bash
DATE=2026-04-28   # replace with target date

# SQLite database
AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID \
AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY \
aws s3 cp s3://auraflux-backups/sqlite/cwn-${DATE}.db.gz /tmp/cwn-${DATE}.db.gz \
  --endpoint-url $R2_ENDPOINT --region auto

# JSON state files
AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID \
AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY \
aws s3 cp s3://auraflux-backups/data/cwn-data-${DATE}.tar.gz /tmp/cwn-data-${DATE}.tar.gz \
  --endpoint-url $R2_ENDPOINT --region auto
```

---

## Step 3 — Decompress

```bash
# Decompress SQLite
gunzip -k /tmp/cwn-${DATE}.db.gz
# Result: /tmp/cwn-${DATE}.db

# Decompress JSON files
mkdir -p /tmp/cwn-restore-${DATE}
tar -xzf /tmp/cwn-data-${DATE}.tar.gz -C /tmp/cwn-restore-${DATE}
# Result: /tmp/cwn-restore-${DATE}/data/*.json
```

---

## Step 4 — Verify the database

```bash
sqlite3 /tmp/cwn-${DATE}.db "SELECT COUNT(*) FROM jobs;"
# Should return a non-zero number matching your expected job count
```

---

## Step 5 — Upload to Render persistent disk

Use Render's **Shell** tab (auraflux-api service → Shell) or SSH:

```bash
# On your local machine: copy files to Render via their upload mechanism
# OR use the Render Shell tab directly:

# From Render Shell — download from R2 directly into the container:
curl -L "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/..." -o /app/data/cwn.db.gz
gunzip /app/data/cwn.db.gz
```

**Alternatively** — the fastest method: push the restored files as a one-off deploy:

```bash
# Locally: copy restored files into data/ and commit to a restore branch
cp /tmp/cwn-${DATE}.db ./data/cwn.db
cp /tmp/cwn-restore-${DATE}/data/*.json ./data/
git checkout -b restore/${DATE}
git add data/
git commit -m "chore: restore from backup ${DATE}"
git push origin restore/${DATE}
# Deploy this branch in Render dashboard
```

---

## Step 6 — Restart the service

In Render dashboard → auraflux-api → **Manual Deploy** (or the restore branch will trigger one automatically).

---

## Step 7 — Verify

```bash
curl https://auraflux-api.onrender.com/health
# Expected: { "status": "ok", "uptime": ..., "jobCount": N }

curl https://auraflux-api.onrender.com/jobs
# Should return job list matching restored data
```

Check New Relic: confirm events are flowing and no error spike.

---

## Restore time estimate

| Step | Estimated time |
|------|---------------|
| Download from R2 | < 1 min |
| Decompress + verify | < 1 min |
| Upload to Render + deploy | 5–10 min |
| Service healthy | 2–3 min after deploy |
| **Total RTO** | **< 15 min** (well within 2h target) |

---

## If the backup itself is missing

If `auraflux-backup` cron job failed and no backup exists for today:

1. Check New Relic for `AuraFluxBackup` events with `status: failure`
2. The Render persistent disk still holds the live `data/cwn.db` — data is not lost, only the backup is missing
3. Run the backup manually: `node scripts/backup_to_r2.js` from within the Render Shell
4. Investigate the cron job failure in Render dashboard → auraflux-backup → Logs
