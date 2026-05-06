# AuraFlux Status

**Version:** 1.0.307
**Last Updated:** 2026-05-05 (Cursor — feat: add Render env var backup/restore to nightly cron)
**Deploy State:** deploying

## Last Agent Action
Added `scripts/backup_render_env.js` and `scripts/restore_render_env.js`.
Render env vars for all services are now backed up nightly to R2 under `envvars/<service-id>/YYYY-MM-DD.json.gz`.
Integrated into `backup_to_r2.js` cron as step 4.
Restored 46 production env vars to `auraflux-api` via safe GET→merge→PUT.

## Still Missing (need manual entry in Render dashboard)
- DATABASE_URL (Render Postgres internal connection string)
- ELEVENLABS_API_KEY (ElevenLabs TTS)
- R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (Cloudflare R2 — needed for backups to run)
