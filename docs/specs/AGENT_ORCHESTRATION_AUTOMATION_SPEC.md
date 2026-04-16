# Agent Orchestration Automation Spec

**Author:** Claude Code, 2026-04-15
**Status:** Phase 2 build target — automates what Claude Code does manually today
**Jira epic:** E6 (add to RAILWAY_MIGRATION_JIRA_EPICS.md after Phase 1 gates pass)
**Where it runs:** Railway worker service, triggered by Jira webhook

---

## What we do manually today (the loop to automate)

Every session Claude Code:
1. Audits git log to find what's already shipped vs what handoff docs claim is pending
2. Assigns tasks to agents based on model capability (Sonnet vs Haiku), file ownership, and task size
3. Creates a feature branch per agent per task batch
4. Writes BRANCH_NOTES.md on each branch with why/what/where
5. Writes a session prompt (why + where + what + rules) and Rob pastes it into each Cline
6. Monitors for completions — agents report "branch ready", Claude Code reviews diff
7. Merges clean branches to main, flags conflicts, reassigns stale tasks
8. Updates STATUS.md, closes completed handoff docs

This is the orchestration layer. In Jira + Railway it becomes:

```
Jira ticket created → webhook fires → orchestrator reads ticket → 
writes branch + prompt → posts prompt to agent → 
agent works → commits → orchestrator reviews diff → 
merges or flags → closes ticket → next ticket
```

---

## Components

### 1. Jira webhook listener (`apps/worker/orchestrator.ts`)

Listens for Jira issue events:
- `issue_created` with label `ready_for_agent` → trigger assignment
- `issue_updated` status → `In Progress` → log
- `issue_updated` status → `In Review` → trigger diff review
- `issue_updated` status → `Done` → close branch, update STATUS.md

**Jira issue schema Claude Code cares about:**
```
summary:      short task name (becomes commit message prefix)
description:  why + what + where (becomes BRANCH_NOTES why/what sections)
labels:       cline_a | cline_b | cline_c | aider
assignee:     maps to agent model
customField:  affected_files[] — list of files to change
customField:  branch_name — e.g. cline-a/outro-freeze-hold
customField:  commit_message — conventional commit string
```

---

### 2. Branch + prompt generator

When a ticket is assigned and labeled `ready_for_agent`:

1. **Create branch** from main:
   ```bash
   git checkout main && git pull && git checkout -b {branch_name}
   ```

2. **Write BRANCH_NOTES.md** on the branch using ticket fields:
   - Why: ticket description intro paragraph
   - What: task list from ticket description
   - Where: affected_files[] + grep commands derived from file list
   - Commit messages: from customField
   - Shell rule: always prepended

3. **Generate session prompt** using this template:
   ```
   SHELL RULE: Every grep/find/rg/ls must end with || true.

   You are {agent} working on branch {branch_name}.
   {model_note if Haiku: "You are running Haiku — one file at a time, flag complexity"}

   WHY THIS BRANCH EXISTS:
   {ticket description — 2-3 sentences}

   WHERE TO FIND CONTEXT:
   - BRANCH_NOTES.md — grep commands, commit messages
   - {handoff_doc if linked in ticket}

   WHAT TO DO ({n} tasks, in order):
   {task list from ticket — file, what, commit message per task}

   RULES:
   - Never read {affected_files} in full — grep -n first, read ±50 lines
   - node -c {primary_file} must pass before every commit
   - Update STATUS.md → Last Agent Action in every commit
   - Never commit to main — stay on {branch_name}

   Start: git checkout {branch_name}
   ```

4. **Post prompt** to agent via:
   - Phase 2 alpha: Slack DM to Rob with prompt + "paste into Cline-A/B/C"
   - Phase 3: direct API call to Cline's Claude Code provider (when API available)

---

### 3. Diff reviewer

When agent marks ticket `In Review` (or pushes to branch):

1. Run `git diff main...{branch_name} --stat` — check only expected files changed
2. Run `git diff main...{branch_name} -- {affected_files}` — read the actual diff
3. Run syntax check: `node -c {primary_js_file}`
4. Check STATUS.md was updated: `git diff main...{branch_name} -- STATUS.md`
5. Flag if:
   - Unexpected files changed (agent went out of scope)
   - Syntax error
   - STATUS.md not updated
   - Diff is empty (agent did nothing)
6. If clean → auto-merge to main, close ticket, delete branch
7. If flagged → comment on ticket with specific issue, move back to `In Progress`

---

### 4. Task audit (replaces Claude Code's manual git log review)

Runs on schedule (daily 9am ET) or triggered manually:

1. Read all open Jira tickets labeled `ready_for_agent` or `in_progress`
2. For each ticket, check if the work is already in git:
   ```bash
   git log --oneline | grep -i "{ticket_summary_keywords}" || true
   ```
3. If found in git → auto-close ticket as `Done`, log commit hash
4. If not found → leave open, surface in daily Slack briefing

This prevents the situation today where handoff docs describe work that shipped weeks ago and agents get assigned tasks that are already done.

---

### 5. Daily briefing (replaces morning STATUS.md review)

Every morning at 9am ET, post to Slack:

```
🤖 CWN Agent Briefing — {date}

✅ Shipped yesterday: {git log --since yesterday}
🔄 In progress: {Jira In Progress tickets}
🟡 Ready to assign: {Jira To Do tickets labeled ready_for_agent}
🚨 Stuck: {branches with no commits in >4 hours}
📊 Phase 1 gates: News {status} | NBA {status} | Shorts {status}
```

---

## Jira ticket template (what Rob fills out)

When Rob or Claude Code creates a new ticket, this is the minimum required:

```
Summary: fix(assembly): freeze-hold last frame of outro 0.75s

Description:
WHY: Bobby G hard-cuts on "Appreciate you!" — video ends before his pose settles.
WHAT: Add tpad=stop_mode=clone:stop_duration=0.75 FFmpeg filter to OUTRO segment in lib/assembly.js per-segment loop. Long-form only.
WHERE: lib/assembly.js — grep for OUTRO in the per-segment loop.
COMMIT: fix(assembly): freeze-hold last frame of outro 0.75s (Gap #45)

Labels: cline_a, ready_for_agent
Affected files: lib/assembly.js, STATUS.md
Branch: cline-a/outro-freeze-hold
```

Claude Code generates these tickets from handoff docs. Rob approves before label `ready_for_agent` is applied — that's the human checkpoint before work starts.

---

## Phase rollout

| Phase | What's automated | What Rob still does |
|-------|-----------------|-------------------|
| **Now (manual)** | Nothing | Everything |
| **Phase 2 alpha** | Branch creation, BRANCH_NOTES.md, prompt generation posted to Slack | Rob pastes prompt into Cline, reviews diff, approves merge |
| **Phase 2 beta** | + Diff review, auto-merge on clean diffs | Rob approves merge for Tier 1 files only |
| **Phase 3** | + Direct agent API calls (no manual paste) | Rob reviews daily briefing, approves Phase 1 gate decisions |

---

## What this unlocks

- Rob goes from pasting prompts + monitoring agents + reviewing diffs → reviewing a Slack briefing once a day
- Claude Code goes from doing orchestration manually every session → writing tickets that feed the automation
- Agents get consistent, high-quality prompts every time — no degradation from session to session
- Stale handoff docs become impossible — audit runs daily and closes anything already in git

---

*Implement as Jira Epic E6 in `RAILWAY_MIGRATION_JIRA_EPICS.md`*
