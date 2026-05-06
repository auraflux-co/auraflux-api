# AuraFlux Status

**Version:** 1.0.316
**Last Updated:** 2026-05-06 (Cursor — fix(ops): predeploy_env_guard.sh — auto-restore missing Render env vars)
**Deploy State:** deploying

## Last Agent Action
Added scripts/predeploy_env_guard.sh — permanent fix for recurring Render env var wipes:
- Root cause: Render PUT /env-vars is a full replacement; any partial PUT silently deletes all other vars
- Secondary cause: render.yaml Blueprint sync clears sync:false vars with no value on every push
- Guard runs at pre-commit: GET current Render vars → compare against .env → auto-restore missing via GET-merge-PUT
- Wired into pre-commit hook replacing check_render_env.sh (detect-only → active auto-restore)
- Confirmed: all 54 Render env vars present (RUNPOD_API_KEY, GEMINI_API_KEY restored from earlier wipe)
Previously:
- lib/ai/runpod.js: added _probeWan21Nodes() to detect pod's node schema at runtime (cached per pod ID)
- lib/ai/runpod.js: generateWanVideo() selects workflow file based on probe result — wan_t2v_wan21_workflow.json for newer kijai nodes, wan_t2v_workflow.json for legacy nodes
- lib/ai/wan_t2v_wan21_workflow.json: new workflow for WAN 2.1 using CLIPLoader(wan type) + WanImageToVideo + KSampler + VAEDecodeTiled + SaveAnimatedWEBP

Previously fixed (CPD-148):
- operate_gemini_e2e.py: fixed 4 blocking API contract issues (contentType, type, platforms nesting, productionProfile→templateId mapping, HEAD→GET for video URL checks)
- guided_gemini_e2e.js: added video polling after wizard submit — resolves jobId via GET /v1/jobs, polls until outputUrl appears (25 min). Fresh browser context per scenario. Fixed networkidle, Thinking-text race, Copilot selector.
- managed_gemini_e2e.js: after Copilot conversation, Gemini extracts job params and submits via POST /v1/jobs, polls for outputUrl. Fresh context per scenario.
- lib_gemini.py: hardened JSON stripping with regex to handle all Gemini code fence variants
- run_all_18.sh: added AURAFLUX_E2E_API_KEY_GUIDED/MANAGED env vars, require guards, JSON-based pass counting
- .env.example: documented all new E2E env vars
