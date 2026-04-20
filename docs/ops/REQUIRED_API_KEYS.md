# Required API keys (reference — no secrets in this file)

**Audience:** Product owners, operations, anyone who does **not** have access to `.env`.  
**Purpose:** See which third-party accounts and env **names** production depends on. **Values** live only in `.env` (local) or your host’s secret store (Render, etc.) — never in git.

**Last updated:** 2026-04-21

---

## Two AI providers (both matter for the current pipeline)

| Provider | Env variable name | Role in production |
|----------|-------------------|--------------------|
| **Anthropic (Claude)** | `ANTHROPIC_API_KEY` | **Gate 1** — script style / accuracy QA after Gemini fills the scaffold; also used elsewhere under `lib/qa` for Claude calls. Without it, Gate 1 cannot run as designed. |
| **Google (Gemini)** | `GEMINI_API_KEY` | **Script generation** (Gemini writes dialogue into the scaffold), **clip/thumbnail analysis** (`geminiAnalyzeClip` and related), **Gate 3a** (samples assembled video), **Gate 4** (full-video broadcast QA), and other `generateContent` paths. Without it, `/health` reports missing key and large parts of the line stall or skip. |

So: **Anthropic is “in there”** in code (`lib/gates/gate1.js`, Claude model string, `@anthropic-ai/sdk`). **Gemini is also “in there”** — not optional for a full scripted + gated run — in `lib/script_gen.js`, `lib/gates/gate3a.js`, `lib/gates/gate4.js`, etc. (model is typically `gemini-2.5-flash` in code.)

**Gate 2** (segment structure QA) does **not** call Gemini or Claude in `gate2.js` — it is mostly deterministic code reading segment files.

---

## Minimum set for “full” Customer 0 pipeline

For **script → HeyGen → assembly → gates 3a/4** as implemented today, these are the usual **required** keys:

| Variable | Provider | Used for |
|----------|----------|-----------|
| `ANTHROPIC_API_KEY` | Anthropic | Gate 1 and other Claude QA paths |
| `GEMINI_API_KEY` | Google AI (Gemini API) | Scripts, video analysis, Gate 3a, Gate 4 |
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

## README correction

The root `README.md` **QA Gates** table historically said Gate 1 used Gemini. **Gate 1 uses Claude (Anthropic)** in `lib/gates/gate1.js`. Gemini is used earlier in the flow for **script generation** and later for **assembly/video** gates — see code, not the old README line.
