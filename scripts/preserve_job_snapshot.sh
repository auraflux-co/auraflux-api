#!/usr/bin/env bash
# Preserve a job card + output references so assembly/SEO work can resume safely.
# Usage: bash scripts/preserve_job_snapshot.sh script_twitch_1782513992551
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JOB_ID="${1:?job id required}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$ROOT/data/job_snapshots/${JOB_ID}"
mkdir -p "$DEST"

cd "$ROOT"
JOB_ID="$JOB_ID" DEST="$DEST" node << 'NODE'
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');
const id = process.env.JOB_ID;
const dest = process.env.DEST;
const jobs = JSON.parse(fs.readFileSync('data/jobs.json', 'utf8'));
const card = jobs[id] || db.loadJob(id);
if (!card) throw new Error('Job not found: ' + id);
const outPath = card.outputPath || path.join('output', card.filename || '');
const snapshot = {
  preservedAt: new Date().toISOString(),
  jobId: id,
  card,
  sqliteCard: db.loadJob(id),
  outputPath: outPath,
  outputExists: outPath ? fs.existsSync(outPath) : false,
  outputBytes: outPath && fs.existsSync(outPath) ? fs.statSync(outPath).size : 0,
  tmpGroupsGlob: 'tmp/asm_*' + id.replace(/^script_/, '') + '*',
  notes: [
    'Re-assemble from dashboard after pipeline fixes (cold open + credits-after-SEO).',
    'Or: POST /job/:id/regenerate-publish-copy then reassemble if credits already baked wrong.',
  ],
};
fs.writeFileSync(path.join(dest, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
fs.writeFileSync(path.join(dest, 'card.json'), JSON.stringify(card, null, 2));
console.log('Wrote', path.join(dest, 'snapshot.json'));
NODE

# Copy output MP4 if present (hard link to save space when same filesystem)
OUT="$ROOT/output/cwn_8clips_${JOB_ID}.mp4"
if [[ -f "$OUT" ]]; then
  ln -f "$OUT" "$DEST/cwn_8clips_${JOB_ID}.mp4" 2>/dev/null || cp -p "$OUT" "$DEST/cwn_8clips_${JOB_ID}.mp4"
  echo "Linked/copied output → $DEST/"
fi

# Copy cold-open VO if present
VO="$ROOT/tmp/bookends/${JOB_ID}/cold_open_vo.m4a"
if [[ -f "$VO" ]]; then
  mkdir -p "$DEST/bookends"
  cp -p "$VO" "$DEST/bookends/cold_open_vo.m4a"
fi

cat > "$DEST/README.md" << EOF
# Job preserve: ${JOB_ID}

Saved: ${STAMP}

## Tomorrow checklist
1. \`bash scripts/deploy_c0.sh\` (loads credits-after-SEO + cold open fixes)
2. Dashboard → **↩ RESTORE JOBS** → open this job
3. **🔄 FIX SEO** — generates full YouTube description for Publish Prep review
4. **📁 RE-ASSEMBLE FROM FILES** — cold open (~15s), body, credits scroll full YT desc + Infected bed
5. Preview ~8+ min; credits outro duration auto-scales to description length

## Restore card only (if dashboard loses job)
\`\`\`bash
node scripts/restore_job_snapshot.js ${JOB_ID}
\`\`\`

## Key paths
- Output: \`output/cwn_8clips_${JOB_ID}.mp4\`
- Snapshot card: \`data/job_snapshots/${JOB_ID}/card.json\`
EOF

echo "✅ Preserved ${JOB_ID} → ${DEST}"
