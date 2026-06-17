#!/usr/bin/env python3
"""Idempotent ip_mask patches for EchoMimic V3 Flash on the RunPod worker.

Patches /workspace/echomimic_v3 in place:
  - infer_flash.py — accept --ip_mask_coords, build mask tensor
  - pipeline_wan_fun_inpaint_audio_2512.py — pass ip_mask to transformer
  - wan_transformer3d_audio_2512.py — get_audio_mask() gates audio cross-attn

Safe to re-run (marker comments).
"""
from __future__ import annotations

import os
import subprocess
import sys

REPO = os.environ.get("ECHOMIMIC_REPO", "/workspace/echomimic_v3")
MARKER = "/workspace/state/ip_mask_patches.done"
FACE_VENV = "/workspace/face_detect_venv"


def patch_file(path: str, old: str, new: str, label: str) -> None:
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if new in text:
        print(f"[patch] {label}: already applied")
        return
    if old not in text:
        raise RuntimeError(f"{label}: expected snippet not found in {path}")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text.replace(old, new, 1))
    print(f"[patch] {label}: applied")


def patch_infer_flash() -> None:
    path = os.path.join(REPO, "infer_flash.py")
    patch_file(
        path,
        '    parser.add_argument("--mouth_prompts", type=str, default=None, help="Mouth prompts")\n',
        '    parser.add_argument("--mouth_prompts", type=str, default=None, help="Mouth prompts")\n'
        '    parser.add_argument("--ip_mask_coords", type=str, default=None,\n'
        '                        help="JSON face bbox from face_detect_subprocess.py")\n',
        "infer_flash argparse",
    )
    patch_file(
        path,
        "    shift = args.shift\n",
        "    shift = args.shift\n    ip_mask_coords = args.ip_mask_coords\n",
        "infer_flash ip_mask_coords var",
    )
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if "import math" not in text.split("def main")[0]:
        patch_file(
            path,
            "import decord\nimport json\nimport random",
            "import decord\nimport json\nimport math\nimport random",
            "infer_flash import math",
        )
    else:
        print("[patch] infer_flash import math: already present")
    old_block = (
        "        input_video, input_video_mask, clip_image = get_image_to_video_latent2("
        "validation_image_start, validation_image_end, video_length=video_length_actual, "
        "sample_size=[sample_size_0, sample_size_1])\n\n        sample = pipeline("
    )
    new_block = (
        "        input_video, input_video_mask, clip_image = get_image_to_video_latent2("
        "validation_image_start, validation_image_end, video_length=video_length_actual, "
        "sample_size=[sample_size_0, sample_size_1])\n\n"
        "        ip_mask = None\n"
        "        if ip_mask_coords:\n"
        "            coords_raw = json.loads(ip_mask_coords)\n"
        "            y1, y2, x1, x2, h_, w_ = (\n"
        "                coords_raw['y1'], coords_raw['y2'], coords_raw['x1'], coords_raw['x2'],\n"
        "                coords_raw['height'], coords_raw['width'],\n"
        "            )\n"
        "            downratio = math.sqrt(sample_size_0 * sample_size_1 / h_ / w_)\n"
        "            coords = (\n"
        "                y1 * downratio // 16, y2 * downratio // 16,\n"
        "                x1 * downratio // 16, x2 * downratio // 16,\n"
        "                sample_size_0 // 16, sample_size_1 // 16,\n"
        "            )\n"
        "            ip_mask = get_ip_mask(coords).unsqueeze(0)\n"
        "            ip_mask = torch.cat([ip_mask] * 3).to(device=device, dtype=weight_dtype)\n\n"
        "        sample = pipeline("
    )
    patch_file(path, old_block, new_block, "infer_flash mask build")
    patch_file(path, "            ip_mask = None,\n", "            ip_mask = ip_mask,\n", "infer_flash pipeline ip_mask")


def patch_pipeline() -> None:
    path = os.path.join(REPO, "src/pipeline_wan_fun_inpaint_audio_2512.py")
    patch_file(
        path,
        "context=(prompt_embeds, audio_embeds, latent_model_input.shape[2], None),",
        "context=(prompt_embeds, audio_embeds, latent_model_input.shape[2], ip_mask),",
        "pipeline2512 ip_mask cond",
    )
    patch_file(
        path,
        "context=(prompt_embeds, negative_audio_embeds, latent_model_input.shape[2], None),",
        "context=(prompt_embeds, negative_audio_embeds, latent_model_input.shape[2], ip_mask),",
        "pipeline2512 ip_mask uncond",
    )


def patch_transformer() -> None:
    path = os.path.join(REPO, "src/wan_transformer3d_audio_2512.py")
    if "# CWN get_audio_mask" not in open(path, encoding="utf-8").read():
        patch_file(
            path,
            "    return out\n\ndef sinusoidal_embedding_1d(dim, position):",
            "    return out\n\n"
            "def get_audio_mask(ip_mask, latent_t):\n"
            "    # CWN get_audio_mask — ported from wan_transformer3d_audio.py\n"
            "    if ip_mask is None:\n"
            "        return None\n"
            "    b, n = ip_mask.shape\n"
            "    return ip_mask.repeat_interleave(latent_t, dim=0).view(-1, n, 1, 1)\n\n"
            "def sinusoidal_embedding_1d(dim, position):",
            "transformer get_audio_mask",
        )
    patch_file(
        path,
        "    audio_x = audio_mask_attention(\n"
        "        q_auido.to(dtype),\n"
        "        k_audio.to(dtype),\n"
        "        v_audio.to(dtype),\n"
        "        k_lens=None\n"
        "    ) \n\n    audio_x = audio_x.view(b, latent_t, -1, n, d).view(b, -1, n, d)\n",
        "    audio_x = audio_mask_attention(\n"
        "        q_auido.to(dtype),\n"
        "        k_audio.to(dtype),\n"
        "        v_audio.to(dtype),\n"
        "        k_lens=None\n"
        "    ) \n\n"
        "    audio_mask = get_audio_mask(ip_mask, latent_t)\n"
        "    if audio_mask is not None and audio_mask.size(0) == audio_x.size(0):\n"
        "        audio_x = audio_x * audio_mask\n\n"
        "    audio_x = audio_x.view(b, latent_t, -1, n, d).view(b, -1, n, d)\n",
        "transformer apply audio_mask",
    )


def ensure_face_venv() -> None:
    py = os.path.join(FACE_VENV, "bin", "python")
    if os.path.isfile(py):
        print("[patch] face_detect venv exists")
        return
    print("[patch] creating face_detect venv (tensorflow + retina-face)")
    subprocess.run([sys.executable, "-m", "venv", FACE_VENV], check=True)
    subprocess.run(
        [py, "-m", "pip", "install", "-q", "retina-face==0.0.17", "tensorflow==2.15.0", "pillow", "numpy"],
        check=True,
    )
    print("[patch] face_detect venv ready")


def main() -> None:
    if not os.path.isdir(REPO):
        raise RuntimeError(f"EchoMimic repo missing at {REPO}")
    os.makedirs(os.path.dirname(MARKER), exist_ok=True)
    patch_infer_flash()
    patch_pipeline()
    patch_transformer()
    ensure_face_venv()
    with open(MARKER, "w", encoding="utf-8") as f:
        f.write("ok\n")
    print(f"[patch] complete → {MARKER}")


if __name__ == "__main__":
    main()
