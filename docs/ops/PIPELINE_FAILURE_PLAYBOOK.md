# Pipeline failure playbook (when automation alone doesn’t turn green)

**Purpose:** Code, gates, and dashboards narrow the problem — they don’t replace a **repeatable human loop** when a job stays red or never reaches a **usable video** per `STATUS.md` → Definition of done (full job run). Use this doc whenever “everything else” has not produced a pass.

**Authoritative bar:** `STATUS.md` — all gates pass, creative/overlay meet spec, **usable video** in `output/` (or agreed handoff). Script `200`, Gate 0/1, or partial `pipeline_events` progress are **milestones**, not launch green.

---

## Evidence to pull first (same order every time)

1. **`logs/pipeline_events.jsonl`** (or equivalent bus) — last `gate:*` / `pipeline:*` for the `jobId`.
2. **`output/run_metrics_*.json`** for that run — gate scores and fail reasons, if present.
3. **Job row / `job_spec`** — `state.automation`, linked `semanticJobId` / `scriptJobId`, last gate.
4. **Application logs** — assembly, HeyGen, chrome/Gemini steps matching the failure gate.

Write down: **jobId**, **last gate that ran**, **hard_fail vs soft**, **one-line error string**. If you can’t name the gate, you’re not ready to fix anything.

---

## Step 1 — Classify the failure (which layer?)

Map the symptom to a **layer**, then only fix tools for that layer:

| Layer | Typical signals | Wrong fix |
|-------|-----------------|-----------|
| **Inputs / Gate 0** | Missing clip URL, bad scrape, empty items | Tuning Gate 3 when data never arrived |
| **Script / Gate 1** | Fabrication, wrong items, sports facts not in clip + authorized facts | More overlay work |
| **Chrome / Gate 3a–3b** | `chromeCorrect`, `flagAccurate`, `sidebarAccurate`, layout vs `designSpec` | Rewriting script only |
| **Render / assembly / synth** | FFmpeg, HeyGen, concat, upload | Changing Claude prompts |

If classification is wrong, the next steps waste days. **Confirm the gate** before editing prompts or env flags.

---

## Step 2 — RCA in one sentence (root cause, not symptom)

Produce a single sentence you could put in a ticket:

- *Bad:* “Gate 3 failed.”
- *Good:* “Gate 3a hard-failed because Gemini marked `sidebarAccurate=false` while broadcast chrome was required in spec.”
- *Good:* “Gate 1 flagged fabrication — script named a player not present in clip analysis or AUTHORIZED FACTS.”

That sentence tells you **whether** to change prompts, data, overlay code, thresholds, or scope.

---

## Step 3 — Thresholds vs product (tune, fix, or waive — explicitly)

Pick **one** primary action:

1. **Fix the underlying issue** — bad URL, wrong prompt, chrome bug, assembly bug. Prefer this.
2. **Tune scoring or prompts** — if the bar is right but the model is noisy; document what changed and why.
3. **Product waiver** — only when shipping something **without** meeting the normal bar: document **who** accepted it, **what** is waived (e.g. `GATE3A_CHROME_STRICT=false` for a campaign), and **until when**. Silent “ignore red” is not a waiver.

**Never** confuse “we’re tired of retries” with “pass.”

---

## Step 4 — Do not treat red as idle

A job that is **still failing** needs one of:

- A **tracked fix** (issue/PR/handoff) tied to the RCA sentence, or  
- A **documented waiver** (above), or  
- A **deliberate stop** (job dismissed / scope dropped) with reason.

**Do not** report Phase A green, launch-ready, or “mostly working” without a usable video and an honest status. Partial progress belongs in logs and STATUS as **partial**, not success.

---

## Related docs

- `STATUS.md` — definition of done, current locks  
- `docs/ops/LAUNCH_TEST_MATRIX.md` — what “pass” means per case  
- `cursor.md` — full-job success vs milestones  
- `docs/architecture/GATED_PIPELINE_ARCHITECTURE.md` — gate sequence and responsibilities  

**Last updated:** 2026-04-21  
