# Commit Checklist
**Read this before every commit. No exceptions.**

---

## 0. IDENTITY CHECK — Do this first, every session

```bash
# Confirm you are on the right branch before touching anything
git branch --show-current
```

**If you are not on `main` or a feature branch you created — STOP. Do not edit. Do not commit.**

---

## 1. SYNTAX CHECK — Before staging anything

```bash
# For every .js file you changed:
node --check server.js
node --check lib/assembly.js
# etc — every file you touched
```

**If `node --check` fails — fix it before staging. Never commit broken syntax.**

---

## 2. STATUS.md — HARD REQUIREMENT

The pre-commit hook will block commits that skip this.

1. Open `STATUS.md`
2. Add a new row to the top of the `🤖 Last Agent Action` table.
3. Fill in all columns: Agent, Task Completed, Files Changed, Commit, Timestamp.
4. Update `Last Updated` date at the top of the file.
5. `git add STATUS.md` as part of your commit.

---

## 3. STAGE ATOMICALLY

```bash
# Always add files explicitly.
git add file1.js file2.js STATUS.md && git commit -m "..."
```

**Never use `git add -A` or `git add .`** — unrelated files might be included.

---

## 4. COMMIT MESSAGE FORMAT

```
type(scope): short description

- file.js: what changed and why
- file.js: what changed and why
```

Types: `feat` `fix` `refactor` `docs` `chore` `test`

**Bad:** `fix: update server.js`
**Good:** `fix(gate1): increase structured fix directive max_tokens to 4000`

---

## 5. PUSH AFTER COMMITTING

```bash
git push origin <your-branch-name>
```

---

## 6. WHAT NOT TO COMMIT

- `.env` — never
- `output/` — never
- `tmp/` — never
- `data/jobs.json` — never
- `*.bak` — never
- Any file not related to your request

---

## 7. AFTER PUSHING

**If you changed `server.js` or any `lib/` file:**
```bash
# This will be handled by PM2 or nodemon, but a manual restart is a good fallback.
npm run restart
```

---

## 8. FILE LOCK PROTOCOL (two agents running simultaneously)

Before editing any Tier 1 file (`server.js`, `cwn_production.html`, etc.):

1. Check `STATUS.md → 🔒 Active File Locks`
2. If locked by another agent — **stop, communicate**
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

All 6 must pass a gate before moving on to the next.

---

**Last Updated:** 2026-04-24
**Maintained by:** Claude Code
