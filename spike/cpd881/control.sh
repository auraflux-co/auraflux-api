#!/bin/bash
# CPD-881 spike — EchoMimicV3-Flash on a RunPod GPU pod.
# Downloaded + executed in a loop by the pod's start command. Idempotent:
# each phase writes a marker file in /workspace/state so re-runs skip done work.
# Presigned URLs arrive via pod env: IMG_URL, AUD_A_URL, AUD_B_URL, AUD_C_URL,
# OUT_A_PUT, OUT_B_PUT, OUT_C_PUT, DONE_PUT.
set -u
cd /workspace
S=/workspace/state
mkdir -p "$S" models inputs outputs
log(){ echo "[$(date -u +%H:%M:%S)] $*"; }

if [ ! -f "$S/sysinfo.done" ]; then
  nvidia-smi --query-gpu=name,memory.total --format=csv || true
  python --version; pip --version
  touch "$S/sysinfo.done"
fi

if [ ! -f "$S/apt.done" ]; then
  log "apt: installing ffmpeg + git"
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq ffmpeg git >/dev/null 2>&1
  touch "$S/apt.done"; log "apt done"
fi

if [ ! -f "$S/clone.done" ]; then
  rm -rf echomimic_v3
  git clone --depth 1 https://github.com/antgroup/echomimic_v3.git || exit 1
  touch "$S/clone.done"; log "clone done"
fi

if [ ! -f "$S/pip.done" ]; then
  log "pip install start (this takes several minutes)"
  cd echomimic_v3
  pip install -q -r requirements.txt pyloudnorm "huggingface_hub[hf_transfer]" || { log "pip FAILED"; exit 1; }
  cd ..
  touch "$S/pip.done"; log "pip done"
fi

# pip resolver upgraded torch to 2.12 (breaks torchaudio ABI + needs newer
# driver than the host has). Re-pin the cu124 stack + era-matched HF libs.
if [ ! -f "$S/fixstack.done" ]; then
  log "fixstack: re-pin torch cu124 stack"
  pip install -q torch==2.4.1 torchvision==0.19.1 torchaudio==2.4.1 --index-url https://download.pytorch.org/whl/cu124 || { log "fixstack torch FAILED"; exit 1; }
  pip install -q "transformers==4.53.3" "diffusers==0.34.0" "numpy<2" || { log "fixstack hf libs FAILED"; exit 1; }
  touch "$S/fixstack.done"; log "fixstack done"
fi

# tensorflow (pulled in by retina-face, unused on the infer path) registers its
# bundled cuDNN 8 factories in-process and breaks torch's cuDNN 9 init
# (CUDNN_STATUS_NOT_INITIALIZED at the first conv3d). Remove it.
if [ ! -f "$S/fixtf.done" ]; then
  log "fixtf: removing tensorflow/retina-face + pinning cudnn9"
  pip uninstall -y -q tensorflow retina-face 2>/dev/null
  pip install -q nvidia-cudnn-cu12==9.1.0.70
  python -c "import torch; print('cudnn version:', torch.backends.cudnn.version())"
  touch "$S/fixtf.done"; log "fixtf done"
fi

# The aborted torch-2.12 install left nvidia-*-cu13 packages that share the
# site-packages/nvidia/ file tree with the cu12 ones — last writer wins, so
# torch 2.4 was dlopening cuDNN 9.20 built for CUDA 13. Purge cu13, restore cu12.
if [ ! -f "$S/fixcu13.done" ]; then
  log "fixcu13: purging cu13 nvidia packages"
  pip list 2>/dev/null | awk '/^nvidia-.*cu13/{print $1}' | xargs -r pip uninstall -y -q
  pip install -q --force-reinstall --no-deps \
    nvidia-cudnn-cu12==9.1.0.70 nvidia-cublas-cu12==12.4.5.8 nvidia-cufft-cu12==11.2.1.3 \
    nvidia-curand-cu12==10.3.5.147 nvidia-cusolver-cu12==11.6.1.9 nvidia-cusparse-cu12==12.3.1.170 \
    nvidia-cuda-runtime-cu12==12.4.127 nvidia-cuda-nvrtc-cu12==12.4.127 nvidia-cuda-cupti-cu12==12.4.127 \
    nvidia-nvjitlink-cu12==12.4.127 nvidia-nccl-cu12==2.20.5 || { log "fixcu13 FAILED"; exit 1; }
  rm -f "$S/cudnnsmoke.done"
  touch "$S/fixcu13.done"; log "fixcu13 done"
fi

if [ ! -f "$S/cudnnsmoke.done" ]; then
  log "cudnn smoke test (conv3d on cuda)"
  echo "LD_LIBRARY_PATH=$LD_LIBRARY_PATH"
  pip list 2>/dev/null | grep -i cudnn
  python - <<'PYEOF'
import torch, torch.nn as nn
print('torch', torch.__version__, 'cudnn', torch.backends.cudnn.version())
x = torch.randn(1, 3, 8, 64, 64, device='cuda')
c = nn.Conv3d(3, 8, 3).cuda()
print('conv3d ok:', c(x).shape)
PYEOF
  log "cudnn smoke rc=$?"
  touch "$S/cudnnsmoke.done"
fi

hfdl(){ hf download "$@" 2>/dev/null || huggingface-cli download "$@"; }

if [ ! -f "$S/weights.done" ]; then
  log "weights download start"
  export HF_HUB_ENABLE_HF_TRANSFER=1
  hfdl alibaba-pai/Wan2.1-Fun-V1.1-1.3B-InP --local-dir models/Wan2.1-Fun-V1.1-1.3B-InP || { log "wan base dl FAILED"; exit 1; }
  hfdl TencentGameMate/chinese-wav2vec2-base --local-dir models/chinese-wav2vec2-base || { log "wav2vec dl FAILED"; exit 1; }
  hfdl BadToBest/EchoMimicV3 --include "echomimicv3-flash-pro/*" --local-dir models/em3 || { log "flash weights dl FAILED"; exit 1; }
  touch "$S/weights.done"; log "weights done"
  df -h /workspace | tail -1
fi

# transformers >=4.53 refuses torch.load on .bin checkpoints with torch<2.6
# (CVE-2025-32434). wav2vec2 only ships pytorch_model.bin — convert to safetensors.
if [ ! -f "$S/convert_wav2vec.done" ] && [ -f "$S/weights.done" ]; then
  log "converting wav2vec2 .bin -> safetensors"
  python - <<'PYEOF' || { log "wav2vec convert FAILED"; exit 1; }
import torch
from safetensors.torch import save_file
sd = torch.load('/workspace/models/chinese-wav2vec2-base/pytorch_model.bin', map_location='cpu', weights_only=True)
sd = {k: v.contiguous() for k, v in sd.items()}
save_file(sd, '/workspace/models/chinese-wav2vec2-base/model.safetensors')
print('converted', len(sd), 'tensors')
PYEOF
  touch "$S/convert_wav2vec.done"; log "wav2vec convert done"
fi

if [ ! -f "$S/inputs.done" ]; then
  log "fetching inputs"
  curl -sf -o inputs/bobbyg_studio.png "$IMG_URL" || { log "img fetch FAILED"; exit 1; }
  curl -sf -o inputs/audio_A.wav "$AUD_A_URL" || { log "audio A fetch FAILED"; exit 1; }
  curl -sf -o inputs/audio_B.wav "$AUD_B_URL" || { log "audio B fetch FAILED"; exit 1; }
  curl -sf -o inputs/audio_C.wav "$AUD_C_URL" || { log "audio C fetch FAILED"; exit 1; }
  touch "$S/inputs.done"; log "inputs done"
fi

PROMPT="A bearded man in a tan blazer over a black t-shirt sits at a desk in a streaming studio, a purple neon world map glowing on the wall behind him, a broadcast microphone on an arm at frame left. He speaks naturally to the camera. Hand and body movements are minimal and consistent with a natural speaking posture. Don't blink too often. Preserve background integrity matching the reference image's spatial configuration, lighting conditions, and color temperature."

cd /workspace/echomimic_v3
for X in A B C; do
  [ -f "$S/render_$X.done" ] && continue
  cp ../inputs/bobbyg_studio.png "../inputs/bobbyg_$X.png"
  rm -f "/workspace/outputs/bobbyg_${X}_output.mp4"
  log "render $X start"
  T0=$(date +%s)
  nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader || true
  PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True python infer_flash.py \
    --image_path "../inputs/bobbyg_$X.png" \
    --audio_path "../inputs/audio_$X.wav" \
    --prompt "$PROMPT" \
    --num_inference_steps 8 \
    --config_path config/config.yaml \
    --model_name /workspace/models/Wan2.1-Fun-V1.1-1.3B-InP \
    --transformer_path /workspace/models/em3/echomimicv3-flash-pro/diffusion_pytorch_model.safetensors \
    --save_path /workspace/outputs \
    --wav2vec_model_dir /workspace/models/chinese-wav2vec2-base \
    --sampler_name Flow_Unipc \
    --video_length 81 \
    --guidance_scale 4.5 \
    --audio_guidance_scale 2.0 \
    --audio_scale 1.0 \
    --neg_scale 1.0 \
    --neg_steps 0 \
    --seed 43 \
    --teacache_threshold 0.1 \
    --num_skip_start_steps 5 \
    --weight_dtype bfloat16 \
    --sample_size 768 768 \
    --fps 25 \
    --shift 5.0 \
    --fsdp_dit
  T1=$(date +%s)
  if [ -f "/workspace/outputs/bobbyg_${X}_output.mp4" ]; then
    log "render $X done in $((T1-T0))s"
    touch "$S/render_$X.done"
  else
    log "render $X FAILED after $((T1-T0))s"
    exit 1
  fi
done
cd /workspace

if [ ! -f "$S/upload.done" ] && [ -f "$S/render_A.done" ] && [ -f "$S/render_B.done" ] && [ -f "$S/render_C.done" ]; then
  log "uploading outputs"
  curl -sf -X PUT -T outputs/bobbyg_A_output.mp4 "$OUT_A_PUT" || { log "upload A FAILED"; exit 1; }
  curl -sf -X PUT -T outputs/bobbyg_B_output.mp4 "$OUT_B_PUT" || { log "upload B FAILED"; exit 1; }
  curl -sf -X PUT -T outputs/bobbyg_C_output.mp4 "$OUT_C_PUT" || { log "upload C FAILED"; exit 1; }
  echo "spike complete $(date -u)" > /tmp/done.txt
  curl -sf -X PUT -T /tmp/done.txt "$DONE_PUT" || true
  touch "$S/upload.done"
  log "SPIKE COMPLETE — outputs uploaded"
fi
