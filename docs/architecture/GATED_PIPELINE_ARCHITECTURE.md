# CWN Gated Self-Healing Pipeline Architecture

**Author:** Claude Code
**Date:** 2026-04-11
**Status:** 🟢 AUTHORITATIVE — all agents (Claude Code, Cline, Aider, Gemini) must read this before touching pipeline code
**Supersedes:** ad-hoc retry logic, MAX_RETRIES=3 patterns, the current "rollback/force-advance" patchwork
**Related:** `CLINE_HANDOFF_GATE2_SEGMENT_STRUCTURE.md`, `CLINE_HANDOFF_GATE1_CLIP_DIAGNOSTIC_UPGRADE.md`, `ROLLBACK_FORCE_ADVANCE_SPEC.md` (the manual version of what this automates)

---

## Why this document exists

The CWN production pipeline has been shipping fixes for the same class of bugs for days — scene ordering, missing segments, dark frames, "Error response" tickers, clip insertion order, Gate 1 false negatives. Every fix was correct in isolation, but the next bug always surfaced days later after the previous one was forgotten. The pattern:

1. Rob runs a test
2. Rob notices something is wrong by eyeballing the MP4 or the dashboard
3. Rob files a handoff with Cline
4. Cline ships a targeted fix
5. 2-3 days later, a DIFFERENT bug in a DIFFERENT stage surfaces
6. Repeat

**The root cause is not any individual bug.** The root cause is that **the pipeline has no self-inspection.** Every stage produces output, and that output is trusted implicitly. No layer asks "is what I just produced actually correct?" before handing off to the next stage. Bugs survive because nothing is watching for them.

This document describes a replacement pipeline where **every stage has an authoritative QA gate that can reason about failure, propose fixes, execute them, and escalate to Rob only when it has genuinely run out of options.** Rob's role changes from "first line of defense" to "final approver on private drafts on YouTube/TikTok/Instagram."

Once this architecture is in place, future bugs become cheap to fix:
- Bug is introduced somewhere in the code
- Next production run triggers the relevant gate
- Gate catches it, diagnoses it, proposes fixes, tries them, escalates if needed
- Rob sees a specific diagnostic failure with a fix playbook attached, not a 500 MB MP4 to debug manually
- Fix ships, gate protects against regression forever

---

## The 9 Principles

Every line of pipeline code, every gate, every prompt, every handoff doc must obey these 9 principles. They are non-negotiable.

### Principle 1 — Every gate has a designated QA agent

| Gate | Agent | Rationale |
|---|---|---|
| **Gate 1** — Script content QA | Claude (Anthropic) | Claude is strong at text structure analysis, placeholder detection, clip-commentary cross-referencing. Gemini writes scripts, Claude reviews — role separation prevents the author from approving their own work. |
| **Gate 2** — Segment structure QA | Pure code (no AI, initially) + Gemini as judge on ambiguous cases | Segment structure is deterministic — a script with 7 headers and 2 clip markers should produce exactly N segments. This is a counting problem, not a judgment call. Gemini is consulted only when the code-based validator finds ambiguity (e.g., a section has text both before AND after `[CLIP PLAYS HERE]` and the validator isn't sure if the "after" text is a zombie fragment or a real reaction sentence). |
| **Gate 3** — HeyGen segment render QA | Gemini (existing) | Samples first/middle/last segments, scores lip sync/audio/rendering. Already shipped. |
| **Gate 4** — Assembly structure QA | Gemini | Frame-based analysis of assembled MP4. Detects pillarbox, missing overlays, dark frames, scene ordering issues, missing clips. |
| **Gate 5** — Full video playback QA | Gemini (chunked upload for large files) | Full-video review of the assembled MP4. Audio quality, pacing, lip sync across concat boundaries, broadcast readiness. |
| **Gate 6** — Publish delivery QA | Pure code + Upload-Post API response | Confirms Drive upload succeeded, Upload-Post returned job_id, all 3 platforms acknowledged. Deterministic. |
| **Gate 7** — Platform private-draft review | **Rob** (human) | Final sign-off on YouTube/TikTok/Instagram private drafts. Rob is the authority here. |

### Principle 2 — Every gate has a programmatic fix path

When a gate fails, it MUST return:
- A diagnosis of what's wrong
- One or more proposed fix strategies, ranked by confidence
- An explicit rollback target if the fix strategies fail
- Escalation criteria defining when to give up

No gate is allowed to return just "fail." That's a design bug in the gate itself.

### Principle 3 — "Can't fix my own problem" is a design bug

If Gate N can't programmatically fix an issue it caught, that means either:
- The check is in the wrong gate (should be checked earlier, where it CAN be fixed)
- The fix requires a different stage to re-run (rollback target should be defined)
- The issue is genuinely out of the pipeline's ability (user input problem, API outage, etc. — escalate to Rob)

If a gate regularly fails with "can't fix this, giving up" on non-exceptional conditions, THAT is feedback that the architecture needs to move the check to a different layer.

### Principle 4 — Rob is the LAST line of defense

Rob reviews private drafts on YouTube/TikTok/Instagram. Not mid-pipeline. Not on the dashboard unless something has been explicitly escalated via the "authoritatively unfixable" criteria (Principle 6). Every other gate runs automatically, with retry loops driven by collaborative QA dialogue.

Rob's manual involvement is:
- **Pre-pipeline:** choosing streamers, clicking GENERATE, adjusting config
- **Post-pipeline:** reviewing private drafts on platforms, flipping to public if approved
- **Exception path only:** handling jobs the pipeline has escalated after exhausting all fix strategies

Rob is NOT:
- Babysitting the dashboard during assembly
- Manually fixing "ticker shows Error response" or "scenes out of order"
- Re-running failed Gate 1 scripts by eye

### Principle 5 — No arbitrary retry limits. Fix until it's right.

The current `MAX_RETRIES = 3` pattern is forbidden going forward. Instead, gates use two boundary conditions to decide when to stop trying:

1. **Strategy exhaustion:** the gate has proposed all known fix strategies, tried all of them, and the issue persists
2. **Gemini-judged unfixability:** the gate's QA agent reasons about the failure pattern and authoritatively declares the problem is outside its layer's ability to fix

Either condition triggers escalation. Neither is time- or count-based. The pipeline is patient and persistent.

### Principle 6 — QA has authoritative decision power

The gate itself decides "this can move on" vs "this cannot." Not a hardcoded threshold. Not "score ≥90 auto-pass." Score is an INPUT to the gate's reasoning, not the final answer. The gate reasons about whether issues are blocking vs cosmetic, whether they're fixable downstream, whether the video is broadcast-ready.

Examples:
- "Pillarbox white bars on avatar → not fixable at this gate, rollback to Gate 3 (HeyGen re-render)"
- "Minor brightness variance in segment 3 → cosmetic, pass with learning note"
- "Segment 4 is 1 second long when expected 10s → probably a parseSegments zombie fragment, rollback to Gate 2"
- "Audio-video sync off by 1.4s → rollback to Gate 4 (re-concat with aresample)"
- "Gate 1 clip analysis data is incomplete → can't verify CLIP MATCH, but all other checks pass and the script structure is correct → pass with note"

The gate's authority is absolute for its stage. Downstream stages trust it. Upstream stages act on its rollback commands. Rob only sees jobs the gate escalates.

### Principle 7 — Every fix must be documented

When a gate executes a successful fix strategy, it writes a learning record that future agents (Claude Code, Cline, Aider, and Gemini-in-prompt) can read. Two formats:

- **`logs/gate_fixes.jsonl`** — machine-appendable log, one JSON object per fix attempt. Primary write target for gates during runtime.
- **`docs/gate_fixes/<date>_<gate>_<issue>.md`** — human-readable markdown summaries. Generated on a daily cron from `gate_fixes.jsonl` so agents and Rob can browse historical failure patterns.

Every learning record captures:
- Timestamp, job ID, gate name
- The issue (diagnosis + evidence)
- The fix strategies proposed
- The fix strategies tried (in order)
- The strategy that worked (if any)
- The learning note (what this pattern indicates)

Over time, the learning records become a corpus that informs:
- New gate prompt engineering (Gemini gets examples of past failures + successful fixes)
- Root cause analysis across runs ("this ticker bug has been seen 5 times in 2 weeks → static ticker fallback is worth building")
- Escalation decisions ("this is the third time this pattern has escalated → it's genuinely outside pipeline ability, time for a structural fix")

### Principle 8 — Gate diagnostics must identify specific causes

Current example of BAD diagnostic: "hasanabi: 0/2 clips — ⚠️ Not in this episode."

That tells Rob nothing. Is it because Twitch API returned empty? Because GQL resolution failed? Because the MP4 files were too small? Because Gemini couldn't analyze them? Each cause has a different fix.

Every gate diagnostic must distinguish between specific, actionable failure modes. See `CLINE_HANDOFF_GATE1_CLIP_DIAGNOSTIC_UPGRADE.md` for the full Gate 1 upgrade covering the 7+ distinct clip resolution failure modes.

### Principle 9 — QA is a collaborator, not a judge (the keystone)

This is the principle that makes all the others work. The QA gate is playing coach, not umpire. It doesn't just say "FAIL 72/100." It says:

> FAIL 72/100. I see three issues:
>
> 1. Ticker shows 'Error response' — this suggests Puppeteer captured a 404 page.
>    **Try:** verify `http://localhost:8765/tools/cwn_twitch_ticker.html` returns 200.
>    **If that fails:** check the Python static server is running.
>    **If that fails:** the `TICKER_MAP` paths in `server.js` might still be wrong.
>
> 2. Segment 4 (JASON_CLIP1_REACTION) is only 1 second — likely a zombie fragment from
>    `parseSegments` splitting the setup section.
>    **Try:** rollback to Gate 2 and re-parse with `parseSegments_v2`.
>    **If that fails:** check the raw HeyGen video for this segment — if HeyGen returned
>    a short render, rollback further to Gate 3 (re-render that segment).
>
> 3. Scenes appear in correct chronological order per filename numbering — ✅ good.
>
> **Recommended fix order:** Fix #1 first (deterministic). Then #2. If both succeed,
> re-run Gate 4 and expect score ≥90.

The retry loop is a **dialogue** between the fixer (code) and the QA (agent). Each retry tries a different strategy informed by the last failure. The QA adapts its suggestions based on what was already tried. The loop converges on success, or authoritatively declares the failure unfixable and escalates.

This is how humans debug. You don't try the same fix 3 times and give up. You observe the failure, form a hypothesis, test it, observe the new state, refine the hypothesis. The gates will do this, with Gemini/Claude as the reasoning engine.

---

## The Pipeline — 7 stages, 7 gates

```
┌──────────────────────────────────────────────────────────────────────┐
│  STAGE 1: SCRIPT GENERATION                                           │
│  ─────────────────────────────────────────────────────────────────── │
│  Gemini analyzes clips → writes full script using cwn_style_guides    │
│       ↓                                                                │
│  ┌─── Gate 1: Claude Script QA ────────────────────────────────────┐ │
│  │  Agent: Claude (Anthropic)                                       │ │
│  │  Checks: scene count, placeholders, display names, clip match,   │ │
│  │          beat placement, outro, word count, locked intro         │ │
│  │  Diagnostic: specific failure causes per streamer (see Gate 1    │ │
│  │              clip diagnostic handoff)                             │ │
│  │  Fix strategies:                                                  │ │
│  │    1. claudeScriptFix: Claude rewrites problem sections only     │ │
│  │    2. Re-request Gemini with enhanced prompt                      │ │
│  │    3. Backup streamer substitution (if clip fetch failed)        │ │
│  │  Rollback: none (this is the first stage)                        │ │
│  │  Escalation: all strategies exhausted → Rob reviews script       │ │
│  │              editor with specific diagnostic + proposed fixes    │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│       ↓ PASS                                                           │
├──────────────────────────────────────────────────────────────────────┤
│  STAGE 2: SCRIPT → SEGMENT PARSING                                     │
│  ─────────────────────────────────────────────────────────────────── │
│  parseSegments_v2() produces ordered segment array                     │
│       ↓                                                                │
│  ┌─── Gate 2: Segment Structure QA ───────────────────────── NEW ──┐ │
│  │  Agent: Pure code primary, Gemini for ambiguous cases            │ │
│  │  Checks:                                                          │ │
│  │    1. Count: matches 1 + N_streamers × (1 + N_clips × 2) + 1     │ │
│  │    2. Order: matches expected pattern from script header order   │ │
│  │    3. Duplicates: no two segments with same label                │ │
│  │    4. Empty: no avatar segment has <5 words of text              │ │
│  │    5. Clip insertion: each [CLIP PLAYS HERE] has a source_clip   │ │
│  │    6. Clip URL: every source_clip has a valid clipUrl            │ │
│  │    7. Clip order: source_clips appear in the same order as       │ │
│  │       orderedClipUrls                                             │ │
│  │  Fix strategies:                                                  │ │
│  │    1. Re-parse with parseSegments_v2 (if v1 was used)            │ │
│  │    2. Drop zombie empty segments                                  │ │
│  │    3. Re-request script from Gemini with reinforced constraints   │ │
│  │       (rollback to Gate 1)                                        │ │
│  │    4. Fill missing source_clip URLs from CURRENT_META fallbacks  │ │
│  │  Rollback: Gate 1 (regenerate script)                             │ │
│  │  Escalation: all strategies exhausted → Rob reviews segment      │ │
│  │              array + script diff in dashboard                     │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│       ↓ PASS                                                           │
├──────────────────────────────────────────────────────────────────────┤
│  STAGE 3: HEYGEN RENDER                                                │
│  ─────────────────────────────────────────────────────────────────── │
│  Each avatar segment → HeyGen API → video_id → async render            │
│  Each source_clip → download from Twitch CDN → validate                │
│       ↓                                                                │
│  ┌─── Gate 3: HeyGen Segment Render QA (existing) ─────────────────┐ │
│  │  Agent: Gemini 2.5 Flash                                          │ │
│  │  Checks: lip sync, audio presence, rendering artifacts, motion    │ │
│  │  Samples: first, middle, last segments (34 MB Gemini cap)         │ │
│  │  Fix strategies:                                                  │ │
│  │    1. Re-render affected segments with same script text           │ │
│  │    2. Re-render with enhanced phonetic spellings                  │ │
│  │    3. Re-render with different avatar style (closeUp vs normal)  │ │
│  │    4. Re-request text from Claude/Gemini for that segment only   │ │
│  │  Rollback: Gate 2 (re-parse segments) or Gate 1 (regenerate)     │ │
│  │  Escalation: HeyGen API returning consistent errors → Rob checks │ │
│  │              HeyGen credits / API status                          │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│       ↓ PASS                                                           │
├──────────────────────────────────────────────────────────────────────┤
│  STAGE 4: FFMPEG ASSEMBLY                                              │
│  ─────────────────────────────────────────────────────────────────── │
│  Download all segments → normalize to TS → concat with xfade →         │
│  burn intro cards → burn logo → bake ticker → finalize to MP4          │
│       ↓                                                                │
│  ┌─── Gate 4: Assembly Structure QA ────────────────────── NEW ───┐  │
│  │  Agent: Gemini 2.5 Flash                                          │ │
│  │  Inputs: assembled MP4, expected segment structure from Gate 2,   │ │
│  │          frame samples at each segment boundary, ffprobe metadata│ │
│  │  Checks:                                                          │ │
│  │    1. Video dimensions 1920×1080 (long) or 1080×1920 (short)     │ │
│  │    2. Audio + video duration match (AV sync)                     │ │
│  │    3. Segment count in output matches input                      │ │
│  │    4. No pillarbox / white bars on avatar segments                │ │
│  │    5. Ticker visible at bottom with real content (not error)      │ │
│  │    6. CWN logo visible at configured position                    │ │
│  │    7. Intro cards visible top-right at streamer intro timestamps  │ │
│  │    8. Source clips play full-bleed at clip timestamps             │ │
│  │    9. No black / dark frames except intentional fades             │ │
│  │   10. No duplicated consecutive segments                          │ │
│  │  Fix strategies:                                                  │ │
│  │    1. Re-bake ticker (delete cached MP4, re-capture Puppeteer)   │ │
│  │    2. Re-burn logo overlay with correct coordinates               │ │
│  │    3. Re-run FFmpeg concat with explicit frame rate               │ │
│  │    4. Check TICKER_MAP paths if ticker is wrong                  │ │
│  │    5. Rollback to Gate 2 if segment structure issue              │ │
│  │    6. Rollback to Gate 3 if avatar segment issue                 │ │
│  │  Rollback: Gate 2 or Gate 3 depending on root cause              │ │
│  │  Escalation: repeated failures with same issue → check for       │ │
│  │              config drift, file system issues, FFmpeg version    │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│       ↓ PASS (sets status='assembled' — NOT YET 'publishable')         │
├──────────────────────────────────────────────────────────────────────┤
│  STAGE 5: FULL VIDEO QA                                                │
│  ─────────────────────────────────────────────────────────────────── │
│  Chunked upload of assembled MP4 to Gemini Files API                   │
│       ↓                                                                │
│  ┌─── Gate 5: Full Video Playback QA ──────────────────── NEW ───┐   │
│  │  Agent: Gemini 2.5 Flash (chunked for >34 MB)                    │ │
│  │  Inputs: full assembled MP4, Gate 4 report, expected duration    │ │
│  │  Checks:                                                          │ │
│  │    1. Audio quality (no muffled segments, no dropouts)            │ │
│  │    2. Lip sync across concat boundaries                           │ │
│  │    3. Pacing (no segments feel rushed/dragging)                   │ │
│  │    4. Transitions (hard cuts where expected, no stutters)         │ │
│  │    5. Overall "broadcast ready" judgment                          │ │
│  │    6. Content accuracy (does the script match the visuals?)      │ │
│  │  Fix strategies:                                                  │ │
│  │    1. Rollback to Gate 4 (re-assemble with adjusted params)      │ │
│  │    2. Rollback to Gate 3 (re-render specific segment)            │ │
│  │    3. Apply post-processing filter (loudnorm, aresample=async=1) │ │
│  │    4. Topaz enhancement (if subscribed)                          │ │
│  │  Rollback: Gate 4 or Gate 3                                       │ │
│  │  Escalation: Gemini explicitly says "broadcast-ready but with    │ │
│  │              notes" OR "unfixable artifacts at this layer"        │ │
│  │  Passes with notes: flagged for Rob's attention at Gate 7 but    │ │
│  │                     allowed to proceed                            │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│       ↓ PASS (sets status='publishable' — file is now STABLE)          │
├──────────────────────────────────────────────────────────────────────┤
│  STAGE 6: PUBLISH DELIVERY                                             │
│  ─────────────────────────────────────────────────────────────────── │
│  Drive upload → Upload-Post → YouTube / TikTok / Instagram as PRIVATE │
│       ↓                                                                │
│  ┌─── Gate 6: Publish Confirmation ──────────────────────────────┐   │
│  │  Agent: Pure code + Upload-Post API response                     │ │
│  │  Checks:                                                          │ │
│  │    1. Drive upload returned valid URL                             │ │
│  │    2. Upload-Post /api/upload returned job_id                     │ │
│  │    3. All 3 platform responses acknowledge (YT, TT, IG)          │ │
│  │    4. Private/SELF_ONLY flags confirmed in response               │ │
│  │  Fix strategies:                                                  │ │
│  │    1. Retry Drive upload (transient network)                     │ │
│  │    2. Retry Upload-Post with exponential backoff                 │ │
│  │    3. Drop a platform if it consistently fails (e.g., IG down)   │ │
│  │    4. Use filename fallback if driveUrl is unreachable           │ │
│  │  Rollback: Gate 5 (re-run Gate 5 check before retry)              │ │
│  │  Escalation: Upload-Post sustained outage → Rob queues for       │ │
│  │              later, pipeline marks job as "publish_pending"       │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│       ↓ PASS                                                           │
├──────────────────────────────────────────────────────────────────────┤
│  STAGE 7: PLATFORM PRIVATE-DRAFT REVIEW                                │
│  ─────────────────────────────────────────────────────────────────── │
│       ↓                                                                │
│  ┌─── Gate 7: Rob Reviews on YouTube/TikTok/Instagram ────── NEW ─┐  │
│  │  Agent: Rob (human)                                               │ │
│  │  Venue: YouTube Studio, TikTok drafts, Instagram drafts           │ │
│  │  Checks:                                                          │ │
│  │    1. Video looks broadcast-ready on the platform itself          │ │
│  │    2. Thumbnail displays correctly                                 │ │
│  │    3. Title / description / tags / hashtags look right            │ │
│  │    4. Platform-specific formatting (Shorts badge, Reels, etc)    │ │
│  │    5. Any last-minute edits Rob wants (title tweak, etc)         │ │
│  │  Decisions:                                                       │ │
│  │    APPROVE → Rob flips to public (manual or via Upload-Post API) │ │
│  │    REJECT  → Rob specifies reason; pipeline rolls back to Gate 5 │ │
│  │              (or Gate 4, or Gate 1) depending on reason           │ │
│  │    DELETE  → Rob cancels entirely (cost already spent)           │ │
│  │  Rollback: any previous gate depending on Rob's reason             │ │
│  │  Escalation: N/A — Rob is the top of the chain                    │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│       ↓ PUBLIC                                                         │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  🎬 LIVE ON YOUTUBE / TIKTOK / INSTAGRAM                      │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Gate Output Contract

Every gate, regardless of which agent runs it, MUST return the following JSON shape. Pure-code gates produce this directly. AI-backed gates produce it via their reasoning prompts.

```json
{
  "gateName": "gate4_assembly",
  "jobId": "job_abc123",
  "timestamp": "2026-04-11T02:45:12.000Z",
  "attemptNumber": 3,
  "passed": false,
  "score": 72,
  "outcome": "fail_rollback_to_gate2",
  "diagnosis": [
    {
      "severity": "critical",
      "kind": "scene_order_mismatch",
      "issue": "Segment 2 label 'JASON_CLIP1_SETUP (INTRO)' does not match expected 'JASON_CLIP1_SETUP'",
      "evidence": "Intermediate filename: asm_1775885391051_2_jason_clip1_setup_intro_.mp4 contains '_intro_' suffix from parseSegments splitting the setup section",
      "impact": "Scenes appear out of order in final playback, viewer experience broken"
    },
    {
      "severity": "critical",
      "kind": "zombie_empty_segment",
      "issue": "Segment 4 (JASON_CLIP1_REACTION) duration is only 1 second",
      "evidence": "ffprobe shows duration=1.02s for asm_1775885391051_4_jason_clip1_reaction.mp4 — expected ~10s based on script text",
      "impact": "Video jumps to outro after 1 second of reaction, breaks pacing"
    }
  ],
  "fixStrategies": [
    {
      "id": "rollback_gate2_parseSegmentsV2",
      "description": "Rollback to Gate 2 and re-parse the script with parseSegments_v2 (the corrected single-segment-per-section parser). This should eliminate both the zombie fragment and the label split.",
      "confidence": 0.95,
      "action": {
        "type": "rollback",
        "targetGate": "gate2",
        "params": {
          "parserVersion": "v2",
          "reparseFromScript": true
        }
      },
      "estimatedDuration": "30s",
      "reasoning": "The evidence strongly indicates parseSegments_v1 over-split the CLIP_SETUP section. parseSegments_v2 was built specifically to fix this. Re-parsing the existing script with v2 should produce 9 clean segments."
    },
    {
      "id": "regenerate_script",
      "description": "Re-request the script from Gemini with reinforced section structure constraints (Style A: keep clip markers inline with SETUP sections, not separate REACTION headers).",
      "confidence": 0.5,
      "action": {
        "type": "rollback",
        "targetGate": "gate1",
        "params": {
          "promptVariant": "style_a_inline"
        }
      },
      "estimatedDuration": "60s",
      "reasoning": "If parseSegments_v2 also produces incorrect output, the script structure itself may be ambiguous. A style-A script (clip marker inline) would eliminate the ambiguity."
    }
  ],
  "rollbackTo": "gate2",
  "escalationCriteria": "If both fix strategies fail AND the segment structure is still wrong after re-parse + regenerate, escalate to Rob with the full diagnostic trail. Rob should inspect the generated script and decide whether to manually adjust parseSegments or accept a different script structure.",
  "learningNote": "Third time this week a parseSegments zombie fragment has been flagged at Gate 4. Consider making parseSegments_v2 the only version and deleting v1, OR adding a Gate 2 pre-check that catches the count mismatch BEFORE Gate 3 (HeyGen render) is triggered — would save HeyGen credits on doomed scripts.",
  "attemptHistory": [
    {
      "attemptNumber": 1,
      "strategyTried": "re_concat_ffmpeg",
      "result": "fail",
      "note": "Re-concat produced identical output — root cause is upstream in segment structure, not in concat step"
    },
    {
      "attemptNumber": 2,
      "strategyTried": "rebake_ticker",
      "result": "partial",
      "note": "Ticker was fine; re-baking didn't change the scene order issue"
    }
  ]
}
```

### Field semantics

| Field | Type | Required | Notes |
|---|---|---|---|
| `gateName` | string | yes | Used for log aggregation and learning record categorization |
| `jobId` | string | yes | Traces back to the originating job card |
| `timestamp` | ISO-8601 | yes | When this attempt was made |
| `attemptNumber` | int | yes | Starts at 1, increments with each retry at THIS gate for THIS job |
| `passed` | bool | yes | The final verdict of this attempt |
| `score` | int 0-100 | yes | Numeric quality signal; INFORMATIONAL only, not the final decision |
| `outcome` | enum | yes | `pass`, `pass_with_notes`, `fail_fix_in_place`, `fail_rollback_to_gateN`, `fail_escalate_human` |
| `diagnosis[]` | array | yes if failed | Each issue found, with severity, kind, evidence, impact |
| `fixStrategies[]` | array | yes if failed | Proposed fixes, ranked by confidence, with explicit action specs |
| `rollbackTo` | string\|null | yes if outcome is rollback | The gate name to roll back to |
| `escalationCriteria` | string | yes | Human-readable description of when to give up and escalate |
| `learningNote` | string | recommended | Pattern observations for future reference; fed into learning records |
| `attemptHistory[]` | array | yes if attemptNumber > 1 | Summary of previous attempts and their outcomes |

### Outcome enum values

| Outcome | Meaning |
|---|---|
| `pass` | Clean pass. Move to next gate. |
| `pass_with_notes` | Passes the gate's criteria but has cosmetic issues flagged for later gates / Rob's attention. Moves forward but carries notes. |
| `fail_fix_in_place` | Fixable at this gate without rolling back. The fixer should try the proposed strategies, then re-run this gate. |
| `fail_rollback_to_gate<N>` | Cannot be fixed at this gate. The fixer should roll back to Gate N, re-run Gate N (and subsequent gates), then re-run this gate. |
| `fail_escalate_human` | Gate has exhausted all fix strategies and/or determined the issue is outside pipeline ability. Escalate to Rob with full diagnostic trail. |

---

## The Dialogue Loop — How retries actually work

This is the mechanism that implements Principle 9 (collaborative QA).

```
GIVEN: job at gate N, attempt 1, initial state
┌────────────────────────────────────────────────────────────────────┐
│ 1. Fixer calls Gate N(job)                                          │
│                                                                     │
│ 2. Gate N returns Gate Output Contract JSON                         │
│    IF outcome = 'pass':                                             │
│      → Move to gate N+1, done                                       │
│    IF outcome = 'pass_with_notes':                                  │
│      → Record notes, move to gate N+1                               │
│    IF outcome = 'fail_*':                                           │
│      → Continue to step 3                                           │
│                                                                     │
│ 3. Fixer picks highest-confidence fixStrategy                       │
│    Logs: "attempt N.1: trying strategy <id>"                         │
│                                                                     │
│ 4. Fixer executes strategy.action                                   │
│    IF action.type = 'rollback':                                     │
│      → Rolls back to strategy.action.targetGate                     │
│      → Re-runs from there, eventually returning to gate N           │
│      → attemptNumber increments                                     │
│    IF action.type = 'fix_in_place':                                 │
│      → Runs the local fix (e.g., rebake ticker)                     │
│      → Immediately re-calls Gate N                                  │
│                                                                     │
│ 5. Gate N re-runs with full attemptHistory                          │
│    Gate N's prompt now includes:                                    │
│      - Current state (fresh diagnosis)                              │
│      - attemptHistory: [strategy1: tried, result=fail, reason=...]  │
│    Gate N reasons about what to try NEXT given the history          │
│                                                                     │
│ 6. IF outcome = 'pass':                                             │
│      → Log successful fix sequence to gate_fixes.jsonl              │
│      → Write learning record entry                                  │
│      → Move to gate N+1                                             │
│    IF outcome = 'fail_*':                                           │
│      → Gate N MAY propose new strategies based on the history       │
│      → OR Gate N MAY say "I've given you everything I can think     │
│         of, escalate to human" (outcome = fail_escalate_human)      │
│      → Fixer picks next strategy OR escalates                       │
│                                                                     │
│ 7. Loop continues until:                                             │
│    - Gate N returns 'pass' → SUCCESS, move on                       │
│    - Gate N returns 'fail_escalate_human' → ESCALATE to Rob         │
│    - Gate N repeatedly suggests strategies already tried (loop      │
│      detection) → ESCALATE to Rob with "stuck" note                 │
└────────────────────────────────────────────────────────────────────┘
```

**Critical:** there is NO hardcoded retry count. The loop continues until the gate itself says "I'm done trying" OR the fixer detects a stall (same strategies keep getting suggested with no progress). This matches Principle 5.

### Structured history format

When re-calling a gate after a failed attempt, the prompt / input must include:

```json
"attemptHistory": [
  {
    "attemptNumber": 1,
    "strategyTried": "rebake_ticker",
    "resultOutcome": "fail_rollback_to_gate2",
    "resultScore": 72,
    "newDiagnosis": "Ticker rebake succeeded but scene order issue remains",
    "timestampTried": "2026-04-11T02:45:12.000Z"
  },
  {
    "attemptNumber": 2,
    "strategyTried": "rollback_gate2_parseSegmentsV2",
    "resultOutcome": "fail_fix_in_place",
    "resultScore": 84,
    "newDiagnosis": "Segment count correct now (9) but segment 4 still has audio muffling",
    "timestampTried": "2026-04-11T02:46:38.000Z"
  }
]
```

This gives the gate's AI reviewer the full context of what's been tried and lets it propose genuinely new strategies instead of repeating failed ones.

---

## Loop Detection (preventing infinite retries)

Even without a hardcoded retry count, we need a safety mechanism to detect when the pipeline is stuck in a loop. The fixer implements:

**Stall detection:** If the last 3 strategies suggested by a gate have already appeared in `attemptHistory` with the same outcome, the fixer treats this as a stall and forces escalation.

**Score drift detection:** If the gate's score has oscillated without improving for 5 consecutive attempts (e.g., 72 → 84 → 72 → 80 → 72), the fixer escalates.

**Wall-clock sanity:** A single gate retry loop should not exceed 30 minutes of wall time. If it does, escalate. (This is a safety net, not a hard limit per principle 5 — under normal operation loops should converge in 2-5 retries, well under 5 minutes.)

All three conditions are ORed together. Any one triggers escalation to Rob with full trail.

---

## AI Video Analysis — Known Reliability Limits

### Gemini video analysis — known reliability limits (smoke test #8 finding)

**Finding (April 2026, smoke test #8):** Gemini 2.5 Flash fabricates clip presence and timestamps when prompted with an expected count.

**What happened:** The Gate 3 QA prompt included the phrase "there should be N clips" in the context block. Gemini reported 5 clips with plausible-sounding timestamps even though only 1 real Brightcove HLS clip existed in the assembled video. Frame extraction via FFmpeg proved 4 of the 5 reported clips were fabricated — Gemini invented timestamps and described content that was not present.

**Root cause:** Large language models (including Gemini) are susceptible to anchoring bias when given an expected count. The model pattern-matches to satisfy the stated expectation rather than reporting what it actually observes.

**Rule — never prompt Gemini with expected clip counts:**
- ❌ WRONG: "There should be 5 clips in this video. Verify each one."
- ✅ RIGHT: "Watch this video and report how many distinct source clips you observe, if any."

**Verification method:** Always use ffprobe/FFmpeg frame extraction to verify clip presence — not Gemini. Gemini is reliable for qualitative QA (lip sync, audio quality, freeze detection) but unreliable for counting discrete segments when primed with an expected number.

**Consequence:** The `scripts/audit_news_clips.js` script was deleted (commit `76779ee`) because it used Gemini for clip verification with an expected-count prompt — actively misleading. Do not recreate it.

**Safe uses of Gemini video analysis:**
- Lip sync quality (PASS/FAIL)
- Audio clarity (PASS/FAIL)
- Video freeze detection (PASS/FAIL)
- Avatar framing (PASS/FAIL)
- Qualitative content description (what is happening in the video)

**Unsafe uses of Gemini video analysis:**
- Counting clips when primed with an expected number
- Verifying exact timestamps of segment boundaries
- Any task where the prompt contains "there should be N" or "verify that N clips exist"

---

## Save Points and Rollback Mechanics

Each stage's successful output is persisted via `saveJobCard()` to `data/jobs.json`. This gives the pipeline cheap rollback — you don't re-run previous successful stages on retry, you reuse their saved output.

**Per-stage save points:**

| Stage | Saved fields | Used for rollback |
|---|---|---|
| Stage 1 (script) | `script`, `wordCount`, `estSecs`, `orderedClipUrls`, `analyses`, `streamers` | rollback target for Gate 2/3/4/5 |
| Stage 2 (segments) | `segments[]`, `segmentCount`, `clipInsertPositions` | rollback target for Gate 3/4/5 |
| Stage 3 (HeyGen) | `heygen.videoJobs[]` with video_ids, final URLs, status | rollback target for Gate 4/5 |
| Stage 4 (assembly) | `outputPath`, `outputSize`, `totalDuration`, `segmentDurations` | rollback target for Gate 5 |
| Stage 5 (full QA) | `gate5Score`, `gate5Notes`, `driveUrl` | rollback target for Gate 6 |
| Stage 6 (publish) | `publishRecord`, platform job_ids | rollback target for Gate 7 (Rob review) |

**Rollback semantics:**

When Gate N says "rollback to Gate M":
1. Fixer deletes the saved state for stages M through N-1 (but KEEPS stage M's inputs)
2. Fixer re-runs Stage M with the retained inputs, which produces fresh outputs for M, M+1, ..., N-1
3. Each intermediate gate runs normally
4. Finally Gate N re-runs with the new state

**Example:** Gate 4 fails and rolls back to Gate 2.
1. Delete: `segments[]`, `heygen.videoJobs[]`, `outputPath`, `assembly*` fields
2. Re-run Stage 2: parseSegments_v2(script) → new segments[]
3. Stage 3 re-runs: re-sends to HeyGen (uses cached video_ids if still valid, otherwise re-renders)
4. Stage 4 re-runs: re-downloads segments, re-assembles
5. Gate 4 re-runs with the new output

**Cost of rollback is variable.** Gate 4 → Gate 2 is cheap (no HeyGen cost if video_ids are still valid). Gate 5 → Gate 3 is expensive (re-renders HeyGen segments). Gate 4's choice of rollback target must weigh this cost against the chance of success. The fix strategies' `confidence` field should factor in the cost.

---

## Learning Records

### `logs/gate_fixes.jsonl` (primary write target)

Append-only JSONL file. Each line is one successful or failed fix attempt. Written by the fixer at runtime after each gate call resolves.

**Example line:**
```json
{"timestamp":"2026-04-11T02:47:15.000Z","jobId":"job_abc123","gate":"gate4_assembly","attemptNumber":2,"strategy":"rollback_gate2_parseSegmentsV2","outcome":"pass","priorDiagnosis":["segment_count_mismatch","zombie_empty_segment"],"postScore":95,"learningNote":"Third time parseSegments zombie fragment flagged this week — consider deleting v1"}
```

### `docs/gate_fixes/<YYYY-MM-DD>_<gate>_<issue>.md` (daily summaries)

Generated by a cron from `gate_fixes.jsonl`. Each day, group fixes by gate and issue kind, write a human-readable summary. Agents and Rob read these when debugging new bugs.

**Example summary:**

```markdown
# 2026-04-11 — Gate 4 parseSegments zombie fragment

**Count:** 3 jobs affected this day
**Root cause:** parseSegments_v1 splits CLIP_SETUP sections into 3 sub-segments
**Winning fix strategy:** rollback_gate2_parseSegmentsV2 (100% success rate, 3/3)
**Average fix time:** 42 seconds per job
**Pattern note:** All affected jobs were smoke tests with clipsPerStreamer=1, suggesting
the bug is maximally exposed at N=1 but also present at N=2 (just less visible).

**Jobs affected:**
- job_abc123 (1 streamer × 1 clip) - fixed in 38s on attempt 2
- job_def456 (1 streamer × 2 clips) - fixed in 45s on attempt 2
- job_ghi789 (1 streamer × 1 clip) - fixed in 43s on attempt 2

**Recommendation:** Delete parseSegments_v1 entirely. It has no known successful use cases
in the last 10 runs. parseSegments_v2 is the only version that produces correct output.
```

This learning record, generated daily, becomes the debugging bible for future agents. When a new parseSegments-adjacent bug surfaces in 3 weeks, an agent greps `docs/gate_fixes/` for relevant patterns and instantly sees the history.

---

## Gate 7 — Platform Private-Draft Review (Rob's actual role)

Gate 7 is distinct from all others because Rob is the agent. This is formalized because it changes how the pipeline reports "done":

**Old model:** "Job is done when assembly completes" (status='done' at server.js:4187). Race conditions everywhere.

**New model:** "Job is done when Rob approves the private draft on the target platform." Every other 'done' is actually an intermediate state.

### Stage 7 workflow

1. Gate 6 confirms Upload-Post returned job_ids for all 3 platforms
2. Pipeline marks job as `platform_review_pending` in the dashboard
3. Dashboard shows a link card per job: "YouTube Studio [link] | TikTok Drafts [link] | Instagram Drafts [link]"
4. Rob clicks through to each platform and reviews the private draft
5. For each platform, Rob takes one of three actions:
   - **APPROVE** — flips to public (manual in the platform OR via "Approve" button in dashboard → dashboard calls Upload-Post API to update visibility)
   - **REJECT** — opens a dialog: "Why?" — Rob picks from structured reasons:
     - Audio quality bad → rollback to Gate 5
     - Wrong visual layout → rollback to Gate 4
     - Script content wrong → rollback to Gate 1
     - Wrong streamer clip → rollback to Gate 2
     - Title/description issue → edit metadata without rollback
   - **DELETE** — cancels the job entirely, deletes platform drafts, marks job as `cancelled`
6. Once all 3 platforms are approved (or the specific subset Rob cares about), job is marked `published`

### Escalation from other gates to Rob

When an earlier gate escalates to Rob (outcome = `fail_escalate_human`), the job card in the dashboard surfaces with:
- A red ESCALATED badge
- The full diagnosis from the failing gate
- The attempt history (what was tried and failed)
- The gate's escalation criteria explanation
- Action buttons: "Retry (manual override)", "Rollback to <gate>", "Edit script/config and resume", "Cancel job"

Rob's escalation-response UX is designed to be fast — structured options, not free-form debugging. The most common escalations should be resolvable in <1 minute of Rob's attention.

---

## Cost Model (projected)

Current pipeline:
- Script gen: ~$0.05 (Gemini + Claude QA) × 60 long-form + 180 shorts = ~$12/month
- HeyGen: $1.60 × 60 long-form = ~$96/month (shorts are cheaper per segment)
- Current total: ~$381/month

Added cost from gated architecture:
- Gate 4 Gemini calls: ~$0.05 per attempt × avg 2 attempts × 240 jobs = ~$24/month
- Gate 5 Gemini chunked calls: ~$0.08 per attempt × avg 2 attempts × 240 jobs = ~$38/month
- Gate 2 is pure code: $0
- Gate 1 upgrades: negligible (just better prompts)
- Rollback-driven HeyGen re-renders: ~5% of jobs × $1.60 = ~$8/month
- **Total new cost: ~$70/month**

New pipeline total: ~$451/month

**Value trade:** $70/month eliminates ~60% of Rob's manual debugging time (estimated from days-of-struggle pattern). If Rob's time is worth >$2/hour, this is a massive ROI. Plus, the pipeline becomes actually automatable and scalable.

---

## Implementation Phases

This architecture cannot ship in one commit. It ships in phases, each independently deployable and testable.

### Phase 1 — Gate 2 (segment structure) + parseSegments_v2

**Ships next.** Covered in `CLINE_HANDOFF_GATE2_SEGMENT_STRUCTURE.md`. This is the most urgent because:
- It catches the current scene ordering bug that's been blocking smoke tests for days
- It's pure code (no Gemini cost)
- It's the smallest possible first gate — a proof of concept for the architecture

### Phase 2 — Gate 1 diagnostic upgrade

**Ships in parallel with Phase 1.** Covered in `CLINE_HANDOFF_GATE1_CLIP_DIAGNOSTIC_UPGRADE.md`. This is important because:
- Gate 1 already exists, just needs better diagnostic output
- Specific clip-failure causes unblock faster Rob decisions when clips are unavailable
- Low-risk change (doesn't alter scoring or retry behavior, just improves the report)

### Phase 3 — Gate Output Contract adoption in Gate 1 + Gate 3

Rewire existing Gate 1 and Gate 3 to use the new contract format. This is prep work for Gates 4 and 5.

### Phase 4 — Gate 4 (assembly structure)

Full Gemini-backed assembly QA with frame sampling. Rollback logic to Gate 2 and Gate 3. This is where the real automation value comes online.

### Phase 5 — Gate 5 (full video playback)

Chunked video upload to Gemini Files API, full playback QA, rollback to Gate 4 / Gate 3.

### Phase 6 — Gate 7 (Rob platform review workflow)

Dashboard UX for the post-publish review flow. Link cards, structured reject reasons, rollback triggers.

### Phase 7 — Loop detection + learning records

The infrastructure that makes the whole thing reliable: stall detection, score drift detection, learning record logging.

### Phase 8 — Delete the legacy code paths

Once all gates are in place and production-proven, delete:
- `parseSegments_v1`
- The hardcoded `MAX_RETRIES = 3` patterns
- The manual dashboard force-advance buttons (replaced by automatic rollback)
- The `docs/archive/` directory of superseded specs

---

## Rules of Engagement for Agents

Every agent (Claude Code, Cline, Aider, Gemini as a QA backend) must follow these rules when interacting with the gated pipeline:

### Rule 1 — Never skip a gate

Under no circumstances should any agent bypass a gate by direct state manipulation. If a gate needs to be overridden, use the documented force-advance mechanism (which marks the gate as `forced` and logs the override) — never set status fields directly.

### Rule 2 — Never hardcode retry limits

Every retry loop in the codebase must be driven by the Gate Output Contract's `outcome` field. No `for (let i = 0; i < 3; i++)` patterns. Loops end when the gate says they end.

### Rule 3 — Always write to the learning record

Every gate call that results in a fix attempt must append a line to `logs/gate_fixes.jsonl`. This is how the corpus of fix knowledge grows over time. Skipping this is forbidden.

### Rule 4 — Every handoff doc includes a teaching section

When writing a handoff to Cline (or any agent), the doc must include a "Why this works" section explaining the architectural reasoning, not just the code spec. This is Principle 7 — documentation is not optional.

### Rule 5 — Gate outputs must be actionable

When a gate fails, its output must propose concrete actions with enough detail for the fixer to execute them without asking follow-up questions. Vague diagnoses like "script quality is low" are forbidden. Specific diagnoses like "segment 4 has only 3 words of text, below the 5-word minimum for a valid avatar segment, at position [4] in segments array" are required.

### Rule 6 — Cost-aware rollbacks

When proposing a rollback, the gate must consider the cost of re-running intermediate stages. Rolling back to Gate 1 is cheap (~$0.10). Rolling back to Gate 3 is expensive (HeyGen credits, ~$1.50 per full re-render). The `confidence` field in fix strategies must account for this.

### Rule 7 — Honesty about uncertainty

If a gate is uncertain about a diagnosis, it must say so. Proposing a fix with 0.3 confidence is valid. Proposing a fix with 0.9 confidence you're not sure about is a violation. The learning record will eventually reveal which gate's confidence ratings are well-calibrated and which aren't.

---

## Migration from current pipeline

The current pipeline has many of the patterns this architecture forbids:
- Hardcoded `MAX_RETRIES = 3` in several places
- `status = 'done'` set BEFORE post-processing finishes
- No Gate 4 or Gate 5 — assembly just writes to disk and moves on
- Gate 1 and Gate 3 have rudimentary retry logic that doesn't use fix strategies
- `parseSegments_v1` is the only parser, with no validation gate

**Migration is gradual, not all-at-once.** Each phase ships a working subset. The current pipeline continues running during migration — old gates pass their outputs to new gates which wrap them with the new contract. Once a gate is fully migrated, its old form is deleted.

**No flag day.** No "everything breaks until we finish migrating." Each phase must leave the pipeline in a working state, even if some gates are still using old-style returns.

---

## What this means for Rob

- **You stop watching assembly logs.** Gate 4 watches them for you.
- **You stop eyeballing MP4s.** Gate 5 does that.
- **You stop getting confused about which button to click.** The dashboard surfaces only jobs that need your attention, with structured options.
- **You stop losing credits to stale jobs.** Persistence is tied to gate state, and gates can autonomously delete their own failed attempts.
- **You start spending your time on the two things only a human can do:** creative direction (what to make, what to say) and final approval on platforms (does the finished video represent the brand well).
- **Your "days of struggle" bugs become 5-minute fixes.** When a pattern fails, a gate catches it, fixes it, and documents the fix. The next time the same pattern appears, the gate fixes it automatically.

---

## What this means for future agents

- **Start every new session by reading this doc** AND `STATUS.md` AND `CLAUDE.md`. This is the pipeline's constitution.
- **Before adding any retry logic, check if it fits the Gate Output Contract pattern.** If not, restructure.
- **Before fixing a bug directly, ask: which gate should have caught this?** If the answer is "no gate currently catches it," add the check to the relevant gate instead of patching the symptom.
- **Read `logs/gate_fixes.jsonl` before proposing a fix.** The answer to your problem might already be documented.
- **Never trust a "done" signal that isn't tied to a gate.** The only authoritative done is Gate 7 (Rob approved on platform).

---

## Intro card design by content type — authoritative reference

**As of 2026-04-11, all 3 content types use the SAME TV-rectangle visual design** for brand consistency. Gates and handoffs must treat them uniformly.

| Content type | Intro card style | Source data | Example |
|---|---|---|---|
| **Twitch** | **TV-shape rectangle** — 640×360 with streamer profile image, name, origin, fact, gold 5px #c7af4f border, drop shadow | `data/streamers.json` roster entries (profileImage, displayName, origin, fact) | "Jason / Arlington / Dep Gai guy" card with his profile image |
| **NBA** | **TV-shape rectangle** — 640×360 with game thumbnail, team logos, scores, PPG leaders, W/L records, gold 5px border, drop shadow | ESPN API game data + SEASON_LEADERS object | Lakers vs Celtics card with scores and leaders |
| **News** | **TV-shape rectangle** — 640×360 with Open Graph scraped article image, headline, source, gold 5px border, drop shadow | Scraped from article URL (OG image + headline) | "Major Tech Announcement / TechCrunch" card |

All 3 cards burn into the same `OVERLAY_ZONE` at `{x: 1240, y: 40, w: 640, h: 360}` as of commit `0d13fb0`. All 3 share the same dimensions, border, shadow, and positioning — only the content inside the rectangle differs.

**Historical context — design reversal 2026-04-11:**

Until 2026-04-11, Twitch used a different design: a 720×840 canvas with a circular streamer profile image (160px radius) in a gold ring, with name/origin/fact text rendered BELOW the circle. NBA and News used the 640×360 TV-shape rectangle.

Rob reversed this spec on 2026-04-11 morning for brand consistency: **all 3 content types now use the TV rectangle.** The Twitch circle design is deprecated.

**Code status:**
- NBA and News already render as TV-shape rectangles (no change needed)
- Twitch still renders the legacy 720×840 circle design via `generateIntroCardPNG()` at `server.js:500`
- Migration spec: `CLINE_HANDOFF_TWITCH_INTRO_CARD_TO_TV_DESIGN.md` (Cline to implement)

**Gate 4 implication:** when Gate 4 checks for "intro card visible top-right at streamer intro timestamps," it should look for the **SAME visual pattern across all 3 content types**: a rectangular card with gold border at `OVERLAY_ZONE`. This simplifies Gate 4's detection logic (single visual pattern to recognize) vs. the previous version (2 different patterns to distinguish). **Do not build Gate 4 detection logic until Twitch migration to TV design is complete** — otherwise Gate 4 would need transition-period logic to handle both styles.

---

## Related documents

- `CLINE_HANDOFF_GATE2_SEGMENT_STRUCTURE.md` — Phase 1 implementation spec
- `CLINE_HANDOFF_GATE1_CLIP_DIAGNOSTIC_UPGRADE.md` — Phase 2 implementation spec
- `ROLLBACK_FORCE_ADVANCE_SPEC.md` — existing manual version of what this automates
- `QA_GATES.md` — original gate spec (partial, pre-architecture)
- `STATUS.md` — current pipeline state
- `CLAUDE.md` — project-wide rules of engagement

---

*This document is the authoritative source of truth for pipeline architecture. Any code or handoff that contradicts it must be reconciled through an explicit amendment to this doc, not through silent divergence. Last updated 2026-04-11 by Claude Code. Review and amendment authority: Rob.*
