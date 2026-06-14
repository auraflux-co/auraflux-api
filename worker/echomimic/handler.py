"""CPD-990 — EchoMimicV3-Flash RunPod serverless handler.

Job input:
{
  "image_url":      "https://...presigned GET — base portrait png",
  "audio_url":      "https://...presigned GET — speech wav (ElevenLabs TTS output)",
  "output_put_url": "https://...presigned PUT — where the mp4 lands (R2)",
  "prompt":         "optional — scene/persona prompt, defaults to Bobby G studio",
  "video_length":   81,        # frames (25fps). 81 = 3.24s, the validated window
  "num_inference_steps": 8,    # spike default; CPD-991 tuning raises to 15-25
  "audio_guidance_scale": 2.0,
  "guidance_scale": 4.5,
  "sample_size":    [768, 768],
  "fps":            25,
  "seed":           43,
  "use_dynamic_cfg": true,     # Phase-aware Negative CFG (paper / app_mm.py)
  "use_dynamic_acfg": true,
  "neg_scale": 1.5,
  "neg_steps": 2,
  "negative_prompt": "optional — defaults to EchoMimic hand-artifact negatives"
}

Output:
{ "ok": true, "render_seconds": 152.3, "output_bytes": 1234567, "uploaded": true }

v1 renders via subprocess (replicates the spike invocation exactly — ~45s model
load per job, measured 49x realtime cold). Warm in-process pipeline reuse is the
CPD-991 follow-up once quality tuning settles the final inference args.
"""

import os
import shutil
import subprocess
import time
import uuid

import requests
import runpod

REPO_DIR = "/workspace/echomimic_v3"
# Weights live on a RunPod network volume (serverless mounts it at /runpod-volume).
# GHCR's 10GB layer cap rules out baking the ~22GB of weights into the image.
MODELS_DIR = os.environ.get("MODELS_DIR", "/runpod-volume/models")

DEFAULT_PROMPT = (
    "A bearded man in a tan blazer over a black t-shirt sits at a desk in a "
    "streaming studio, a purple neon world map glowing on the wall behind him, "
    "a broadcast microphone on an arm at frame left. He speaks naturally to the "
    "camera. Hand and body movements are minimal and consistent with a natural "
    "speaking posture. Don't blink too often. Preserve background integrity "
    "matching the reference image's spatial configuration, lighting conditions, "
    "and color temperature."
)

DEFAULT_NEGATIVE_PROMPT = (
    "Gesture is bad. Gesture is unclear. Strange and twisted hands. Bad hands. "
    "Bad fingers. Unclear and blurry hands. Unclear gestures, broken hands, "
    "fused fingers. Exaggerated mouth opening. Teeth distortion."
)


def _download(url, dest, label):
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    with open(dest, "wb") as f:
        f.write(resp.content)
    size = os.path.getsize(dest)
    if size == 0:
        raise RuntimeError(f"{label} downloaded 0 bytes")
    print(f"[handler] {label}: {size} bytes")
    return dest


def _truthy(val):
    if isinstance(val, bool):
        return val
    if val is None:
        return False
    return str(val).lower() in ("1", "true", "yes", "on")


def handler(job):
    inp = job["input"]
    for required in ("image_url", "audio_url", "output_put_url"):
        if not inp.get(required):
            return {"ok": False, "error": f"missing required input: {required}"}

    job_dir = f"/tmp/job_{uuid.uuid4().hex[:8]}"
    os.makedirs(job_dir, exist_ok=True)

    try:
        image_path = _download(inp["image_url"], f"{job_dir}/input.png", "image")
        audio_path = _download(inp["audio_url"], f"{job_dir}/input.wav", "audio")

        out_dir = f"{job_dir}/out"
        os.makedirs(out_dir, exist_ok=True)

        sample_size = inp.get("sample_size") or [768, 768]
        use_dynamic_cfg = _truthy(inp.get("use_dynamic_cfg"))
        use_dynamic_acfg = _truthy(inp.get("use_dynamic_acfg"))
        neg_scale = float(inp.get("neg_scale", 1.5 if use_dynamic_cfg else 1.0))
        neg_steps = int(inp.get("neg_steps", 2 if use_dynamic_cfg else 0))

        # Exact spike invocation (spike/cpd881/control.sh) with tunable overrides.
        # --fsdp_dit is REQUIRED: without it the audio-injection layers missing
        # from the base Wan checkpoint stay on the meta device and .to(device) crashes.
        args = [
            "python", "infer_flash.py",
            "--image_path", image_path,
            "--audio_path", audio_path,
            "--prompt", inp.get("prompt") or DEFAULT_PROMPT,
            "--negative_prompt", inp.get("negative_prompt") or DEFAULT_NEGATIVE_PROMPT,
            "--num_inference_steps", str(inp.get("num_inference_steps", 8)),
            "--config_path", "config/config.yaml",
            "--model_name", f"{MODELS_DIR}/Wan2.1-Fun-V1.1-1.3B-InP",
            "--transformer_path", f"{MODELS_DIR}/em3/echomimicv3-flash-pro/diffusion_pytorch_model.safetensors",
            "--save_path", out_dir,
            "--wav2vec_model_dir", f"{MODELS_DIR}/chinese-wav2vec2-base",
            "--sampler_name", "Flow_Unipc",
            "--video_length", str(inp.get("video_length", 81)),
            "--guidance_scale", str(inp.get("guidance_scale", 4.5)),
            "--audio_guidance_scale", str(inp.get("audio_guidance_scale", 2.0)),
            "--audio_scale", str(inp.get("audio_scale", 1.0)),
            "--neg_scale", str(neg_scale),
            "--neg_steps", str(neg_steps),
            "--seed", str(inp.get("seed", 43)),
            "--teacache_threshold", str(inp.get("teacache_threshold", 0.1)),
            "--num_skip_start_steps", str(inp.get("num_skip_start_steps", 5)),
            "--weight_dtype", "bfloat16",
            "--sample_size", str(sample_size[0]), str(sample_size[1]),
            "--fps", str(inp.get("fps", 25)),
            "--shift", "5.0",
            "--fsdp_dit",
        ]
        if use_dynamic_cfg:
            args.append("--use_dynamic_cfg")
        if use_dynamic_acfg:
            args.append("--use_dynamic_acfg")

        env = dict(os.environ, PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True")
        t0 = time.time()
        proc = subprocess.run(
            args, cwd=REPO_DIR, env=env,
            capture_output=True, text=True, timeout=1800,
        )
        render_seconds = round(time.time() - t0, 1)

        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or "")[-2000:]
            return {"ok": False, "error": f"infer_flash.py exit {proc.returncode}", "log_tail": tail,
                    "render_seconds": render_seconds}

        mp4s = [f for f in os.listdir(out_dir) if f.endswith(".mp4")]
        if not mp4s:
            tail = (proc.stdout or "")[-2000:]
            return {"ok": False, "error": "no mp4 produced", "log_tail": tail,
                    "render_seconds": render_seconds}

        out_path = os.path.join(out_dir, mp4s[0])
        out_bytes = os.path.getsize(out_path)
        print(f"[handler] render done in {render_seconds}s — {out_bytes} bytes")

        with open(out_path, "rb") as f:
            put = requests.put(inp["output_put_url"], data=f,
                               headers={"Content-Type": "video/mp4"}, timeout=300)
        put.raise_for_status()

        return {"ok": True, "render_seconds": render_seconds,
                "output_bytes": out_bytes, "uploaded": True}

    except Exception as e:  # surfaced verbatim in the RunPod job status
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
