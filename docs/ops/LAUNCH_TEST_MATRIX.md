# Launch test matrix — Block 2

**Gate:** Nothing downstream of production (publish hardening, Render, brand rename at scale) should start until this matrix is **intentionally** signed off.

**Last updated:** 2026-04-21

**Customer 0 execute order (frozen for current Phase A):** see **`STATUS.md` → Phase A → “Agreed run sheet”** — NBA 1-clip LF → News 1-clip LF → Twitch 2-clip LF (Jason) → NBA short. The six-case table below remains the **general** matrix template.

**Pass criteria for a case:** align with **`STATUS.md` → Definition of done (full job run)** — all gates, creative/overlay spec, and a usable video in `output/` (or agreed path). Gate 0/1 or script-only success does **not** count as matrix pass.

---

## A — Six end-to-end cases (minimum)

| Case | Configuration | Pass criteria (adjust to your launch bar) |
|------|----------------|------------------------------------------|
| E1 | **One-clip** — News long-form | Full pipeline: all gates pass, creative/overlay meet spec, **usable video** in `output/` (or agreed path). |
| E2 | **One-clip** — NBA long-form | Same — not “Gate 1 only.” |
| E3 | **One-clip** — Twitch long-form | Same. |
| E4 | **One-clip** — fourth type as needed (e.g. repeat Twitch with different source) | Same. |
| E5 | **Long-form** — full path (not 1-clip) for one content type you consider riskiest | Same; typically News or Twitch per `STATUS.md` focus. |
| E6 | **Short-form** — `twitch-short` (or your canonical short template) | Full short pipeline + spec-meeting asset; 9:16; no silent HeyGen unless explicitly waived. |

*The source text “4×1-clip + 3×long-form + 1×short-form” is **8** runs; the table above is the **minimum 6 E2E** contract. If you need all eight, add two more rows (e.g. second short variant + extra long-form).*

---

## B — Three full long-form runs (full clip/story counts)

| Run | Content type | Requirement |
|-----|----------------|------------|
| L1 | NBA | Use **full** item/clip count for a real episode (not a 1-clip smoke). |
| L2 | News | Same. |
| L3 | Twitch | Same. |

Record: `jobId`, start time, end time, final gate outcome, and link or path to final asset.

---

## C — After matrix

- Append a one-paragraph summary to `STATUS.md` (or test log) with pass/fail and any waivers.  
- If any case fails, open or update a handoff in `docs/handoffs/` before declaring launch-ready.
