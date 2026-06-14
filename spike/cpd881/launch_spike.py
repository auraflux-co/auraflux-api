#!/usr/bin/env python3
"""CPD-881 spike launcher.

Uploads spike inputs + control.sh to R2, presigns GET/PUT URLs, then creates
a RunPod GPU pod whose start command loops: fetch control.sh -> run -> push log.

Usage:
  python3 launch_spike.py            # upload + create pod
  python3 launch_spike.py --presign  # only (re)upload + print URLs
"""
import json
import os
import sys
import urllib.request

import boto3
from botocore.config import Config

ROOT = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(ROOT, "..", "..", ".env")
PREFIX = "spike/cpd881"
EXPIRY = 86400  # 24h


def load_env(path):
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def main():
    env = load_env(ENV_PATH)
    bucket = env.get("R2_VIDEO_BUCKET", "auraflux-video-output")
    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://{env['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=env["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4", region_name="auto"),
    )

    uploads = {
        "control.sh": os.path.join(ROOT, "control.sh"),
        "inputs/bobbyg_studio.png": os.path.join(ROOT, "inputs", "bobbyg_studio.png"),
        "inputs/audio_A.wav": os.path.join(ROOT, "inputs", "audio_A_short_hook.wav"),
        "inputs/audio_B.wav": os.path.join(ROOT, "inputs", "audio_B_vod_intro.wav"),
        "inputs/audio_C.wav": os.path.join(ROOT, "inputs", "audio_C_emotional_read.wav"),
    }
    for key, path in uploads.items():
        s3.upload_file(path, bucket, f"{PREFIX}/{key}")
        print(f"uploaded {PREFIX}/{key}")

    def get_url(key):
        return s3.generate_presigned_url(
            "get_object", Params={"Bucket": bucket, "Key": f"{PREFIX}/{key}"}, ExpiresIn=EXPIRY
        )

    def put_url(key):
        return s3.generate_presigned_url(
            "put_object", Params={"Bucket": bucket, "Key": f"{PREFIX}/{key}"}, ExpiresIn=EXPIRY
        )

    urls = {
        "CTRL_URL": get_url("control.sh"),
        "IMG_URL": get_url("inputs/bobbyg_studio.png"),
        "AUD_A_URL": get_url("inputs/audio_A.wav"),
        "AUD_B_URL": get_url("inputs/audio_B.wav"),
        "AUD_C_URL": get_url("inputs/audio_C.wav"),
        "LOG_PUT": put_url("log.txt"),
        "OUT_A_PUT": put_url("outputs/out_A.mp4"),
        "OUT_B_PUT": put_url("outputs/out_B.mp4"),
        "OUT_C_PUT": put_url("outputs/out_C.mp4"),
        "DONE_PUT": put_url("done.txt"),
    }
    # Poll URLs for the orchestrator (this machine) to watch progress / fetch results.
    poll = {
        "log": get_url("log.txt"),
        "done": get_url("done.txt"),
        "out_A": get_url("outputs/out_A.mp4"),
        "out_B": get_url("outputs/out_B.mp4"),
        "out_C": get_url("outputs/out_C.mp4"),
    }
    with open(os.path.join(ROOT, "poll_urls.json"), "w") as f:
        json.dump(poll, f, indent=2)
    print("poll URLs written to poll_urls.json")

    if "--presign" in sys.argv:
        return

    runner = (
        "mkdir -p /workspace && touch /tmp/log.txt && while true; do "
        'curl -sf "$CTRL_URL" -o /tmp/ctrl.sh && bash /tmp/ctrl.sh >>/tmp/log.txt 2>&1; '
        "tail -c 500000 /tmp/log.txt > /tmp/log_up.txt; "
        'curl -sf -X PUT -T /tmp/log_up.txt "$LOG_PUT" >/dev/null 2>&1; '
        "sleep 20; done"
    )
    body = {
        "name": "cpd881-echomimic-spike",
        "imageName": "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
        "cloudType": "SECURE",
        "gpuTypeIds": [
            "NVIDIA GeForce RTX 4090",
            "NVIDIA RTX 6000 Ada Generation",
            "NVIDIA L40S",
            "NVIDIA A40",
        ],
        "gpuCount": 1,
        "containerDiskInGb": 100,
        "volumeInGb": 0,
        "env": urls,
        "dockerStartCmd": ["bash", "-c", runner],
    }
    req = urllib.request.Request(
        "https://rest.runpod.io/v1/pods",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {env['RUNPOD_API_KEY']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            resp = json.load(r)
    except urllib.error.HTTPError as e:
        print(f"POD CREATE FAILED {e.code}: {e.read().decode()[:2000]}")
        sys.exit(1)
    print(json.dumps(resp, indent=2))
    with open(os.path.join(ROOT, "pod.json"), "w") as f:
        json.dump(resp, f, indent=2)


if __name__ == "__main__":
    main()
