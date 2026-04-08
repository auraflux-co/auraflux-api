# Aider Commit Checklist

Use this checklist before every commit in this repository.

1. Re-read `CLAUDE.md` and follow all repository rules.
2. Confirm changes match the requested task only (no unrelated edits).
3. Do not commit secrets, credentials, `.env`, `output/`, `tmp/`, or generated noise files.
4. Preserve existing user changes; never revert unrelated local work.
5. Run relevant checks for touched code paths and fix introduced errors.
6. Write a clear commit message focused on why the change was made.
7. Verify `git status` is clean except for intended staged files before commit.
