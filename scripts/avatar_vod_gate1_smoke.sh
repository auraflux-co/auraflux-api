#!/usr/bin/env bash
# Avatar VOD Gate 1 structure regression — no Gemini, no HeyGen credits.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "=== avatar_vod_gate1_smoke ==="
node test/normalize_inline_scene_headers.test.js
node test/avatar_vod_gate1_structure.test.js
node test/gate1_handoff_review.test.js
node test/avatar_vod_e2e_chain.test.js
node test/avatar_vod_gate1_content_scrub.test.js
echo "=== avatar_vod_gate1_smoke PASS ==="
echo "Live full E2E: HEYGEN_SIM_MODE=true bash scripts/deploy_c0.sh && node scripts/avatar_vod_e2e.js"
