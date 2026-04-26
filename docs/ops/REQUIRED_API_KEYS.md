# Required API keys (reference — no secrets in this file)

**Audience:** Product owners, operations, anyone who does **not** have access to `.env`.  
**Purpose:** See which third-party accounts and env **names** production depends on. **Values** live only in `.env` (local) or your host’s secret store (Render, etc.) — never in git.

**Last updated:** 2026-04-21

---

## Two AI providers (both matter for the current pipeline)

| Provider | Env variable name | Role in production |
|----------|-------------------|--------------------|
| **Anthropic (Claude)** | `ANTHROPIC_API_KEY` | **Gate 3b** and other Claude paths under `lib/qa`; optional **surgical script fix** retry in `script_gen.js` when that branch runs. Not used for the main Gate 1 scorer anymore. |
| **Google (Gemini)** | `GEMINI_API_KEY` | **Script generation**, **Gate 1** script QA (`lib/gates/gate1.js`), **Gate 1b** video review (when enabled), **clip/thumbnail analysis**, **Gate 3a**, **Gate 4**, and other `generateContent` paths. Without it, `/health` reports missing key and large parts of the line stall or skip. |

So: **Gemini is required** for scripts + Gate 1 + most video QA gates. **Anthropic** is still required for a **full** run today because **Gate 3b** and some helpers use Claude — see `lib/gates/gate3b.js` and `lib/qa.js`. (Default Gate 1 model chain: `GEMINI_GATE1_MODEL` → `GEMINI_SCRIPT_MODEL` → `GEMINI_MODEL` → `gemini-2.5-flash`.)

**Gate 2** (segment structure QA) does **not** call Gemini or Claude in `gate2.js` — it is mostly deterministic code reading segment files.

---

## Minimum set for “full” Customer 0 pipeline

For **script → HeyGen → assembly → gates 3a/4** as implemented today, these are the usual **required** keys:

| Variable | Provider | Used for |
|----------|----------|-----------|
| `ANTHROPIC_API_KEY` | Anthropic | Gate 3b and other Claude QA paths |
| `GEMINI_API_KEY` | Google AI (Gemini API) | Scripts, Gate 1, video analysis, Gate 3a, Gate 4 |
| `HEYGEN_API_KEY` | HeyGen | Avatar renders |

Everything else (Twitch, Drive, Upload-Post, etc.) depends on which **features** you use in a given job.

---

## Where the full list of names lives

- **Template with placeholders (safe to commit):** **`.env.example`** in the repo root — copy to `.env` and fill in.  
- **Server startup / health:** `server.js` `GET /health` checks a subset (e.g. Anthropic, Gemini, HeyGen) and reports **missing**, not the actual values.

---

## For teammates without `.env` access

1. Ask the person who manages secrets for a **scoped** copy: dev vs prod, or a one-time paste into Render/dashboard env UI — not via Slack/email if avoidable.  
2. Use this doc + `.env.example` to know **what** to request (“I need `GEMINI_API_KEY` added to Render for Gate 3a/4”).  
3. Never commit real keys; `.gitignore` includes `.env`.

---

## README / old docs

Some older notes said Gate 1 was Claude-only. **Current code:** Gate 1’s main JSON QA calls **Gemini** (`lib/gates/gate1.js`). Claude remains for Gate 3b and related paths unless those are migrated separately.
