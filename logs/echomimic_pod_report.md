# EchoMimic Pod Report

Generated: 2026-06-14T05:19:43.112Z
Window: last 14 days

## Reliability

| Metric | Count | Rate |
|--------|------:|-----:|
| Pod wake attempts | 0 | |
| Pod wake failures | 0 | — |
| GPU start failures (→ recreate pod) | 1 | — |
| Fresh pods created | 2 | |
| Render OK | 3 | 75.0% |
| Render fail | 1 | 25.0% |
| Mouth sweep OK (artifact) | 7 | |
| Mouth sweep fail (artifact) | 28 | 80.0% |

### Top errors

- **1×** `There are not enough free GPUs on the host machine to start this pod.`
- **1×** `infer_flash.py exit 1`

### GPU types seen

- NVIDIA GeForce RTX 4090: 4 events
- NVIDIA GeForce RTX 5090: 3 events

## Latency (RunPod baseline)

| Metric | p50 |
|--------|----:|
| Pod wake (incl. health) | 240s |
| Render wall clock / window | 126.3s |
| GPU infer (worker render_seconds) | 126.3s |

## Cost / speed vs alternatives (estimates)

Per ~2.5s clip at 126s GPU + 240s wake amortized over 7 windows:

| Provider | $/hr | Est. speed vs 4090 | Est. cost / 7-scene job | Notes |
|----------|-----:|-------------------:|------------------------:|-------|
| RunPod RTX 4090 (current) | $0.34 | 1.0× (baseline) | $0.11 | Measured baseline |
| RunPod L40S | $0.79 | 1.0× (baseline) | $0.25 | Same class — estimate until benchmark |
| Lambda Labs 4090 | $0.55 | 1.0× (baseline) | $0.17 | Estimate — run same gate script to measure |
| AWS g5 A10G | $1.05 | 0.95× | $0.31 | Often ~same infer; ~3× cost; better availability |
| CoreWeave H100 | $2.49 | 0.7× | $0.54 | Overkill for Flash 1.3B — faster but expensive |

> **Speed mults are placeholders** until the same `avatar_clone_gate.js` run completes on an alternative provider. Availability (start failures) is the main RunPod pain today.

## Migration trigger (suggested)

- **Stay on RunPod** if: render fail rate < 5% and start fail rate < 10% over 7 days
- **Spike Lambda/CoreWeave** if: start fail rate > 20% OR repeated wrong-GPU provisions (5090)
- **AWS g5** if: availability still blocks production jobs after specialist clouds tried

Raw metrics: `logs/echomimic_pod_metrics.jsonl`