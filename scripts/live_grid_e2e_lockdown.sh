#!/usr/bin/env bash
# E2E lockdown for nightly Live Grid → YouTube (4 Twitch quads, fixed encode path).
# Profile: config/live_grid_profile_e2e.json
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="$ROOT/config/live_grid_profile_e2e.json"
ENV_FILE="$ROOT/.env"
MARK_BEGIN="# === LIVE GRID E2E LOCKDOWN (scripts/live_grid_e2e_lockdown.sh) ==="
MARK_END="# === END LIVE GRID E2E LOCKDOWN ==="

usage() {
  cat <<EOF
Usage: bash scripts/live_grid_e2e_lockdown.sh <command>

  apply      Write locked baseline + E2E env into .env (grid should be OFF)
  verify     Check .env, ecosystem.config.js, ffmpeg drawtext, optional master
  preflight  Full E2E lockdown + baseline unit tests (blocks GO LIVE on drift)
  restore    apply + pm2 restart broadcast-sidecar (does not start grid)
  payload    Print locked /live-grid/start JSON body

Before every nightly go-live:
  bash scripts/live_grid_e2e_lockdown.sh preflight
EOF
}

require_profile() {
  [[ -f "$PROFILE" ]] || { echo "Missing $PROFILE"; exit 1; }
}

lockdown_env_lines() {
  node -e "
    const { mergedEnvLock } = require('./lib/live_grid/e2e_lockdown');
    for (const [k, v] of Object.entries(mergedEnvLock())) console.log(k + '=' + v);
  "
}

apply_lockdown() {
  require_profile
  local tmp blockfile
  blockfile="$(mktemp)"
  lockdown_env_lines > "$blockfile"
  tmp="$(mktemp)"
  if grep -q "$MARK_BEGIN" "$ENV_FILE" 2>/dev/null; then
    python3 - "$ENV_FILE" "$blockfile" "$MARK_BEGIN" "$MARK_END" "$tmp" <<'PY'
import sys
env_file, block_file, begin, end, out = sys.argv[1:6]
block = open(block_file).read().rstrip('\n')
lines = open(env_file).read().splitlines()
out_lines = []
skip = False
for line in lines:
    if line == begin:
        out_lines.append(line)
        out_lines.extend(block.splitlines())
        skip = True
        continue
    if skip and line == end:
        skip = False
        out_lines.append(line)
        continue
    if not skip:
        out_lines.append(line)
open(out, 'w').write('\n'.join(out_lines) + '\n')
PY
  else
    {
      echo ""
      echo "$MARK_BEGIN"
      cat "$blockfile"
      echo "$MARK_END"
    } >> "$ENV_FILE"
    cp "$ENV_FILE" "$tmp"
  fi
  rm -f "$blockfile"
  mv "$tmp" "$ENV_FILE"
  echo "Applied E2E lockdown env block to .env"
  echo "Next: pm2 restart broadcast-sidecar --update-env"
}

verify_lockdown() {
  require_profile
  node -e "
    const { runE2eLockdown } = require('./lib/live_grid/e2e_lockdown');
    const r = runE2eLockdown({ skipRuntime: false });
    console.log('=== E2E lockdown verify ===');
    if (r.env.ok) console.log('  OK  .env lockdown');
    else { console.log('  FAIL .env'); r.env.mismatches.forEach(m => console.log('    ', m.key, 'want', m.want, 'got', m.got)); }
    if (r.ecosystem.ok) console.log('  OK  ecosystem.config.js');
    else { console.log('  FAIL ecosystem'); r.ecosystem.mismatches.forEach(m => console.log('    ', m.key)); }
    if (r.ffmpeg.ok) console.log('  OK  ffmpeg drawtext @', r.ffmpeg.bin);
    else console.log('  FAIL ffmpeg:', r.ffmpeg.fix);
    if (r.goLive.ok) console.log('  OK  go-live config', r.goLive.path);
    else console.log('  FAIL go-live:', r.goLive.issues || r.goLive.error);
    if (r.runtime.skipped) console.log('  SKIP master not running');
    else if (r.runtime.ok) console.log('  OK  master runtime encode');
    else { console.log('  FAIL master runtime'); (r.runtime.issues||[]).forEach(i => console.log('    ', i)); }
    if (!r.ok) { console.log(r.env.fix || 'Fix drift then re-run verify'); process.exit(1); }
    console.log('E2E lockdown OK');
  "
}

preflight_lockdown() {
  require_profile
  echo "=== E2E lockdown preflight ==="
  node -e "
    const { runE2eLockdown } = require('./lib/live_grid/e2e_lockdown');
    const { runPreflight } = require('./lib/live_grid/preflight');
    const e2e = runE2eLockdown();
    const base = runPreflight();
    const blocking = [...new Set([...(e2e.blocking||[]), ...(base.blocking||[])])];
    const out = { ok: blocking.length === 0, blocking, e2e, baseline: base, readyForGoLive: blocking.length === 0 };
    console.log(JSON.stringify(out, null, 2));
    if (!out.ok) process.exit(1);
  "
}

restore_lockdown() {
  if curl -sf http://127.0.0.1:3001/live-grid/status 2>/dev/null | grep -q '"running":true'; then
    echo "Stopping live grid before restore..."
    curl -sf -X POST http://127.0.0.1:3001/live-grid/stop -H 'Content-Type: application/json' -d '{"endBroadcast":false}' >/dev/null || true
    sleep 2
  fi
  apply_lockdown
  pm2 restart broadcast-sidecar --update-env
  echo "E2E lockdown restored. Preflight: bash scripts/live_grid_e2e_lockdown.sh preflight"
}

print_payload() {
  node -e "console.log(JSON.stringify(require('./lib/live_grid/e2e_lockdown').buildLockedStartPayload(), null, 2))"
}

cmd="${1:-}"
case "$cmd" in
  apply) apply_lockdown ;;
  verify) verify_lockdown ;;
  preflight) preflight_lockdown ;;
  restore) restore_lockdown ;;
  payload) print_payload ;;
  -h|--help|help|"") usage ;;
  *) echo "Unknown command: $cmd"; usage; exit 1 ;;
esac
