# EchoMimicV3-Flash RunPod serverless worker (CPD-990)

Self-hosted avatar render worker — replaces HeyGen renders behind the
`lib/avatar` adapter contract (CPD-989). Decision + spike data:
Confluence **31555587** (`HOW — Self-hosted avatar pipeline`).

## What it does

One job = one avatar segment: portrait png + speech wav in (presigned GET),
lip-synced mp4 out (presigned PUT to R2). TTS happens upstream (ElevenLabs) —
this worker only animates.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Pinned stack + baked weights (~30GB image). Every pin is a spike gotcha — don't "modernise" versions. |
| `constraints.txt` | The validated pinset, enforced during `pip install -r requirements.txt`. |
| `handler.py` | RunPod serverless handler. v1 subprocess render (exact spike invocation). |
| `build.sh` | Build + push (`--platform linux/amd64` mandatory). |

## Build + deploy

```bash
REGISTRY=docker.io/youruser bash build.sh
# then: RunPod console → Serverless → New Endpoint with the pushed image
#   GPU: A40 48GB (validated in spike) · workers 0 min / 1-2 max
#   idle timeout 120s — keeps the worker warm across a job's scene batch
# put the endpoint id in cwn-c0/.env: ECHOMIMIC_ENDPOINT_ID=...
```

Heads-up on the build: the weights layer downloads ~22GB from HuggingFace and
the push uploads ~30GB — run it on a fat pipe (RunPod CPU pod, depot.dev, CI),
not home broadband.

## Measured economics (spike, A40 @ $0.40/hr)

- 81 frames (3.24s @ 25fps) ≈ 152–162s wall including ~45s model load
- ≈ 49× realtime cold, ~35× warm → **$0.33/avatar-min cold, ~$0.23 warm**
- HeyGen comparison: ~$0.50–1.00/min + monthly plan caps

## Known limits (CPD-991 scope)

- **Segments > 3.24s** need windowed generation + stitching — production avatar
  scenes run 10–40s. The chunking lives in `lib/avatar/adapters/echomimic.js`,
  not here.
- **Quality tuning**: spike scored 7–9/10 vs HeyGen 9–10/10 at default settings
  (8 steps). Levers: `num_inference_steps` 15–25, `audio_guidance_scale`
  1.8–2.0, better-lit base portrait. Cutover bar: ≥9 at Gate 2 consistently.
- **Warm in-process pipeline**: v1 subprocess pays the ~45s model load per job.
  Once CPD-991 settles the final inference args, port infer_flash.py's setup
  into module scope so the loaded pipeline is reused across jobs (~30% cheaper).
