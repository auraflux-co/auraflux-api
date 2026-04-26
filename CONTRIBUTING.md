# Contributing

Thanks for helping improve this project. This repo is set up so **secrets and machine state stay off GitHub**; follow the steps below and open PRs against the default branch your maintainer uses.

## Quick setup

1. **Node.js** — use a current LTS (e.g. 20.x). No `engines` pin yet; if tests fail on older Node, upgrade first.
2. **Clone and install**
   ```bash
   git clone <repo-url>
   cd cwn-production
   npm ci
   ```
3. **Environment** — copy the template and fill in real keys (never commit `.env`):
   ```bash
   cp .env.example .env
   ```
   See `docs/ops/REQUIRED_API_KEYS.md` for what each key unlocks.
4. **Optional local data files** (gitignored; created automatically in many paths):
   - `data/upload_status.json` — publish audit log. You can `cp data/upload_status.example.json data/upload_status.json` or let the first `/publish` write it.
   - `data/episode_counters.json` — episode numbers on chrome burns. Optional; missing file defaults to safe fallbacks in code. To start from zero: `cp data/episode_counters.example.json data/episode_counters.json`.
5. **Run tests**
   ```bash
   npm test
   ```
6. **`logs/`** — the app creates this directory when logging errors or pipeline events. Nothing in `logs/` should be committed (see `.gitignore`).

## Before you open a PR

- Run **`npm test`** and fix failures.
- **Do not** `git add` SQLite files (`data/cwn.db*`), `logs/*`, `data/upload_status.json`, `data/episode_counters.json`, or `.env` — they are ignored for a reason.
- Prefer **small, focused commits** with clear messages. The repo may run a pre-commit hook (e.g. `STATUS.md` updates for maintainers); if you do not have that workflow, use `git commit --no-verify` only when your maintainer agrees.
- No secrets, tokens, or customer PII in code or fixtures.

## Where things live

| Area | Notes |
|------|--------|
| Pipeline / gates | `lib/gates/`, `lib/assembly.js`, `lib/script_gen.js`, `server.js` |
| RCA / “why did QA fail?” | `lib/why_ledger.js`, `cursor.md` (RCA section), SQLite `why_ledger` table |
| Architecture | `docs/architecture/`, especially `GATED_PIPELINE_ARCHITECTURE.md` |

## Questions

Open a discussion or issue as your maintainer prefers. For security-sensitive reports, see `SECURITY.md`.
