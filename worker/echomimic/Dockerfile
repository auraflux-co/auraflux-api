# CPD-990 — EchoMimicV3-Flash RunPod serverless worker.
#
# Every pin and uninstall in here was paid for during the CPD-881 spike
# (HOW page: Confluence 31555587, "Engineering gotchas"). Do NOT "clean up"
# the version pins or reorder the install steps without re-running the spike.
#
# Image size: ~30GB (22GB weights baked in). Alternative: move /models to a
# RunPod network volume and mount at /models — same paths, smaller image,
# slower cold start on fresh hosts.

FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    HF_HUB_ENABLE_HF_TRANSFER=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update -qq && \
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

# ── 4. Bake weights (~22GB). HF_TOKEN build-arg only needed if rate-limited. ──
ARG HF_TOKEN=""
RUN export HF_TOKEN="${HF_TOKEN}" && \
    mkdir -p /models && \
    python -c "from huggingface_hub import snapshot_download as d; \
d('alibaba-pai/Wan2.1-Fun-V1.1-1.3B-InP', local_dir='/models/Wan2.1-Fun-V1.1-1.3B-InP'); \
d('TencentGameMate/chinese-wav2vec2-base', local_dir='/models/chinese-wav2vec2-base'); \
d('BadToBest/EchoMimicV3', allow_patterns=['echomimicv3-flash-pro/*'], local_dir='/models/em3')"

# ── 5. Spike gotcha: transformers >=4.53 refuses .bin checkpoints on torch <2.6
#       (CVE-2025-32434) — wav2vec2 only ships pytorch_model.bin, convert now ──
RUN python -c "\
import torch; \
from safetensors.torch import save_file; \
sd = torch.load('/models/chinese-wav2vec2-base/pytorch_model.bin', map_location='cpu', weights_only=True); \
save_file({k: v.contiguous() for k, v in sd.items()}, '/models/chinese-wav2vec2-base/model.safetensors'); \
print('wav2vec2 converted to safetensors')"

# ── 6. Build-time smoke: imports resolve against the pinned stack ──
RUN python -c "import torch, transformers, diffusers; \
print('torch', torch.__version__, '| transformers', transformers.__version__, '| diffusers', diffusers.__version__)"

COPY handler.py /workspace/handler.py

CMD ["python", "-u", "/workspace/handler.py"]
