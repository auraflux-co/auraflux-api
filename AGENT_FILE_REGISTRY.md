# AGENT_FILE_REGISTRY.md

**Author:** Claude Code, 2026-04-14  
**Purpose:** Standing file ownership and lock protocol for all agents. Read this before touching any file. Prevents two agents from corrupting the same file simultaneously.  
**Enforced by:** Honor system + STATUS.md lock declarations. Pre-commit hook warns but cannot block concurrent edits.

---

## Agent roster

| Agent | Model | Terminal | Domain | Best for |
|---|---|---|---|---|
| **Cline-A** | Claude Sonnet | Terminal 1 | Backend — pipeline, gates, FFmpeg, assembly, HeyGen | Complex server logic, gate scoring, QA fixes, anything touching the production engine |
| **Cline-B** | DeepSeek | Terminal 2 | Backend — API endpoints, data layer, job persistence | Endpoint additions, `data/jobs.json` schema, publish integration, formulaic surgical edits |
| **Cline-C** | GPT-4.5 / Codex | Terminal 3 | Frontend — dashboard UI, AuraFlux React/Next.js | `cwn_production.html` today, full React UI for AuraFlux Phase 2+ |
| **Aider** | — | Overnight | Docs, migrations, Jira/Confluence, non-breaking scripts | Batch tasks, anything running 1-6am |
| **Claude Code** | Claude Sonnet 4.6 | This session | Architecture, handoffs, specs, diagnosis | Planning, root cause analysis, spec writing, roadmap, model routing decisions |

**Model routing rationale:**
- **Sonnet for Cline-A** — pipeline code is highest complexity and risk. Gate logic, FFmpeg, HeyGen, QA scoring all require strong reasoning.
- **DeepSeek for Cline-B** — API endpoints and data layer are more formulaic. Surgical edits to well-defined patterns. Cost-efficient.
- **GPT for Cline-C** — frontend is where GPT/Codex excels. React, UI components, CSS. `cwn_production.html` today, AuraFlux React UI in Phase 2.

**Domain split (prevents file lock conflicts):**
- Cline-A owns: `server.js` pipeline functions, `lib/`, assembly logic, gate scoring
- Cline-B owns: `server.js` API endpoints only (app.get/app.post routes), `data/`, `logs/`
- Cline-C owns: `cwn_production.html`, `tools/`, `assets/`, future `ui/` directory

**Note:** When Cline-A and Cline-B both need `server.js`, Cline-A gets priority. Cline-B waits for Cline-A's lock to clear. API endpoint edits are always lower risk than pipeline function edits.

**Jira assignment labels:** `cline_sonnet`, `cline_deepseek`, `cline_gpt` — use these in the Assignee field when tickets are created.

**Handoff header convention:** Every handoff written by Claude Code will start with `→ Agent: Cline-A` (or B/C/Aider) so it's immediately clear who executes it.

---

## Tier 1 — Core pipeline files (highest risk)

**Never edit without explicit Rob approval. Never edit if another agent has declared a lock.**

| File | Why it's Tier 1 |
|---|---|
| `server.js` | 9000+ line Node API — every pipeline stage lives here. A bad edit breaks all content types simultaneously. |
| `cwn_production.html` | Dashboard + all pipeline controls. A bad edit breaks the operator's ability to run anything. |
| `lib/directives.js` | Directive sidecar read/write. Corruption here breaks chrome on every News run. |
| `lib/chromeDirectives.js` | Zod schema. A schema change breaks every directive written before it. |
| `lib/config.js` | Global CONFIG constants. A bad value cascades into every assembly job. |

**Rule:** If your handoff requires a Tier 1 file, declare a lock in STATUS.md before your first edit (see Lock Protocol below). Check STATUS.md first — if another agent has it locked, stop and tell Rob.

---

## Tier 2 — Supporting files (medium risk)

**One agent at a time. Must be explicitly listed in your handoff's "Files to change" table.**

| File | Why it's Tier 2 |
|---|---|
| `tools/clipzworld_newscast.html` | Puppeteer chrome renderer. Bad edit = blank overlay on every News run. |
| `lib/metrics.js` | Stage timer + job metrics. Shared by all pipeline stages. |
| `lib/validation.js` | URL + input validation. Shared security layer. |
| `lib/error_logger.js` | Shared error logging. |
| `lib/clients/jira_client.js` | Atlassian integration — not pipeline-critical but shared. |
| `lib/clients/confluence_client.js` | Same. |
| `package.json` | Dependency changes affect all agents and the running server. |
| `.env.example` | Template for credentials — wrong changes mislead future setup. |
| `data/jobs.json` | Runtime job state. Never commit, never hand-edit while server is running. |

---

## Tier 3 — Free to edit

**Any agent can edit these if listed in their handoff. No lock declaration needed.**

| Pattern | Examples |
|---|---|
| `scripts/*.js` | `jira_ping.js`, `jira_morning_report.js` |
| `*.md` (docs) | Handoff docs, spec files, STATUS.md, CLAUDE.md |
| `output/`, `tmp/`, `logs/` | Runtime output — never committed anyway |
| `test/*.js` | Test files |
| `assets/` | Static assets |

---

## Handoff size classification

Every handoff should be tagged with a size. Claude Code assigns the tag when writing the handoff. Cline/Aider respects the rule for that size.

| Size | Definition | Rule |
|---|---|---|
| **S** | ≤3 file edits, ≤20 lines total changed | One session, Flash Act, single commit |
| **M** | 4-10 file edits OR touches any Tier 1 file | One session, Flash, diff review before commit |
| **L** | Architectural change, multiple subsystems, >1 Tier 1 file | Must be split into S/M handoffs by Claude Code first — never execute an L handoff as-is |
| **XL** | Refactor >200 lines OR new feature from scratch | Claude Code writes directly OR Aider overnight — never Cline |

**Current handoff sizes:**
- `CLINE_HANDOFF_NEWS_CHROME_FIX.md` — **M** (server.js + tools/clipzworld_newscast.html)
- `CLINE_HANDOFF_WAVE_0_CLEANUP.md` — **S×13** (13 independent S items, one commit each)
- `CLINE_HANDOFF_NBA_VOICEOVER_FFMPEG_V2.md` — **L** (split before executing)
- `AURAFLUX_REVERSE_PIPELINE_SPEC.md` — **XL** (Claude Code or Aider, not Cline)

---

## Lock protocol (two active agents)

When two Cline instances or Cline + Aider are running simultaneously:

**Before your first edit to any Tier 1 or Tier 2 file:**

1. Check `STATUS.md` → `🔒 Active File Locks` table (see below)
2. If the file is unlocked — add your lock entry, then edit
3. If the file is locked by another agent — **stop, do not edit, tell Rob**

**Lock entry format in STATUS.md:**
```
| server.js | Cline-A | CLINE_HANDOFF_NEWS_CHROME_FIX.md Fix 2-6 | 2026-04-14 14:30 ET |
```

**Unlock:** Remove your lock entry when you commit. If you abandon a task without committing, remove the lock and note it in STATUS.md.

**Timeout:** Any lock older than 2 hours with no associated commit is considered stale. The next agent may clear it and proceed.

---

## Aider — Overnight Junior Assistant

Aider runs 1-6am and handles high-volume, tedious, data-intensive tasks that would interrupt active daytime workflows. Changes are reviewed at morning standup before taking full effect.

**Jira management:**
- Ticket triage — analyze new bugs/support requests, assign priority, categorize into correct request types
- Backlog cleanup — identify stale/zombie tickets (no update in 14+ days), close or flag for review
- Issue enrichment — link related Confluence docs, PRDs, and spec files to Jira tickets automatically
- Subtask generation — break large epics into user stories + subtasks, pre-populate with acceptance criteria and story point estimates
- Dependency management — when parent task marked complete, notify stakeholders and update dependent tickets

**Confluence maintenance:**
- Summarize long pages updated during the day into executive summaries
- Archive inactive/obsolete pages
- Scan new pages for action items → create corresponding Jira tickets
- Generate draft docs from resolved Jira issues

**Reporting:**
- Daily status report on engineering activity → delivered to Rob's email/Slack by 6am
- Proactive issue creation when recurring error patterns detected in `logs/errors.jsonl`

**What Aider does NOT do overnight:**
- Does NOT touch `server.js`, `cwn_production.html`, or any Tier 1 file
- Does NOT commit code changes — only docs, scripts, Jira/Confluence updates
- Does NOT make architectural decisions — flags for Claude Code review

**Morning review rule:** Rob reviews Aider's overnight changes at standup. Nothing Aider creates goes live until reviewed. This solves the "audit problem" — high-volume AI activity doesn't confuse the human team.

---

## Aider — Maintenance Windows (Scheduled)

Maintenance windows are for system-wide tasks that cannot safely run under production load. Required when live customers are active — too much noise to run these tasks safely overnight.

**Window format:** Customers notified in advance (e.g. "Sunday 2-4am ET — scheduled maintenance"). No new jobs accepted during window. In-flight jobs complete or are safely paused. Aider runs task list. System health report generated. Rob approves before window closes and production resumes.

**Maintenance window task categories:**

**Security:**
- Dependency vulnerability scan (`npm audit`) + fix where safe
- OWASP top 10 review pass on all user-facing endpoints
- Input sanitization audit — verify all req.body inputs validated before use
- Secrets detection — scan for hardcoded credentials, tokens, API keys in codebase
- Log PII audit — ensure no customer data leaking into `logs/errors.jsonl`

**Code quality:**
- Dead code removal — functions defined but never called
- Unused import cleanup
- Console.log → structured logger replacement
- Consistent error handling pass — bare `catch(e){}` blocks flagged
- Duplicate function detection — same logic in multiple places, consolidate

**Data sanitization:**
- `data/jobs.json` compaction — prune jobs older than retention policy
- `logs/` rotation — archive and compress old log files
- `output/` cleanup — remove MP4s already confirmed on Drive
- Stale `tmp/` files older than 48h

**Refactoring:**
- Extract repeated patterns into shared utilities
- Module splits when a file exceeds size threshold
- Rename internal variables to customer-facing names (per `PLATFORM_ARCHITECTURE.md` naming table)
- Dead endpoint removal

**Dependency maintenance:**
- `npm audit fix` for non-breaking patches
- Package version assessment — flag major version gaps for Claude Code review
- Breaking change report → Jira ticket for Claude Code to spec the migration

**System health report (generated at end of every window):**
```
=== MAINTENANCE WINDOW REPORT ===
Window: [start] → [end]
Tasks completed: N
Files changed: [list]
Security findings: [critical/high/medium/low counts]
Dependencies updated: [list]
Dead code removed: [line count]
Data pruned: [MB freed]
Flagged for Claude Code review: [list of items needing architectural decision]
Status: READY TO RESUME / NEEDS ROB REVIEW
```

**What Aider does NOT do in maintenance windows:**
- Does NOT make architectural decisions — creates Jira tickets for Claude Code
- Does NOT change API contracts or gate logic — flags for sprint planning
- Does NOT update customer-facing UI copy without PO approval

---

## Agile Story Structure (Jira)

**One story per feature — not separate BE/FE stories.** A story is not done until API is integrated AND UI works end-to-end.

```
EPIC: [Major feature, e.g. "Autonomous Gate Progression"]
  STORY: As a customer, my failed job retries automatically without operator intervention
    SUBTASK: [cline_sonnet] Implement gate retry loop in server.js
    SUBTASK: [cline_deepseek] Add retryCount + alertSent fields to job persistence
    SUBTASK: [cline_gpt] Show retry status + alert UI on job card
    SUBTASK: [aider] Write acceptance criteria + link spec docs to ticket
```

**API-first workflow:**
1. Claude Code writes the handoff (API contract)
2. Cline-B (DeepSeek) stubs the endpoint first
3. Cline-A (Sonnet) builds the logic, Cline-C (GPT) builds the UI in parallel against the stub
4. Integration when both are done

---

## Multi-agent dispatch rules

When Rob runs two agents simultaneously:

**Agent A gets:** `server.js` + backend files (Tier 1 backend)  
**Agent B gets:** `cwn_production.html` + frontend/dashboard files (Tier 1 frontend)  
**Neither agent touches the other's declared files — even if the handoff seems to require it.**

If a handoff requires both `server.js` AND `cwn_production.html` — it must be split into two handoffs (one per agent) by Claude Code before dispatch. Claude Code identifies the split point and writes the dependency order (which must ship first).

**File conflict = stop and tell Rob.** Never resolve a file conflict by merging both agents' changes manually. Always let Claude Code review both diffs and produce the correct merged version.

---

## STATUS.md additions required

Add this table to STATUS.md immediately below the `🤖 Last Agent Action` table:

```markdown
## 🔒 Active File Locks

| File | Agent | Handoff | Locked At |
|------|-------|---------|-----------|
| (none) | — | — | — |
```

Clear entries when the associated commit lands.
