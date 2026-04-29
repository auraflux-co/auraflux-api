# Aider Task — Platform Adapter Pattern Audit + Pressure Test

**Created:** 2026-04-29  
**Priority:** Medium  
**Estimated time:** 1–2 hours  
**Run when:** Tonight / next Aider session

---

## Background

AuraFlux has adopted a platform adapter pattern as its architectural standard for all
integrations (publish, shoppable, content sources, video generation). The rule is:

- Core logic is platform-agnostic — no platform names in business logic
- Each platform lives in its own adapter file under `lib/<feature>/adapters/`
- Adding a new platform = new adapter file only, no core changes

The Cursor rule is at `.cursor/rules/platform-adapter-pattern.mdc`.

---

## Task

### 1. Audit existing integrations for violations

Scan the following files for platform-specific logic that lives outside an adapter layer:

- `lib/publish.js` — check for hardcoded `youtube`, `tiktok`, `instagram` branches
- `lib/routes/publish.js` — same
- `lib/routes/video.js` — check for WAN/Kling/RunPod hardcoding
- `lib/ai/runpod.js` — check if it's clean or has model-specific branches
- `server.js` — check VectCutClient for any platform-specific paths

For each violation found, document it as:
```
FILE: lib/publish.js
LINE: 142
VIOLATION: if (platform === 'youtube') block in core publish logic
SEVERITY: high | medium | low
FIX: extract to lib/publish/adapters/youtube.js
```

Write findings to: `docs/reports/platform_adapter_audit_<timestamp>.md`

---

### 2. Assess refactor effort for lib/publish.js

`lib/publish.js` is the most likely candidate for violations. Assess:

- Does it have per-platform branches today?
- How much effort to refactor to `lib/publish/index.js` + `adapters/` structure?
- Are there any risks (Upload-Post wraps all 3 platforms today — is that already an adapter)?

Document the refactor plan if violations exist. Do NOT refactor yet — just plan.

---

### 3. Write a unit test harness for the adapter contract

Create `test/platform_adapter.test.js` that:

- Defines the expected adapter contract interface (inputs + output shape)
- Imports each existing adapter (or stubs where adapters don't exist yet)
- Verifies each adapter exports a function matching the contract
- Verifies no adapter imports platform names from other adapters (isolation check)

This test should be runnable with `npm test` and fail loudly if someone adds
a platform violation in future.

---

### 4. Create Jira tickets for any HIGH severity violations

For each HIGH severity violation found in step 1, create a Jira ticket in CPD project:
- Type: Task
- Epic: CPD-13 (Gate System Hardening) if pipeline-related, or a new "Platform Architecture" epic
- Title: `refactor(<file>): extract <platform> logic to adapter`
- Summary: include file, line, and fix description from the audit report

---

## Definition of Done

- [ ] Audit report written to `docs/reports/`
- [ ] `test/platform_adapter.test.js` exists and passes (or stubs cleanly)
- [ ] Jira tickets created for HIGH violations
- [ ] No code changes made to production files — audit and plan only
