# CPD-990 — EchoMimicV3-Flash RunPod serverless worker.
#
# Every pin and uninstall in here was paid for during the CPD-881 spike
# (HOW page: Confluence 31555587, "Engineering gotchas"). Do NOT "clean up"
# the version pins or reorder the install steps without re-running the spike.
#
# Weights are NOT baked: GHCR rejects layers >10GB and the weights are ~22GB.
# They live on a RunPod network volume (populate with populate_volume.sh),
# mounted by serverless at /runpod-volume — handler reads MODELS_DIR env
# (default /runpod-volume/models). Image is ~10GB: CUDA runtime + torch stack.

FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

# PIP_PREFER_BINARY: transitive deps (e.g. stringzilla) otherwise fall back to
# multi-GB gcc source builds that OOM the remote kaniko builder. The validated
# pins live in constraints.txt and are unaffected.
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    HF_HUB_ENABLE_HF_TRANSFER=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_PREFER_BINARY=1

RUN rm -f /var/lib/dpkg/statoverride 2>/dev/null || true && \
    apt-get update -qq && \
    apt-get install -y -qq python3.11 python3.11-venv python3-pip ffmpeg git curl && \
    ln -sf /usr/bin/python3.11 /usr/local/bin/python && \
    python -m pip install --upgrade pip && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# ── 1. Pinned torch cu124 stack FIRST (spike gotcha: upstream requirements.txt
#       resolves torch→2.12 which breaks torchaudio ABI + exceeds host drivers) ──
RUN pip install \
    torch==2.4.1 torchvision==0.19.1 torchaudio==2.4.1 \
    --index-url https://download.pytorch.org/whl/cu124

# ── 2. EchoMimicV3 repo + its requirements, CONSTRAINED so the resolver can
#       never move torch/transformers/diffusers/numpy off the validated pins ──
RUN git clone --depth 1 https://github.com/antgroup/echomimic_v3.git
COPY constraints.txt /workspace/constraints.txt
RUN pip install -r echomimic_v3/requirements.txt -c constraints.txt && \
    pip install -c constraints.txt \
      pyloudnorm "huggingface_hub[hf_transfer]" runpod requests

# ── 3. Spike gotchas: TF registers cuDNN 8 factories in-process (breaks torch
#       cuDNN 9 at first conv3d); cu13 nvidia wheels share the site-packages/nvidia
#       tree with cu12 (last writer wins, wrong cuDNN dlopened) ──
RUN pip uninstall -y tensorflow retina-face 2>/dev/null; \
    pip list 2>/dev/null | awk '/^nvidia-.*cu13/{print $1}' | xargs -r pip uninstall -y; \
    pip install nvidia-cudnn-cu12==9.1.0.70

# ── 4. Weights are downloaded to the network volume by populate_volume.sh
#       (NOT baked — see header). The wav2vec2 .bin→safetensors conversion
#       (transformers >=4.53 CVE-2025-32434 check) happens there too. ──

# ── 5. Build-time smoke: imports resolve against the pinned stack ──
RUN python -c "import torch, transformers, diffusers; \
print('torch', torch.__version__, '| transformers', transformers.__version__, '| diffusers', diffusers.__version__)"

COPY handler.py /workspace/handler.py
COPY http_server.py /workspace/http_server.py

# Default: serverless handler. Pod mode: override CMD to http_server.py
CMD ["python", "-u", "/workspace/handler.py"]
