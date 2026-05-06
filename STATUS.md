# AuraFlux Status

**Version:** 1.0.309
**Last Updated:** 2026-05-05 (Cursor — fix(cpd-147): ensurePodRunning orphan pod creation)
**Deploy State:** pending

## Last Agent Action
Fixed ensurePodRunning() in lib/ai/runpod.js (CPD-147):
- Added module-level promise lock — concurrent callers share one execution
- Added pre-flight scan — adopts existing auraflux-comfyui-auto pod before deploying new one
- Added _registerNewPod() — terminates old EXITED pod after replacement confirmed ready
