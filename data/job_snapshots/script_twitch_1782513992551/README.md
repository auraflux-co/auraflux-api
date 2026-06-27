# Job preserve: script_twitch_1782513992551

Saved: 20260627T054909Z

## Tomorrow checklist
1. `bash scripts/deploy_c0.sh` (loads credits-after-SEO + cold open fixes)
2. Dashboard → **↩ RESTORE JOBS** → open this job
3. **🔄 FIX SEO** — generates full YouTube description for Publish Prep review
4. **📁 RE-ASSEMBLE FROM FILES** — cold open (~15s), body, credits scroll full YT desc + Infected bed
5. Preview ~8+ min; credits outro duration auto-scales to description length

## Restore card only (if dashboard loses job)
```bash
node scripts/restore_job_snapshot.js script_twitch_1782513992551
```

## Key paths
- Output: `output/cwn_8clips_script_twitch_1782513992551.mp4`
- Snapshot card: `data/job_snapshots/script_twitch_1782513992551/card.json`
