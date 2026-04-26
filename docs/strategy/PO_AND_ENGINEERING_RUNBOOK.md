# Product owner ↔ engineering runbook (AuraFlux)

**Audience:** Rob (product) and whoever is lead on code (Claude / Cursor / human).  
**Purpose:** Clear handoffs so you are not expected to read code, and engineering is not expected to guess priorities.

**Last updated:** 2026-04-21

---

The same story in **engineering form** (layers, stages, three ways to start, monitoring) is maintained in **`docs/architecture/SYSTEM_ARCHITECTURE.md`** and updated as the product evolves.

---

## What the PDFs say (single source of truth for UX)

### End users (`Untitled design.pdf`)

- **Three ways to start:** (1) **Use my content** — upload clips / footage. (2) **Link content** — Twitch, YouTube, or any URL. (3) **Start from idea** — prompt or topic.
- **What the product does in one line:** finds moments → builds content → produces video → publishes to TikTok, YouTube, Instagram, and more.
- **Output shapes:** short-form (TikTok, Shorts, Reels) and long-form + compilations.

### Internal / system (`Untitled design (1).pdf`)

- **High-level flow:** input sources → **spec builder** (Gemini) → **Node engine** (`server.js` orchestration) → **BullMQ + Redis** (queues) → **storage** → **distribution**.
- **Pipeline stages (conceptual):** source ingestion → story engine → scene engine → **QA gates** → **video production** (FFmpeg, etc.).
- **Monitoring:** job tracing, queue health, failure detection, **New Relic**, API latency.

This matches the **direction** of the current monolith; it is not a claim that every box is fully built to product polish yet.

---

## How we work (non-coder friendly)

| Role | Owns |
|------|------|
| **You (PO)** | Priorities, “done” for a milestone, access to accounts when we ask, approving spend (HeyGen, APIs), occasional **manual checks** in YouTube/Studio, and “this feels wrong” feedback with screenshots or job IDs. |
| **Lead on code** | `cursor.md` / `CHANGE_IMPACT_MAP` awareness, what ships in each change, when it is safe to deploy, and a **short list of asks** (below). |

**You do not need to** edit JSON, read stack traces, or know FFmpeg. You **do** need to paste job IDs or say which dashboard card failed when something looks off.

---

## When we will ask you for things

We only ask when unblocked in no other way:

1. **API keys / tokens** (already in your world): Anthropic, Gemini, HeyGen, Twitch, New Relic **license** key (40-char, not the wrong key type), Google/OAuth for Drive, etc. We will name **which** key and **where** it goes (e.g. Render env, local `.env`—never commit values).
2. **Accounts & billing:** e.g. Render plan, RunPod/ComfyUI *later* if that product line spins up, domain for production URL.
3. **Decisions in plain English:** e.g. “Is MVP launch **news + twitch long-form** only, or all three types?” “Do we require Drive upload on every run for v1?”
4. **A human run:** e.g. “Kick off this test batch from the dashboard and tell me the four job IDs” or “Approve $X HeyGen for this run.”
5. **Access for reviewers:** e.g. GitHub, Render, New Relic dashboard—if someone else needs to see the same.

We will **not** ask you to “fix the bug in gate3a” without giving you a **one-line impact** in product terms.

---

## Backend vs PDF — honest snapshot (as of 2026-04)

| PDF concept | In this repo (typical) |
|-------------|-------------------------|
| Node engine / gates / FFmpeg / Gemini / HeyGen / Puppeteer / Canvas | **Largely present** — the production pipeline. |
| BullMQ + Redis | **Dependencies exist**; **full** queue-based UX parity with the diagram may still be **incremental** (see roadmap / `STATUS.md`). |
| “Twelve Labs” in the diagram | **Not** a required path in code today; treat as **optional** future integration unless you reprioritize. |
| Vercel / Next.js end-user app | **Not** this repository’s `cwn_production.html` alone; a **separate** frontend or Phase 2 app if you want that exact “three ways to start” as a product shell. |
| New Relic | **Wired in**; you still need a **valid license key** in env for production. |
| Distribution to all platforms | **Partially** automated; some steps remain manual per your existing publish runbooks. |

The **launch plan and test matrix** in `docs/ops/LAUNCH_PLAN_2026.md` and `docs/ops/LAUNCH_TEST_MATRIX.md` are the **engineering gate**; your PDFs are the **north star** for what customers eventually see.

---

## What “running point on code” means in practice

1. **I (lead implementer) translate** the PDFs into **ordered** work: pipeline stability first, then deploy, then decoupled UI/RunPod if still the strategy.  
2. **I tell you** when a milestone needs **keys, money, or a go/no-go**—in one message, not a wall of tech.  
3. **You tell me** if the **user story** in the PDF changed (e.g. drop “Start from idea” for v1). That **is** a valid product input.

When in doubt, the question back to you will be: *“For this release, which user path from the deck must be true: upload only, or links, or both?”*—not *“should we use Redis cluster?”*

---

## One-liner to remember

**You own the “what and why” from the PDFs. Engineering owns the “how” in the repo, and will ask only for keys, access, and decisions you cannot infer.**
