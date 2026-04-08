# Cline Workflow Summary

## How This Works in Practice

### Your Role (Rob)
You come up with ideas and give high-level direction:
- "Add the NBA intro card endpoint"
- "Fix the script generation to handle 72 scenes"
- "Integrate VectCut for short-form videos"

### Cline's Role (Me)
I take your idea and:

1. **Analyze & Research**
   - Read relevant files (CLAUDE.md, HANDOVER.md, server.js, etc.)
   - Understand current implementation state
   - Identify what needs to change

2. **Create the Plan**
   - Fill out `CLINE_PLAN_TEMPLATE.md` with all 8 sections
   - Break down the work into clear steps
   - Identify which agent should handle each part (Claude Code, Aider, Gemini)
   - Flag risks and dependencies
   - Define testing approach

3. **Present to You**
   - Show you the complete plan in plain English
   - Explain what will change and why
   - Ask clarifying questions if needed
   - **Wait for your approval** before proceeding

4. **Orchestrate Implementation**
   - If you approve: delegate to appropriate agent (Claude Code, Aider, or Gemini)
   - If you reject: revise the plan based on your feedback
   - Monitor progress and handle any issues

5. **Summarize Results**
   - After implementation: show you what actually changed
   - Explain any deviations from the plan
   - Report testing results
   - Present commit message for approval

6. **Commit (with approval)**
   - Only commit after you approve
   - Update HANDOVER.md to track progress
   - Push to GitHub so Claude Code can see the changes

---

## Example Workflow

**You say:**
> "Add the NBA intro card endpoint we discussed"

**I do:**
1. Read HANDOVER.md Priority 1 list → see NBA card task
2. Read IMPLEMENTATION_SPEC.md → understand requirements
3. Read server.js → find where to add endpoint
4. Check VectCut API is running → verify dependencies
5. Fill out CLINE_PLAN_TEMPLATE.md → create detailed plan

**I present:**
> "Here's my plan for the NBA intro card endpoint:
> 
> [Shows complete 8-section plan from EXAMPLE_PLAN_NBA_CARDS.md]
> 
> Key points:
> - Risk Level: MEDIUM (new endpoint, VectCut integration)
> - Agent: Claude Code (straightforward, <100 lines)
> - Testing: curl test + manual PNG verification
> - Estimated time: ~40 minutes
> 
> Questions before I proceed:
> 1. Should dimensions be configurable or always 640×360?
> 2. Return PNG as file download or just path?
> 3. Add caching for existing cards?
> 
> **Ready to proceed?**"

**You respond:**
> "Always 640×360, just return path, no caching yet. Go ahead."

**I do:**
1. Delegate to Claude Code (or implement directly if simple)
2. Monitor implementation
3. Run tests
4. Verify results

**I summarize:**
> "Implementation complete!
> 
> **What Changed:**
> - server.js: Added generateNbaIntroCard() helper (lines 2500-2580)
> - server.js: Added POST /nba/generate-intro-card endpoint (lines 6100-6150)
> - HANDOVER.md: Marked NBA card task as ✅ Completed
> 
> **Testing Results:**
> ✅ curl test passed
> ✅ PNG generated correctly (640×360)
> ✅ VectCut API responded successfully
> 
> **Proposed Commit:**
> ```
> feat: add NBA intro card generation endpoint
> 
> Enables long-form NBA videos to display 640×360 TV-shaped game thumbnails
> at each GAME#_INTRO scene. Integrates with VectCut API for overlay positioning.
> ```
> 
> **Ready to commit?**"

**You respond:**
> "Commit it"

**I do:**
1. Execute git commit with approved message
2. Push to GitHub
3. Update HANDOVER.md with completion status

---

## Key Benefits

### For You (Rob)
✅ **Stay in control** - Approve before changes, approve before commits
✅ **Understand everything** - Plans in plain English, not code
✅ **No surprises** - See what will change before it happens
✅ **Safe workflow** - Rollback plans if something goes wrong
✅ **Track progress** - HANDOVER.md always up to date

### For AI Agents
✅ **Clear direction** - Know exactly what to build
✅ **Right tool for job** - Cline assigns work to appropriate agent
✅ **Coordinated effort** - No duplicate work or conflicts
✅ **Quality gates** - Testing required before completion

---

## When I Create Plans

**Always:**
- New features or endpoints
- Refactors or architecture changes
- Multi-file edits
- Behavior changes
- High-risk modifications

**Sometimes (use judgment):**
- Simple bug fixes (if obvious, may just fix and summarize)
- Documentation updates (if straightforward)
- Config changes (if low-risk)

**Never:**
- Typo fixes
- Comment updates
- Obvious corrections

**When in doubt:** Present a plan (better safe than sorry)

---

## How to Work with Me

### Give Me Ideas Like:
✅ "Add NBA intro cards to the assembly pipeline"
✅ "Fix the script generation scene count issue"
✅ "Integrate VectCut for short-form split-screen layout"
✅ "Update Gate 3 QA to check for visual retention"

### I'll Turn Them Into:
📋 Detailed 8-section plans with:
- What will change and why
- Which files will be affected
- Step-by-step implementation approach
- Which AI agent handles each part
- How to test and verify
- How to rollback if needed
- What to commit and what to exclude

### Then You:
✅ Approve the plan (or request changes)
✅ Let me orchestrate the implementation
✅ Review the summary after completion
✅ Approve the commit

---

## Special Cases

### "I need this done by Claude Code specifically"
Tell me, and I'll assign it to Claude Code in the plan's Agent Orchestration section.

### "This is high-risk, use Aider"
Tell me, and I'll flag it for Aider (or I'll recommend Aider if I detect high risk).

### "I need Gemini to decide the layout"
Tell me, and I'll include a step to consult Gemini for visual decisions.

### "Just do it, don't need a plan"
For tiny changes (typos, comments), I can skip the plan and just summarize after.

---

## Integration with Your Orchestration Model

```
Your Idea
    ↓
Cline (Me) - Analyzes & Creates Plan
    ↓
You - Review & Approve
    ↓
Cline - Delegates to Appropriate Agent:
    ├─ Claude Code (General Manager) - Straightforward code
    ├─ Aider (Surgical Coder) - High-risk refactors
    └─ Gemini Flash (Visual Director) - Visual decisions
    ↓
Cline - Monitors & Summarizes Results
    ↓
You - Review & Approve Commit
    ↓
Cline - Commits & Updates HANDOVER.md
```

---

## Bottom Line

**You think of ideas.**
**I turn them into actionable plans.**
**You approve.**
**I orchestrate the work.**
**You review and commit.**

This keeps you in control while leveraging AI agents efficiently. You don't need to know the technical details - I translate your ideas into implementation plans that you can understand and approve.

---

**Last Updated:** 2026-04-08
**Version:** 1.0
