---
name: Gate Pipeline Implementation — Core Build
description: The most important development in the project. Full gate worker system, QA agents, job ID spine, monitoring/recovery. Scales CWN from local to Render/Customer 1.
type: project
---

This is the highest-priority implementation in the project. Everything here was formally designed and approved by Rob on 2026-04-18 before any code was written.

**Why:** This takes AuraFlux from small-time Customer 0 operations to a scalable platform that can serve Customer 1 at Render.

## What Gets Built (Customer 0 + Platform Foundation)

- Gate 0 — Gemini source confirmation (new, doesn't exist yet)
- Script scaffold system — system generates scene headers, Gemini fills dialogue only → structural failures impossible
- Gate 1 — narrows to style-only QA (structure is system-guaranteed)
- Gate 3 split — 3a (Gemini qualitative) + 3b (Claude commitment verification, reads reports not video)
- Gate 4 — full video broadcast ready → upload signal (reframed from current)
- Gate 5 — upload confirmation, code only, binary
- Inter-gate intelligence — every gate reads all prior gate reports, adds upstreamContext block
- Commitment model — every stage declares what it will produce before credits burn
- Pre-publish validator — platform API limits hard gate before upload fires
- Job Spec schema + DB save at job start
- canProduce() + selfTest() on all stages
- fetchWithRetry() + source adapter layer
- Post-assembly review in dashboard
- Monitoring → Claude Code escalation path
- Job ID spine across all systems

## What Is Deferred (Customer 1 Only)

- Pre-Generate AI agent (intake conversation)
- Commitment approval UI (Approve/Adjust/Cancel buttons)
- Gemini orchestration signal
- Scheduling UI with suggested times
- Template feedback loop
- Provider interface abstraction
- Next.js app (app.auraflux.co)

## QA Agent Contract

QA agents (Gate 1 Claude, Gate 3b Claude, Gate 4 Gemini) sign off that work hits the commitment spec.

- One sendback per failure. Not rapid fire.
- Sendback includes: what was committed, what was delivered, exactly what doesn't match, surgical fix directive
- Worker gets one attempt to fix against that feedback
- If it fails again → escalate to monitoring with full trail, no third attempt
- Rationale: if a stage committed and can't deliver after one correction, it's a commitment/architecture problem not a production problem. Production retries don't fix architecture problems.

## Job ID Spine

Format: cwn_{contentType}_{formFactor}_{timestamp}
Example: cwn_news_long_1776446778097

- Generated at dashboard at job creation
- Same ID used by: dashboard, Job Spec DB, BullMQ messages, gate worker logs, QA agent reports, errors.jsonl, New Relic custom attributes, sendback messages, escalation events
- Restore keeps same ID — no new ID ever
- Restart from a gate keeps same ID — prior gate outputs preserved in state.savedOutputs

## Gate Worker Three States

Every gate worker answers three questions:
1. On receipt of Job Spec → what do I commit to produce? (commit())
2. While waiting → canProduce() self-checks, monitor upstream, stay ready
3. On go signal → execute against commitment, output must match what I declared

## Monitoring → Claude Code Escalation

If a worker hits something outside their control (API down, corrupt file, CDN expired):
- monitoring fires to Claude Code + sub-agents
- Claude Code runs recovery decision tree: fix and restore → or → kill cleanly and restart from furthest recoverable gate
- Kill cleanly = mark failed in DB, write full gate trail to errors.jsonl, release BullMQ locks, DO NOT delete produced outputs
- Restart uses same job ID, reads committed outputs from prior gates from state.savedOutputs

## Sub-Agent Rules for This Build

- Claude Code architects and QA's all sub-agent work
- Sub-agents implement and commit
- Claude Code reviews every sub-agent output before it is considered done
- No rapid fire — sub-agent gets one correction with full context, if it fails again Claude Code fixes it directly
- No changes to existing system aside from what is needed to implement the spec

## Publish/Pre-Publish

Documented in:
- docs/handoffs/CLINE_HANDOFF_PUBLISH_SYSTEM_OVERHAUL.md — Sub-Agent B task
- docs/specs/PUBLISH_COPY_SPEC.md — authoritative format
- docs/architecture/PIPELINE_CONTRACT_SPEC.md — Gate 4/5 publish package audit

Pre-publish validator is a hard gate — any platform API limit violation blocks upload until corrected.
