# Jira & Confluence Migration Plan

**Created:** 2026-04-12
**Status:** Phase 1 - Initial Setup
**Goal:** Integrate Atlassian stack with GitHub and localhost development workflow

---

## 🎯 Integration Goals

### Primary Objectives
1. **Commit → Jira Linking**: Automatic issue key detection in commit messages
2. **GitHub → Confluence Sync**: All `.md` docs automatically synced to Confluence
3. **Agent Access**: Claude, Cline, and Aider can read/write Jira issues via API
4. **Structured Documentation**: Confluence as single source of truth for project docs
5. **Workflow Automation**: STATUS.md updates → Jira ticket creation/updates

### Success Metrics
- 100% of commits linked to Jira issues
- All GitHub docs available in Confluence within 1 hour
- Agents can create/update Jira tickets programmatically
- Zero manual doc synchronization required

---

## 🏗️ Architecture Overview

```
GitHub Repository
├── Commits with [CWN-123] keys → Jira Smart Commits
├── .md files → Confluence Pages (via GitHub Actions)
└── STATUS.md updates → Jira API calls

Atlassian Cloud
├── Jira Project: CWN (ClipzWorld News)
├── Confluence Space: CWN Development
└── API Integration via Personal Access Tokens

Localhost Development
├── scripts/jira_sync.js → Creates/updates tickets
├── .env → ATLASSIAN_* credentials
└── Git hooks → Enforce issue key format
```

---

## 📋 Phase 1: Initial Setup (This Week)

### 1.1 Jira Project Configuration

**Project Details:**
- **Project Key:** `CWN`
- **Project Type:** Software Development
- **Issue Types:** Epic, Story, Task, Bug, Sub-task
- **Workflow:** Simplified (To Do → In Progress → Done)

**Custom Fields:**
- **Agent Assignee:** Claude, Cline, Aider, Rob (dropdown)
- **File Path:** Text field for affected files
- **Commit Hash:** Text field for related commits
- **Priority Level:** High, Medium, Low (based on OVERNIGHT_TASKS.md)

**Issue Key Format:** `CWN-{number}` (e.g., CWN-1, CWN-2, etc.)

### 1.2 Confluence Space Setup

**Space Details:**
- **Space Key:** `CWN`
- **Space Name:** CWN Development
- **Template:** Software Development

**Page Structure:**
```
CWN Development (Home)
├── 📋 Project Overview
│   ├── Architecture (from CLAUDE.md)
│   ├── Status Dashboard (from STATUS.md)
│   └── QA Gates (from QA_GATES.md)
├── 🔧 Development Guides
│   ├── Commit Checklist (from COMMIT_CHECKLIST.md)
│   ├── Overnight Tasks (from OVERNIGHT_TASKS.md)
│   └── Morning Briefings (from MORNING_BRIEFING.md)
├── 📚 Technical Specs
│   ├── Gated Pipeline Architecture
│   ├── Implementation Specs
│   └── API Documentation
└── 🤖 Agent Handoffs
    ├── Active Handoffs
    └── Archived Handoffs
```

---

## 🔧 Implementation Steps

### Step 1: Atlassian Setup (30 minutes)
1. Create Jira project with key `CWN`
2. Create Confluence space with key `CWN`
3. Generate API token for integration
4. Install GitHub for Jira app

### Step 2: Repository Configuration (1 hour)
1. Add environment variables to `.env.example`
2. Create API client modules
3. Set up GitHub Actions workflow
4. Configure git hooks

### Step 3: Initial Sync (2 hours)
1. Run confluence sync for all existing docs
2. Create initial Jira tickets for current tasks
3. Test commit → Jira linking
4. Verify agent API access

---

## 📝 Commit Message Format

**New Format (enforced by git hooks):**
```
[CWN-123] fix: resolve thumbnail generation 500 error

- Debug Canvas operations in news thumbnail endpoint
- Add error handling for missing image assets
- Update unit tests for thumbnail generation

Closes CWN-123
```

**Smart Commit Commands:**
- `CWN-123 #comment "Fixed the bug"` → Add comment
- `CWN-123 #time "2h 30m"` → Log work time
- `CWN-123 #transition "Done"` → Move to Done status

---

**Next Action:** Begin Phase 1 setup with Jira project creation and API token generation.
