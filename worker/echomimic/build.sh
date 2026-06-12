#!/bin/bash
# CPD-990 — build + push the EchoMimicV3 worker image.
#
# The image is ~30GB (22GB baked weights) — build on a machine with fast
# uplink (or a RunPod CPU pod / depot.dev) rather than home broadband.
#
# Usage:
#   REGISTRY=docker.io/yourname bash build.sh          # build + push
#   REGISTRY=docker.io/yourname NO_PUSH=1 bash build.sh # build only
set -euo pipefail
cd "$(dirname "$0")"

REGISTRY="${REGISTRY:?set REGISTRY, e.g. docker.io/youruser}"
TAG="${TAG:-$(date +%Y%m%d)}"
IMAGE="${REGISTRY}/cwn-echomimic-worker:${TAG}"

# linux/amd64 is mandatory — RunPod GPU hosts are x86_64, and an arm64 image
# built on an M-series Mac will pull fine then crash at container start.
docker build --platform linux/amd64 \
  ${HF_TOKEN:+--build-arg HF_TOKEN=$HF_TOKEN} \
  -t "$IMAGE" .

echo "built: $IMAGE"
[ "${NO_PUSH:-0}" = "1" ] && exit 0

docker push "$IMAGE"
echo ""
echo "Pushed. Next steps:"
echo "1. RunPod console → Serverless → New Endpoint"
echo "   image: $IMAGE | GPU: A40 48GB (validated) or L40S | workers: 0 min / 1-2 max"
echo "   container disk: 40GB | idle timeout: 120s (keeps worker warm between scenes)"
echo "2. Put the endpoint id in cwn-c0/.env as ECHOMIMIC_ENDPOINT_ID"
echo "3. Smoke test: node scripts/echomimic_smoke.js (CPD-991)"
