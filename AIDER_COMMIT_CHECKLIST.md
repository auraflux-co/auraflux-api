# Aider Commit Checklist

Use this checklist before every commit in this repository.

1. Re-read `CLAUDE.md` and follow all repository rules.
2. Confirm changes match the requested task only (no unrelated edits).
3. Do not commit secrets, credentials, `.env`, `output/`, `tmp/`, or generated noise files.
4. Preserve existing user changes; never revert unrelated local work.
5. Run relevant checks for touched code paths and fix introduced errors.
6. Write a clear commit message focused on why the change was made.
7. Verify `git status` is clean except for intended staged files before commit.

---

## Context Management (Avoid Token Limit Errors)

Token limit messages are caused by context bloat — not the model. Keep context lean:

- **Only `/add` the specific file you're editing** — don't add the whole codebase
- **Use `/drop <file>` when done** with a file to remove it from context
- **Use `/clear` at the start of each new task** to reset chat history
- **Start a new session (`/exit` then `aider`) for unrelated tasks** — history accumulates fast
- **Avoid adding large files together** (e.g. `server.js` + `CWN_Production_Manual.html` at once)

Quick reference:
```
/add server.js        # add only what you need
/drop server.js       # remove when done
/clear                # reset history between tasks
/tokens               # check current context usage
```
