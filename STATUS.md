# AuraFlux Status

**Version:** 1.0.315
**Last Updated:** 2026-05-06 (Cursor — fix(ops): correct clip_name in wan21 workflow to _scaled file)
**Deploy State:** pending

## Last Agent Action
Fixed wan_t2v_wan21_workflow.json CLIPLoader clip_name:
- umt5_xxl_fp8_e4m3fn.safetensors → umt5_xxl_fp8_e4m3fn_scaled.safetensors
- Root cause of persistent 768-dim KSampler error: workflow JSON on disk never had the _scaled filename
- Non-scaled file (Wan-AI custom tensor naming) silently loads as SD1ClipModel (768-dim) in ComfyUI
- _scaled file (Comfy-Org repackaged, 6.74GB) loads as WanTEModel (4096-dim) — confirmed via Jupyter
- Direct workflow test (promptId a1a4b188) succeeded: test_scaled_clip_00001_.webp generated
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
