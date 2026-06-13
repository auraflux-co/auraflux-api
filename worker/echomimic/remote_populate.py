"""CPD-990 — populate the RunPod network volume with EchoMimicV3 weights.

Runs ON a RunPod CPU pod with the network volume mounted at /workspace.
Fetched + exec'd by the pod start command (see STATUS.md remote-build notes);
env: LOG_PUT (presigned PUT for log), DONE_PUT (presigned PUT for done marker).

Downloads ~22GB from HuggingFace on the datacenter pipe, converts wav2vec2
.bin -> safetensors (transformers >=4.53 CVE-2025-32434 refuses .bin on
torch <2.6), writes /workspace/models/.done.
"""
import os
import threading
import time
import traceback
import urllib.request

MODELS = "/workspace/models"
LOG_PATH = "/tmp/populate.log"
_log_lock = threading.Lock()


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with _log_lock, open(LOG_PATH, "a") as f:
        f.write(line + "\n")


def push(url, path_or_bytes):
    data = path_or_bytes if isinstance(path_or_bytes, bytes) else open(path_or_bytes, "rb").read()
    req = urllib.request.Request(url, data=data, method="PUT",
                                 headers={"Content-Type": "text/plain"})
    urllib.request.urlopen(req, timeout=60)


def log_pusher():
    while True:
        time.sleep(20)
        try:
            if os.path.exists(LOG_PATH):
                push(os.environ["LOG_PUT"], LOG_PATH)
        except Exception:
            pass


def main():
    threading.Thread(target=log_pusher, daemon=True).start()
    os.makedirs(MODELS, exist_ok=True)
    os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "1"
    # Keep the HF blob cache on the (large) volume, not the small container disk.
    os.environ["HF_HOME"] = "/workspace/hf_cache"

    from huggingface_hub import snapshot_download

    for repo, kwargs in [
        ("alibaba-pai/Wan2.1-Fun-V1.1-1.3B-InP", {"local_dir": f"{MODELS}/Wan2.1-Fun-V1.1-1.3B-InP"}),
        ("TencentGameMate/chinese-wav2vec2-base", {"local_dir": f"{MODELS}/chinese-wav2vec2-base"}),
        ("BadToBest/EchoMimicV3", {"allow_patterns": ["echomimicv3-flash-pro/*"], "local_dir": f"{MODELS}/em3"}),
    ]:
        log(f"downloading {repo} ...")
        t0 = time.time()
        snapshot_download(repo, **kwargs)
        log(f"  done in {time.time() - t0:.0f}s")

    log("converting wav2vec2 .bin -> safetensors ...")
    import torch
    from safetensors.torch import save_file
    sd = torch.load(f"{MODELS}/chinese-wav2vec2-base/pytorch_model.bin",
                    map_location="cpu", weights_only=True)
    save_file({k: v.contiguous() for k, v in sd.items()},
              f"{MODELS}/chinese-wav2vec2-base/model.safetensors")
    log("converted")

    # HF blob cache lives on the volume too (HF_HOME env) — drop it so the
    # volume holds only the models.
    hf_home = os.environ.get("HF_HOME")
    if hf_home and os.path.isdir(hf_home):
        import shutil
        shutil.rmtree(hf_home, ignore_errors=True)
        log("hf cache cleaned")

    total = 0
    for root, _, files in os.walk(MODELS):
        for f in files:
            total += os.path.getsize(os.path.join(root, f))
    log(f"volume populated: {total / 1e9:.1f} GB under {MODELS}")

    with open(f"{MODELS}/.done", "w") as f:
        f.write(str(int(time.time())))
    push(os.environ["DONE_PUT"], b"ok")
    push(os.environ["LOG_PUT"], LOG_PATH)
    log("DONE marker pushed — pod can be terminated")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log("FATAL:\n" + traceback.format_exc())
        try:
            push(os.environ["LOG_PUT"], LOG_PATH)
        except Exception:
            pass
        raise
