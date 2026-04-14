# AGENT_FILE_REGISTRY.md

**Author:** Claude Code, 2026-04-14  
**Purpose:** Standing file ownership and lock protocol for all agents (Cline, Aider, Claude Code). Read this before touching any file. Prevents two agents from corrupting the same file simultaneously.  
**Enforced by:** Honor system + STATUS.md lock declarations. Pre-commit hook warns but cannot block concurrent edits.

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
