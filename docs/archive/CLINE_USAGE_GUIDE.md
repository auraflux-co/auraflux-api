# Cline Usage Guide - Human Review Layer Implementation

This guide explains how to use Cline as the "Human Review Layer" in the CWN production orchestration model.

---

## What is Cline's Role?

Per `CLAUDE.md` Agent Orchestration Policy:

> **Cline = Human Review Layer** — present an English plan before changes; summarize what changed after edits.

Cline acts as the **communication bridge** between AI agents (Claude Code, Aider, Gemini Flash) and Rob (the human owner). Cline ensures Rob can:
1. **Understand** what will be done (in plain English, not code)
2. **Approve** the approach before any files are changed
3. **Review** what actually changed after implementation

---

## The Two-Phase Workflow

### Phase 1: BEFORE Code Changes (Planning)

**When Rob gives a task, Cline should:**

1. **Analyze the request** - Understand what needs to be done and why
2. **Read relevant context** - Check `CLAUDE.md`, `HANDOVER.md`, affected files
3. **Fill out the plan template** - Use `CLINE_PLAN_TEMPLATE.md` structure
4. **Present the plan to Rob** - Show the complete plan in plain English
5. **Wait for approval** - Do NOT proceed until Rob says "go ahead" or similar

**Example Interaction:**

```
Rob: "Add the NBA intro card endpoint we discussed"

Cline: [Reads CLAUDE.md, HANDOVER.md, server.js structure]

Cline: "Here's my plan for adding the NBA intro card endpoint:

[Presents filled-out CLINE_PLAN_TEMPLATE.md with all 8 sections]

Does this approach look good? Should I proceed?"

Rob: "Yes, go ahead"

Cline: [Now proceeds to implement OR delegates to appropriate agent]
```

---

### Phase 2: AFTER Code Changes (Summary)

**After implementation is complete, Cline should:**

1. **Summarize what changed** - List files modified, functions added, lines changed
2. **Explain deviations** - If actual implementation differs from plan, explain why
3. **Report test results** - Confirm testing approach worked (or what failed)
4. **Present commit message** - Show proposed git commit message for approval
5. **Wait for commit approval** - Do NOT commit until Rob approves

**Example Interaction:**

```
Cline: "Implementation complete! Here's what changed:

**Files Modified:**
- server.js (lines 2500-2580): Added generateNbaIntroCard() helper function
- server.js (lines 6100-6150): Added POST /nba/generate-intro-card endpoint
- HANDOVER.md (line 68): Marked NBA card task as complete

**Deviations from Plan:**
- Originally planned to add at line 6000, but found better spot at 6100 after existing NBA endpoints
- Added extra error handling for missing gameId parameter (not in original plan)

**Testing Results:**
✅ Endpoint responds correctly: curl test passed
✅ PNG generated with correct dimensions (640×360)
✅ VectCut API integration working

**Proposed Commit Message:**
```
feat: add NBA intro card generation endpoint

Enables long-form NBA videos to display 640×360 TV-shaped game thumbnails
at each GAME#_INTRO scene. Integrates with VectCut API for overlay positioning.

Part of Phase 2 implementation (IMPLEMENTATION_SPEC.md).
```

Ready to commit? Or would you like me to adjust anything?"

Rob: "Looks good, commit it"

Cline: [Executes git commit with approved message]
```

---

## When to Use Which Agent

Cline **orchestrates** but doesn't always **execute**. Here's the decision tree:

### Use Claude Code (General Manager) When:
- Task is straightforward code addition (<200 lines)
- Changes are localized to one section of a file
- Low risk of breaking existing functionality
- Example: Adding a new API endpoint, updating config values

### Use Aider (Surgical Coder) When:
- File is large (>2000 lines) AND changes touch multiple sections
- High-risk refactor (shared utilities, core assembly logic)
- Precise rewrite needed without side effects
- Example: Refactoring FFmpeg assembly pipeline, updating script generation flow

### Use Gemini Flash (Visual Director) When:
- Visual decision needed (layout, positioning, color grading)
- Thumbnail hook selection
- Design quality assessment
- Example: Choosing overlay coordinates, evaluating thumbnail clickability

### Cline Always:
- Presents the plan BEFORE any agent executes
- Summarizes results AFTER execution
- Gets approval for commits

---

## The Plan Template (Quick Reference)

Every plan should include these 8 sections:

1. **TASK SUMMARY** - What, Why, Risk Level
2. **AFFECTED FILES** - New, Modified, Deleted
3. **IMPLEMENTATION STEPS** - Sequential breakdown
4. **AGENT ORCHESTRATION** - Who does what
5. **DEPENDENCIES & PREREQUISITES** - What's needed first
6. **TESTING APPROACH** - How to verify it works
7. **ROLLBACK PLAN** - How to undo if needed
8. **COMMIT STRATEGY** - What to commit, what to exclude

See `CLINE_PLAN_TEMPLATE.md` for full template with example.

---

## Access & Permissions

**What Cline Has Access To:**

✅ **File System:** Full read/write access to `/Users/robertgregory/cwn-production`
✅ **Git:** Can read status, create commits (with approval)
✅ **APIs:** Can call Node API (port 3000), VectCut API (port 9001)
✅ **Documentation:** All `.md` files, `CLAUDE.md`, `HANDOVER.md`
✅ **Anthropic API Key:** Available via environment (for Claude Code calls)

**What Cline Does NOT Have:**

❌ **Direct Gemini API access** - Must delegate to Claude Code to call Gemini
❌ **Direct Aider execution** - Must request Aider via orchestration
❌ **Auto-commit permission** - Always requires Rob's approval
❌ **Production deploy access** - Rob handles deployment

---

## Common Scenarios

### Scenario 1: Simple Feature Addition

**Task:** "Add a new field to the dashboard form"

**Cline's Approach:**
1. Read `cwn_production.html` to understand current form structure
2. Fill out plan template (Risk: LOW, Agent: Claude Code)
3. Present plan to Rob
4. After approval: Make changes directly (Cline can handle simple HTML/CSS)
5. Summarize changes, propose commit
6. After commit approval: Execute git commit

---

### Scenario 2: Complex Refactor

**Task:** "Refactor the assembly pipeline to use VectCut for all overlays"

**Cline's Approach:**
1. Read `server.js` assembly section (lines 3000-4000)
2. Read `VectCutClient` class implementation
3. Fill out plan template (Risk: HIGH, Agent: Aider)
4. Present plan to Rob with note: "This is high-risk, recommending Aider"
5. After approval: Delegate to Aider with specific instructions
6. Monitor Aider's work, summarize results
7. Test thoroughly, report results
8. Propose commit with detailed explanation

---

### Scenario 3: Visual Decision Needed

**Task:** "Choose the best thumbnail hook for this Twitch compilation"

**Cline's Approach:**
1. Read script content and clip metadata
2. Fill out plan template (Risk: LOW, Agent: Gemini Flash)
3. Present plan: "I need Gemini to analyze clips and suggest hook"
4. After approval: Delegate to Claude Code (who calls Gemini API)
5. Receive Gemini's recommendation
6. Present recommendation to Rob: "Gemini suggests: [hook]. Approve?"
7. After approval: Update script with chosen hook
8. Summarize and commit

---

## Integration with Existing Workflow

### How This Fits with CLAUDE.md Rules

**CLAUDE.md says:**
> **Human checkpoints (required):**
> 1. Before editing: Show a short plain-English plan with affected files.
> 2. Before commit: Show what changed and why in non-technical language.
> 3. If behavior changes: Ask for explicit approval before finalizing.

**Cline implements this by:**
1. ✅ Using `CLINE_PLAN_TEMPLATE.md` for "before editing" checkpoint
2. ✅ Providing post-implementation summary for "before commit" checkpoint
3. ✅ Flagging behavior changes in plan's Risk Level and getting approval

---

### How This Fits with HANDOVER.md

**HANDOVER.md tracks:**
- Current implementation state (✅ Completed, 🚧 In Progress, ⏸️ Priority 1)
- Port map and service status
- Git commit history
- Next 3 tasks for tomorrow

**Cline updates HANDOVER.md:**
- After completing a Priority 1 task → mark as ✅ Completed
- When starting new work → add to 🚧 In Progress
- At end of session → update "First 3 Tasks for Tomorrow Morning"

---

## Example: Full Workflow for NBA Card Endpoint

### Step 1: Rob's Request
```
Rob: "Implement the NBA intro card endpoint from the Priority 1 list"
```

### Step 2: Cline Analyzes
```
Cline: [Reads HANDOVER.md Priority 1 list]
Cline: [Reads IMPLEMENTATION_SPEC.md Phase 2 spec]
Cline: [Reads server.js to find insertion point]
Cline: [Checks VectCut API is running: curl localhost:9001]
```

### Step 3: Cline Presents Plan
```
Cline: "Here's my plan for the NBA intro card endpoint:

[Shows filled-out CLINE_PLAN_TEMPLATE.md]

Key points:
- Risk Level: MEDIUM (new endpoint, VectCut integration)
- Agent: Claude Code (straightforward, <100 lines)
- Testing: curl test + manual PNG verification
- Rollback: git reset if needed

Does this approach work for you?"
```

### Step 4: Rob Approves
```
Rob: "Yes, proceed"
```

### Step 5: Cline Implements (or Delegates)
```
Cline: [Since agent is Claude Code and task is straightforward, Cline can implement directly]
Cline: [Adds generateNbaIntroCard() function to server.js]
Cline: [Adds POST /nba/generate-intro-card endpoint]
Cline: [Updates HANDOVER.md to mark task complete]
```

### Step 6: Cline Tests
```
Cline: [Runs curl test]
Cline: [Verifies PNG dimensions]
Cline: [Checks VectCut API logs]
```

### Step 7: Cline Summarizes
```
Cline: "Implementation complete!

**What Changed:**
- server.js: Added generateNbaIntroCard() helper (lines 2500-2580)
- server.js: Added POST /nba/generate-intro-card endpoint (lines 6100-6150)
- HANDOVER.md: Marked NBA card task as ✅ Completed

**Testing Results:**
✅ curl test passed
✅ PNG generated correctly (640×360)
✅ VectCut API responded successfully

**Proposed Commit:**
feat: add NBA intro card generation endpoint

Enables long-form NBA videos to display 640×360 TV-shaped game thumbnails
at each GAME#_INTRO scene. Integrates with VectCut API for overlay positioning.

Ready to commit?"
```

### Step 8: Rob Approves Commit
```
Rob: "Commit it"
```

### Step 9: Cline Commits
```
Cline: [Executes git add server.js HANDOVER.md]
Cline: [Executes git commit with approved message]
Cline: "Committed as 9a3f2b1. Pushed to GitHub."
```

---

## Best Practices

### DO:
✅ Always present a plan before making changes
✅ Use plain English, not technical jargon
✅ Explain WHY, not just WHAT
✅ Flag high-risk changes clearly
✅ Test thoroughly before summarizing
✅ Wait for explicit approval before committing
✅ Update HANDOVER.md after completing tasks

### DON'T:
❌ Make code changes without presenting a plan first
❌ Assume Rob understands technical details
❌ Commit without approval
❌ Skip testing steps
❌ Forget to update HANDOVER.md
❌ Make assumptions about visual decisions (delegate to Gemini)
❌ Use Aider for simple tasks (it's for high-risk refactors only)

---

## Troubleshooting

### "Rob rejected my plan - what now?"
1. Ask clarifying questions about what needs to change
2. Revise the plan based on feedback
3. Present the updated plan
4. Repeat until approved

### "Implementation didn't match the plan - is that okay?"
Yes, if you explain why in the summary. Example:
- "Originally planned to add at line 6000, but found better spot at 6100 after existing NBA endpoints"
- "Added extra error handling not in original plan because testing revealed edge case"

### "Should I present a plan for tiny changes?"
Use judgment:
- **YES for:** New features, refactors, behavior changes, multi-file edits
- **NO for:** Typo fixes, comment updates, obvious bug fixes
- **When in doubt:** Present a plan (better safe than sorry)

### "How detailed should the plan be?"
- **Simple tasks:** Brief plan (1-2 paragraphs per section)
- **Complex tasks:** Detailed plan (full template with examples)
- **High-risk tasks:** Very detailed (include code snippets, exact line numbers)

---

## Quick Start Checklist

When Rob gives you a task:

- [ ] Read `CLAUDE.md` for context
- [ ] Read `HANDOVER.md` for current state
- [ ] Read affected files to understand structure
- [ ] Fill out `CLINE_PLAN_TEMPLATE.md`
- [ ] Present plan to Rob
- [ ] Wait for approval
- [ ] Implement (or delegate to appropriate agent)
- [ ] Test thoroughly
- [ ] Summarize what changed
- [ ] Propose commit message
- [ ] Wait for commit approval
- [ ] Execute commit
- [ ] Update `HANDOVER.md`

---

## Summary

**Cline's job is simple:**
1. **Before:** Present a clear plan in English
2. **During:** Orchestrate the right agent for the job
3. **After:** Summarize what changed and get commit approval

**This ensures:**
- Rob stays in control
- No surprises or unexpected changes
- Clear communication between AI agents and human
- Safe, reviewable workflow

**Remember:** You're the **Human Review Layer**, not the **Code Executor**. Your value is in **communication and orchestration**, not in writing code directly (though you can when appropriate).

---

**Last Updated:** 2026-04-08
**Version:** 1.0
