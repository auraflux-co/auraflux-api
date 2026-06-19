# Broadcast on Render — execution gate (CPD-1040)

**Status:** EXECUTING — Rob go signal 2026-06-19 ~6:30pm ET (7pm grid target).

## Links

| Resource | URL |
|----------|-----|
| Epic | https://aurafluxco.atlassian.net/browse/CPD-1040 |
| Confluence HOW | https://aurafluxco.atlassian.net/wiki/spaces/CP/pages/35094530 |
| Local runbook | `docs/ops/AURAFLUX_BROADCAST_RENDER.md` |
| Branch (uncommitted scaffold) | `feat/cpd-1040-auraflux-broadcast` |

## When Rob says "go"

1. **CPD-1041** — commit R0 scaffold, PR → `staging`
2. **CPD-1042** — Doppler broadcast-staging secrets before first GO LIVE
3. Blueprint sync → create `auraflux-broadcast-staging`
4. Manual deploy + health check
5. Then **CPD-1043** middleware port, etc.

## What is NOT in scope until go signal

- No Render deploy
- No merge to staging/main
- No pm2 changes on c0 for grid cutover

## Ticket index (all under CPD-1040)

| Key | Phase | Summary |
|-----|-------|---------|
| CPD-1041 | R0 | Docker + staging service |
| CPD-1042 | R0 | Doppler env manifest |
| CPD-1043 | R1 | Port C0 live_grid + middleware |
| CPD-1044 | R2 | No `.env` persistence on Render |
| CPD-1045 | R2 | Wire LIVE_SIDECAR_URL on API |
| CPD-1046 | R2 | Grid scheduler on Render API |
| CPD-1047 | R2 | Split grid vs TV proxy |
| CPD-1048 | R3 | Remote ops/health |
| CPD-1049 | R3 | Dashboard E2E |
| CPD-1050 | R4 | Staging soak |
| CPD-1051 | R4 | Production cutover |
| CPD-1052 | R5 | Optional auraflux-app UI |

**Wrong ticket ID:** Do not commit broadcast work as `cpd-1037` (Pipeline Parity hub).
