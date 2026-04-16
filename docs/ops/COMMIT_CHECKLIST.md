# Cline Commit Checklist
**Read this before every commit. No exceptions.**

---

## 0. IDENTITY CHECK — Do this first, every session

```bash
# Confirm you are on the right branch before touching anything
git branch --show-current
```

| Agent | Required prefix |
|-------|----------------|
| Cline-A | `cline-a/` |
| Cline-B | `cline-b/` |
| Cline-C | `cline-c/` |

**If the branch does not start with your prefix — STOP. Do not edit. Do not commit.**
Run: `git checkout main && git pull origin main && git checkout -b cline-[a/b/c]/<task-name>`

---

## 1. SYNTAX CHECK — Before staging anything

```bash
# For every .js file you changed:
node -c server.js
node -c lib/assembly.js
node -c lib/qa.js
node -c lib/script_gen.js
node -c lib/publish.js
# etc — every file you touched
```

**If node -c fails — fix it before staging. Never commit broken syntax.**

---

## 2. STATUS.md — HARD REQUIREMENT

The pre-commit hook will block commits that skip this.

1. Open `STATUS.md`
2. Add a row to `🤖 Last Agent Action` table:

```
| Cline-A | feat(gate1): description of what you did | files changed | commit_hash | 2026-04-17 HH:MM ET |
```

3. Update `Last Updated` date at top
4. `git add STATUS.md` as part of your commit

---

## 3. STAGE ATOMICALLY

```bash
# Always chain add + commit in one command — never split across two calls
git status --short && git add file1.js file2.js STATUS.md && git commit -m "..."
```

**Never use `git add -A` or `git add .`** — other agents' files will hitchhike.

---

## 4. COMMIT MESSAGE FORMAT

```
type(scope): short description

- file.js:LINE — what changed and why
- file.js:LINE — what changed and why

Handoff: CLINE_HANDOFF_FILENAME.md
node -c: passed all changed files
```

Types: `feat` `fix` `refactor` `docs` `chore`

**Bad:** `fix: update server.js`
**Good:** `fix(gate1): structured fix directive max_tokens 2000→4000 (lib/qa.js:657)`

---

## 5. PUSH BEFORE REPORTING BACK

```bash
git push origin cline-[a/b/c]/<your-branch-name>
```

**Do not report back to Rob until this command succeeds.**
Claude Code cannot review or merge work that hasn't been pushed.

---

## 6. FINAL REPORT FORMAT

Your last message to Rob MUST include exactly this:

```
Branch: cline-a/your-branch-name
Commits: abc1234 — description
         def5678 — description

What was done:
- lib/file.js:LINE — specific change
- server.js:LINE — specific change

node -c: passed (list every file checked)
STATUS.md: updated
```

---

## 7. WHAT NOT TO COMMIT

- `.env` — never
- `output/` — never
- `tmp/` — never
- `data/jobs.json` — never
- `*.bak` — never
- Any file not related to your handoff

---

## 8. AFTER COMMITTING

**If you changed `server.js` or any `lib/` file:**
```bash
touch server.js   # triggers nodemon restart
```

**If you changed `cwn_production.html`:**
```bash
kill $(lsof -ti :8765) 2>/dev/null
cd /Users/robertgregory/cwn-production && python3 -m http.server 8765 &
```

---

## 9. FILE LOCK PROTOCOL (two agents running simultaneously)

Before editing any Tier 1 file (`server.js`, `cwn_production.html`, `lib/directives.js`, `lib/chromeDirectives.js`, `lib/config.js`):

1. Check `STATUS.md → 🔒 Active File Locks`
2. If locked by another agent — **stop, tell Rob**
3. If unlocked — add your lock entry first, then edit
4. Remove lock entry when you commit

---

## CWN Test Matrix (for context — do not run tests yourself)

6 tests per gate. Claude Code runs these after each gate's fixes merge.

| Test | Type | Form | Gate 4 destination |
|------|------|------|--------------------|
| 1 | Twitch | Long | YouTube |
| 2 | News | Long | YouTube |
| 3 | NBA | Long | YouTube |
| 4 | Twitch | Short | YouTube Shorts + TikTok + Instagram |
| 5 | News | Short | YouTube Shorts + TikTok + Instagram |
| 6 | NBA | Short | YouTube Shorts + TikTok + Instagram |

All 6 must pass a gate before Clines get work for the next gate.

---

**Last Updated:** 2026-04-17
**Maintained by:** Claude Code
