# AuraFlux Status

**Version:** 1.0.311
**Last Updated:** 2026-05-06 (Cursor — fix(ops): WAN 2.1 pod auto-detection + workflow adapter)
**Deploy State:** pending

## Last Agent Action
Fixed WAN video generation pipeline to work with WAN 2.1 pod (5a8c7dkr95eohw):
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
