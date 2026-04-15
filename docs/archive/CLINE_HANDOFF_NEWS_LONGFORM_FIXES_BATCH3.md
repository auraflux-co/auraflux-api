# CLINE_HANDOFF_NEWS_LONGFORM_FIXES_BATCH3.md

**Author:** Claude Code (dispatched 2026-04-12, post-smoke-test-1 script review)
**For:** Cline (implementation)
**Scope:** News long-form — rewrite the News Gemini prompt to eliminate the INTRO/SETUP repetition pattern and rename the misleading `STORY#_CLIP_REACTION` scene to `STORY#_SUMMARY`.
**Ship order:** Single commit.
**Do NOT touch:** NBA, Twitch, short-form, assembly code, heygen-poller, parseSegments_v2, or any News video source ingestion work (that's batch 4, separate dispatch).
**Before committing:** Re-read `COMMIT_CHECKLIST.md` — atomic staging, STATUS.md update, `.md` doc sync.

---

## Context — why this fix exists

Rob reviewed the Gate 1 script from today's News smoke test #1 (jobId `script_news_1776029172144`) and flagged that every story has the same four-beat redundancy:

1. **STORY#_INTRO** delivers the headline + context
2. **STORY#_SETUP** restates the headline with different words (no new info)
3. **STORY#_CLIP_REACTION** a short quip that was supposed to be PIP over the clip but isn't (PIP doesn't exist in assembly today)
4. **STORY#_REACTION** another short quip about the same story

With two near-identical setup beats and two unconnected quip beats, Bobby G sounds like he's rephrasing himself. Example from today's run, story 1:

- **STORY1_INTRO:** *"First up, the ceasefire between Iran and the U-S remains incredibly fragile. Many are wondering if this truce will actually lead to lasting peace, or simply a pause before more conflict."*
- **STORY1_SETUP:** *"The current truce between Iran and the U-S is being closely watched, with analysts debating its potential for stability. The question remains whether this agreement is a genuine step towards de-escalation or merely a temporary cessation of hostilities."*
- **STORY1_CLIP_REACTION:** *"It appears the definitions of peace and war are quite fluid these days."*
- **STORY1_REACTION:** *"It's always nice when people agree to stop for a moment."*

The repetition is baked into the prompt at `server.js:6685-6737`:

- **SETUP's rule** is *"First sentence: context about what happened. Second sentence: specific setup for the clip."* — but "context about what happened" is the same job INTRO already has. In a world with real video clips, the second sentence diverges because it primes a specific visual. With no clips today, SETUP has nothing to prime, so Gemini falls back to generic expansion of INTRO.
- **CLIP_REACTION's rule** is *"Bobby's live reaction WHILE watching the clip. This will be picture-in-picture with the clip."* — PIP is not implemented in the current assembly path and is unlikely to exist. The scene gets rendered as a standalone Bobby G avatar beat with a single quip, which then gets followed by REACTION's single quip, producing two unconnected one-liners back-to-back.

Rob's proposed structure fixes both issues without changing scene count (stays at 4 per story, still `1 + items×4 + 1 = 42` for 10 stories):

1. **STORY#_INTRO** — unchanged (2-3 sentences, headline + context)
2. **STORY#_SETUP** — redefined as **1 sentence, a new fact or hook** that gives the viewer a reason to watch the clip. Not a summary, not a restatement. Must introduce information INTRO did not.
3. **STORY#_CLIP_REACTION** → **renamed to STORY#_SUMMARY**. New job: **1-2 sentences factual recap of what just played in the clip**. No reaction, no quip. Serves as the bridge between clip-end and the deadpan take.
4. **STORY#_REACTION** — unchanged (1 sentence, deadpan quip)

The `[CLIP PLAYS HERE]` marker stays in the script between SETUP and SUMMARY. News still has no video source wired up today (that's batch 4), so the marker will not actually produce a playing clip in smoke test #2. This is expected. Batch 3's success criterion is the **Gate 1 why-doc script text reads correctly** — no INTRO/SETUP repetition, no two-quip-back-to-back pattern. Visual clip playback verification waits for batch 4.

---

## Fix 6 — News prompt rewrite + rename CLIP_REACTION → SUMMARY

**File:** `server.js`
**Primary target:** lines 6685–6737 (the News Gemini prompt template)
**Secondary targets:** Gate 1 expected-scenes math references to `CLIP_REACTION` (grep-required), any News-specific Gate 1 checklist wording that names `CLIP_REACTION`

### Change 1 — scene length rules block (currently at lines 6690–6698)

**From:**
```
⚠️ SCENE LENGTH RULES - PREVENTS HEYGEN TTS FROM RUSHING:
- Each scene = 1-3 sentences MAXIMUM
- Scenes longer than 3 sentences cause HeyGen TTS to rush/skip words/poor enunciation
- INTRO scene: 2-3 sentences (episode intro)
- STORY#_INTRO scenes: 2-3 sentences (introduce the story/headline)
- STORY#_SETUP scenes: EXACTLY 2 sentences (not 1, not 3) + [beat] + [CLIP PLAYS HERE] + [beat]
- STORY#_CLIP_REACTION scenes: EXACTLY 1 sentence (Bobby reacting WHILE clip plays — this will be overlaid on clip in editing)
- STORY#_REACTION scenes: EXACTLY 1 sentence (short, flat, deadpan reaction AFTER clip)
- OUTRO scene: 1-2 sentences (sign-off)
```

**To:**
```
⚠️ SCENE LENGTH RULES - PREVENTS HEYGEN TTS FROM RUSHING:
- Each scene = 1-3 sentences MAXIMUM
- Scenes longer than 3 sentences cause HeyGen TTS to rush/skip words/poor enunciation
- INTRO scene: 2-3 sentences (episode intro)
- STORY#_INTRO scenes: 2-3 sentences (introduce the story/headline)
- STORY#_SETUP scenes: EXACTLY 1 sentence — a NEW fact or hook (not a summary, not a restatement of INTRO). Give the viewer a reason to watch the clip. Then [beat] + [CLIP PLAYS HERE] + [beat]
- STORY#_SUMMARY scenes: 1-2 sentences — factual recap of what just played in the clip. No reactions, no quips, no opinions. Sets up the REACTION scene that follows.
- STORY#_REACTION scenes: EXACTLY 1 sentence (short, flat, deadpan take on the story. Makes it MORE alarming, not less.)
- OUTRO scene: 1-2 sentences (sign-off)
```

### Change 2 — per-scene content structure block (currently at lines 6702–6725)

**From:**
```
=== INTRO ===
[2-3 sentences. Episode intro. Set the tone.]

=== STORY#_INTRO ===
[2-3 sentences. Introduce the headline. Build context.]
[beat]
Source: [Source name]. Link in description.
[beat]

=== STORY#_SETUP ===
[EXACTLY 2 sentences — not 1, not 3. First sentence: context about what happened. Second sentence: specific setup for the clip.]
[beat]
[CLIP PLAYS HERE]
[beat]

=== STORY#_CLIP_REACTION ===
[EXACTLY 1 sentence. Bobby's live reaction WHILE watching the clip. This will be picture-in-picture with the clip.]

=== STORY#_REACTION ===
[EXACTLY 1 sentence. Short. Flat. Deadpan. Makes it MORE alarming, not less. Final take AFTER the clip.]
[3-second pause — hold on the source clip for 3 seconds after Bobby's reaction, then cut to next story]

=== OUTRO ===
[1-2 sentences. Sign-off.]
```

**To:**
```
=== INTRO ===
[2-3 sentences. Episode intro. Set the tone.]

=== STORY#_INTRO ===
[2-3 sentences. Introduce the headline. Build context.]
[beat]
Source: [Source name]. Link in description.
[beat]

=== STORY#_SETUP ===
[EXACTLY 1 sentence. A NEW fact or hook that gives the viewer a reason to watch the clip. Do NOT restate the INTRO. Do NOT summarize the story. Introduce information the INTRO did not mention — a specific angle, an unexpected detail, a stake.]
[beat]
[CLIP PLAYS HERE]
[beat]

=== STORY#_SUMMARY ===
[1-2 sentences. Factual recap of what just played in the clip. Describe what the viewer saw in neutral, descriptive language. No opinions, no reactions, no quips. This is the bridge between the clip and Bobby G's take.]

=== STORY#_REACTION ===
[EXACTLY 1 sentence. Short. Flat. Deadpan. Bobby G's take on the story. Makes it MORE alarming, not less. Never explain. Never recap — that's the SUMMARY's job.]
[3-second pause — hold on the source clip for 3 seconds after Bobby's reaction, then cut to next story]

=== OUTRO ===
[1-2 sentences. Sign-off.]
```

### Change 3 — validation checklist block (currently at lines 6727–6735)

**From:**
```
✅ VALIDATION CHECKLIST:
- Total scenes: MUST BE EXACTLY ${expectedScenes}
- Total [CLIP PLAYS HERE] markers: MUST BE EXACTLY ${items.length}
- Each SETUP scene: EXACTLY 2 sentences (not 1, not 3) + contains [beat] + [CLIP PLAYS HERE] + [beat]
- Each CLIP_REACTION scene: EXACTLY 1 sentence (live reaction during clip)
- Each REACTION scene: EXACTLY 1 sentence (deadpan take after clip) + [3-second pause — hold on source clip]
- [beat] = 3-second pause — use before and after every [CLIP PLAYS HERE]
- After each REACTION scene: Add "[3-second pause — hold on source clip]" before moving to next story
- Never explain the take in reactions. Never recap what just happened.
```

**To:**
```
✅ VALIDATION CHECKLIST:
- Total scenes: MUST BE EXACTLY ${expectedScenes}
- Total [CLIP PLAYS HERE] markers: MUST BE EXACTLY ${items.length}
- Each SETUP scene: EXACTLY 1 sentence. Must introduce a NEW fact or hook not in INTRO. Followed by [beat] + [CLIP PLAYS HERE] + [beat].
- Each SUMMARY scene: 1-2 sentences. Factual recap of what the viewer just watched in the clip. No opinions, no reactions, no quips.
- Each REACTION scene: EXACTLY 1 sentence (deadpan take on the story) + [3-second pause — hold on source clip]
- [beat] = 3-second pause — use before and after every [CLIP PLAYS HERE]
- After each REACTION scene: Add "[3-second pause — hold on source clip]" before moving to next story
- Never let INTRO and SETUP say the same thing. SETUP must give the viewer a reason to watch that INTRO did not.
- Never let SUMMARY and REACTION say the same thing. SUMMARY is factual, REACTION is deadpan take.
```

### Change 4 — word count target (currently at line 6737)

**From:** `Target: 80-120 words spoken per story (setup + reactions, clip audio is stripped).`
**To:** `Target: 100-140 words spoken per story (INTRO + SETUP + SUMMARY + REACTION combined).`

Rationale: INTRO stays at 2-3 sentences, SETUP drops to 1 sentence (was 2), SUMMARY is 1-2 sentences (was 1), REACTION stays at 1 sentence. Net: roughly the same word count, slight bump on the upper bound because SUMMARY can be 2 sentences.

### Change 5 — scene header generation

Wherever the News `sceneHeaders` array is built (grep for `STORY#_CLIP_REACTION` or `CLIP_REACTION` in the News block of `generate-full-script`), rename each occurrence of `STORY${i}_CLIP_REACTION` → `STORY${i}_SUMMARY`. Scene count stays at 4 per story so the `1 + items.length * 4 + 1` math does not need to change.

### Change 6 — Gate 1 QA checklist text that references CLIP_REACTION

Grep for `CLIP_REACTION` inside the Gate 1 checklist strings (lines 2281, 2287, 2622 from earlier code search). Update the wording to reference `SUMMARY` where appropriate:

- `server.js:2281` — the comment `STORY1_INTRO, STORY1_SETUP, STORY1_CLIP_REACTION, STORY1_REACTION are 4 SEPARATE scenes` → update to `STORY1_INTRO, STORY1_SETUP, STORY1_SUMMARY, STORY1_REACTION are 4 SEPARATE scenes`
- `server.js:2287` and `server.js:2622` — the checklist item `STORY SETUP: Does each story have proper context before [CLIP PLAYS HERE]?` — this can stay as written, it refers to the SETUP scene not CLIP_REACTION. Leave unchanged unless the wording confuses the Gate 1 check.

### What stays the same

- `parseSegments_v2` — no change. Header regex matches `=== STORY#_SUMMARY ===` identically to `=== STORY#_CLIP_REACTION ===`.
- `heygen-poller` — no change. It inserts source clips after `SETUP` scenes (`/SETUP/i.test(avatarSeg.sceneName)`), which is still the correct insertion point under the new structure. The SUMMARY scene is just another avatar segment from the poller's perspective.
- Assembly (`server.js:3824-3897`) — no change. The News newscast overlay burn keys on `STORY#_INTRO` labels, which are unchanged.
- Fix 3 Gate 3 checks — no change. `clipsExpectedButMissing` guard is still `clipCount > 0`, still silent for News until batch 4 wires up video sources.
- Gate 1 expected scene count math — no change. Still `1 + items.length * 4 + 1` = 42 for 10 stories.
- Gate 1 expected clip count math — no change. Still `items.length` = 10 clips expected. The Gate 1 QA will still fail a News script that writes the wrong number of `[CLIP PLAYS HERE]` markers, which is the correct behavior — batch 3 keeps the markers in the script even though batch 4 will eventually wire them to real URLs.

---

## Verification (must run before commit)

After saving `server.js`, nodemon auto-restarts. No curl needed for this fix — verification is via a Gate 1 script generation. If you want to verify without running a full pipeline, there's no dashboard-side "Gate 1 only" button, so the minimum verification is reading the diff and confirming the string changes look right. Rob will run the next smoke test to validate Gemini actually follows the new rules.

**Grep safety check before committing:**

```bash
# After your edits, make sure no stale CLIP_REACTION references remain in the News prompt block:
grep -n "CLIP_REACTION" server.js
```

Expected: 0 hits in the News prompt template (lines 6685-6737). Any hits outside that range are in the Twitch block or other content types and must NOT be touched.

```bash
# Confirm SUMMARY is properly introduced:
grep -n "STORY#_SUMMARY\|SUMMARY scenes" server.js
```

Expected: hits in the News prompt template showing the new rule text.

---

## Commit strategy

**Single commit:**

```
fix(news): rewrite Gemini prompt to eliminate INTRO/SETUP repetition (server.js:6685-6737)

Today's News smoke test #1 (jobId script_news_1776029172144) produced a script
where every story's SETUP scene restated the INTRO with different words, and
CLIP_REACTION + REACTION produced two unconnected one-liners back-to-back.
Root cause: SETUP's rule said "context about what happened" which duplicated
INTRO's job, and CLIP_REACTION's "picture-in-picture with the clip" framing
references a PIP mode that does not exist in the assembly path.

Changes:
- server.js:~6690 — SETUP rule rewritten: EXACTLY 1 sentence, must introduce a
  NEW fact or hook, must not restate INTRO or summarize the story.
- server.js:~6696 — CLIP_REACTION renamed to SUMMARY with a new rule: 1-2
  sentences factual recap of what just played, no opinions, no reactions, no
  quips. Bridges clip-end to the REACTION take.
- server.js:~6697 — REACTION rule tightened: must not recap (that's SUMMARY's
  job), must be deadpan take only.
- server.js:~6718 — CLIP_REACTION scene header in template → SUMMARY.
- server.js scene header generation — STORY${i}_CLIP_REACTION → STORY${i}_SUMMARY.
- server.js:2281 — Gate 1 QA comment updated to reference SUMMARY.
- server.js:6737 — word count target: 80-120 → 100-140 per story.

Scene count math unchanged (still 1 + items*4 + 1 = 42 for 10 stories).
parseSegments_v2, heygen-poller, assembly, and all downstream code paths
unchanged — header regex matches STORY#_SUMMARY identically.

Validates: script flow reads correctly in Gate 1 why-doc, no INTRO/SETUP
repetition, no two-quip-back-to-back pattern.

Does NOT fix: News still has no video source wired up — [CLIP PLAYS HERE]
markers are still in the script and will be silently dropped by the poller
(0 clips in assembled output). That is batch 4 work.

References: LONGFORM_FIX_ROTATION.md News batch 3
```

Then per `COMMIT_CHECKLIST.md`:

1. **Atomic staging** — `git add server.js STATUS.md LONGFORM_FIX_ROTATION.md && git commit -m "..." && git push` in a single chained command.
2. **Update STATUS.md** 🤖 Last Agent Action table with this task + commit hash + timestamp.
3. **Update LONGFORM_FIX_ROTATION.md** — move News batch 3 from `📤 Dispatched to Cline` → `✅ Shipped` with the commit hash. Add a new rotation log row.
4. **Do NOT** update CLAUDE.md, POST_PUBLISH_TASKS.md, or any other doc. This fix is scoped to the News prompt only.

---

## Testing checklist

Before Rob runs the next News smoke test:

- [ ] `git log --oneline -1` shows the batch 3 commit on `main`
- [ ] `git show HEAD --stat` shows only `server.js` + `STATUS.md` + `LONGFORM_FIX_ROTATION.md` changed
- [ ] Nodemon auto-restarted cleanly — no syntax error on boot
- [ ] `grep -n "CLIP_REACTION" server.js` returns 0 hits in the News prompt block (lines 6685-6737). Twitch and other content types may still have CLIP_REACTION references — that's expected and must not be touched.
- [ ] `grep -n "STORY#_SUMMARY\|SUMMARY scenes" server.js` returns hits showing the new rule text
- [ ] The diff at `server.js:6685-6737` matches Change 1, 2, 3, 4 above

Rob will then re-run the News long-form smoke test from the dashboard. Expected outcomes:

1. **Gate 1 script why-doc** shows 42 scenes with the new structure: `STORY#_INTRO → STORY#_SETUP → STORY#_SUMMARY → STORY#_REACTION` per story (SUMMARY in place of CLIP_REACTION)
2. **Script reads correctly on paper:** SETUP delivers a new fact (not a restatement), SUMMARY describes what the clip showed in neutral language (even though no clip actually plays yet), REACTION is the deadpan quip
3. **Final video is still structurally incomplete** because News has no video source — clips still don't play, so the SUMMARY scene will describe a clip the viewer didn't see. That is expected and is the batch 4 scope, not a batch 3 regression.
4. **Newscast overlay is still visible** from Fix 5 (commit `971429d`) during STORY#_INTRO scenes

---

## Rollback plan

If the new prompt causes Gate 1 to start failing (unlikely — scene count and clip count math are unchanged):

```bash
git revert HEAD && git push
```

Zero rollback risk on downstream code paths because the change is entirely inside the Gemini prompt template and the renamed scene header string. No code flow changes.

---

## What this fix does NOT solve

1. **News still has no source video clips.** `orderedClipUrls` will still be filtered to an empty array. The `[CLIP PLAYS HERE]` markers are present in the script but no clip URLs exist, so the heygen-poller will produce `clipCount === 0` again. Scheduled for batch 4.
2. **SUMMARY scenes will describe invisible clips in smoke test #2.** Gemini will write "the footage showed X" for a clip that never plays. This is a batch 4 artifact, not a batch 3 bug. Do not attempt to make SUMMARY conditional on clip presence — that adds complexity that batch 4 will render moot.
3. **Road A / Road B decision is still parked.** Rob has indicated "we are allowed to play videos if you make the content your own," which leans toward Road A (wire up a news video source) for batch 4. Batch 3 is deliberately scoped to only the prompt rewrite so the Road A/B decision can be separate.
4. **PIP mode** is explicitly removed from the prompt wording. If PIP is ever implemented in the future, the CLIP_REACTION scene can be re-added as a new scene type — but do not add it back as part of this commit.

---

## Why this works (teaching section)

The bug is a prompt that gives two scenes the same job. When both scenes have valid reasons to exist (e.g., SETUP primes a real clip, CLIP_REACTION overlays a real clip), the prompt works. When either scene's reason to exist is missing (no clip, no PIP), the scenes collapse into redundancy because Gemini is a language model and will generate plausible filler when asked for a scene with no distinct job.

The fix is to give each scene a **structurally distinct job**, not just a distinct label:
- INTRO = "here's the story" (headline + context, delivered over newscast graphics)
- SETUP = "here's why to watch" (1 new fact, delivered as a hook)
- SUMMARY = "here's what you saw" (factual recap, delivered as a bridge)
- REACTION = "here's what it means" (1 sentence deadpan, delivered as the take)

Those are 4 genuinely different jobs. Gemini will produce 4 genuinely different lines because the prompt asks for 4 different things. That's the whole fix.

The deeper lesson — and the reason batch 1's scope miss happened — is that **scene structure is load-bearing for LLM output quality**. The same model on the same topic will produce redundant slop or crisp differentiation depending entirely on whether the prompt gives each scene a distinct job. Batch 3 is correcting a prompt design issue that was present since News was built, not adding new functionality.
