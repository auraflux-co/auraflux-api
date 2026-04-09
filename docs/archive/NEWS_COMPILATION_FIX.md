# News Compilation Gate 1 Fix - Complete

**Date:** April 6, 2026
**Issue:** News compilations failing Gate 1 with score 75/100 due to 0 [CLIP PLAYS HERE] markers

---

## Problem Identified

**User Error Output:**
```
[generate-full-script] Got 0/10 news analyses
[generate-full-script] Gate 1 Script QA: ❌ HARD FAIL (75/100)
-25 CLIP COUNT: Found 0 [CLIP PLAYS HERE] markers, expected 10 — CRITICAL
```

**Root Cause:**
The `news` system prompt stated: "The anchor reads every word — there are no external clips, so every second of airtime is spoken content."

This was incorrect. User explicitly stated: **"for nba and news long form...it has to play like twitch and its the same rhythm setup, clip, reaction"**

---

## Changes Made

### 1. Updated `news` System Prompt (server.js:3084-3110)

**Before:**
```javascript
news: `You write scripts for ClipzWorld News (@clipznashite), a deadpan world news show. The anchor reads every word — there are no external clips, so every second of airtime is spoken content.

STRICT RULES:
- State the headline exactly as it happened. No adjectives, no color.
- Include: headline → context (2-3 sentences) → one flat observation → source credit
- Use [beat] between every sentence. Include: headline → 2-3 sentences context → one flat observation → source credit.
Target: 130-160 words spoken per story. Anchor speaks ENTIRE runtime — make it dense.`
```

**After:**
```javascript
news: `You write scripts for ClipzWorld News (@clipznashite), a deadpan world news show. Same rhythm as Twitch: setup → clip → reaction.

STRICT RULES:
- Each story follows: setup (2-3 sentences) → [beat] → [CLIP PLAYS HERE] → [beat] → reaction (1 sentence, flat)
- Setup: headline + context, establishes what happened
- Reaction: ONE flat observation after the clip. Short. Deadpan. Make it MORE alarming, not less.
- [CLIP PLAYS HERE] = structural marker, keep it, it is not spoken

NEWS STRUCTURE — IMPORTANT:
Each story follows the same rhythm as Twitch:
[Setup — 2-3 sentences. Headline + context. What happened and why it matters. Sets up the clip.]
[beat]
[CLIP PLAYS HERE]
[beat]
[ONE flat reaction sentence. Short. Deadpan. Makes the story MORE alarming, not less. Could be a non-sequitur.]
[beat]
Source: [Source name]. Link in description.`
```

### 2. Updated News User Prompt (server.js:3802-3825)

**Before:**
```javascript
userPrompt = `Write the COMPLETE ClipzWorld News world news script for ${dateStr}.

${items.length} stor${items.length > 1 ? 'ies' : 'y'} total.

Every story FULLY WRITTEN — no placeholder brackets.
Use article text AND Gemini analysis for accurate, specific content.
Use [beat] between every sentence. Include: headline → 2-3 sentences context → one flat observation → source credit.
Target: 130-160 words spoken per story. Anchor speaks ENTIRE runtime — make it dense.`;
```

**After:**
```javascript
userPrompt = `Write the COMPLETE ClipzWorld News world news script for ${dateStr}.

${items.length} stor${items.length > 1 ? 'ies' : 'y'} total. ${items.length} [CLIP PLAYS HERE] markers required (one per story).

CRITICAL — CLIP STRUCTURE FOR EACH STORY:
Each story section must contain EXACTLY 1 [CLIP PLAYS HERE] marker.
Structure for EACH story section — follow this EXACTLY:

[Story setup — 2-3 sentences. Headline + context. What happened and why it matters. Sets up the clip.]
[beat]
[CLIP PLAYS HERE]
[beat]
[ONE flat reaction sentence. Short. Deadpan. Makes the story MORE alarming, not less. Could be a non-sequitur.]
[beat]
Source: [Source name]. Link in description.

RULES:
- Setup: 2-3 sentences — establishes the story with headline + context
- Reaction: EXACTLY 1 sentence — short, flat, punchy. Makes it MORE alarming, not less.
- [beat] = pause — use before and after every clip
- Never explain the observation in a reaction. Never recap what just happened.
- Same rhythm as Twitch: setup → clip → reaction

Total [CLIP PLAYS HERE] count must be exactly ${items.length}.
Target: 80-120 words spoken per story (setup + reaction, clip audio is stripped).`;
```

### 3. Updated Long Form Names

**NBA:** "The Daily Update" → **"Witness the NBA"**
**Twitch:** "The Daily Update" → **"Twitch Soup"**
**News:** "The Daily Update" → **"Because the Light Was On"**

Updated in:
- `server.js:3065-3076` (NBA cold open/outro)
- `server.js:3127-3136` (Twitch cold open/outro)
- `server.js:3099-3110` (News cold open/outro)

---

## Test Results

**Before Fix:**
```
Gate 1 Score: 75/100
Gate 1 Passed: False
[CLIP PLAYS HERE] count: 0
Deductions:
  -25 CLIP COUNT: Found 0 [CLIP PLAYS HERE] markers, expected 10 — CRITICAL
```

**After Fix:**
```
Gate 1 Score: 100/100
Gate 1 Passed: True
[CLIP PLAYS HERE] count: 3 (3 stories = 3 markers)
Deductions: None
```

**Sample Generated Script:**
```
=== STORY 1 OF 3 ===

The international climate summit wrapped up today with what officials are calling mixed results. Several nations agreed to some emissions reductions, but the major polluters refused to commit to any binding targets. The summit's final declaration includes language about "aspirational goals" and "voluntary frameworks."

[beat]

[CLIP PLAYS HERE]

[beat]

Nothing says urgent planetary crisis quite like aspirational goals.

[beat]

Source: Al Jazeera. Link in description.
```

**Perfect structure:**
- Setup: 2-3 sentences establishing the story
- [CLIP PLAYS HERE] marker for video clip
- Reaction: 1 deadpan, flat sentence (Norm MacDonald style)
- Source credit

---

## Files Modified

1. `server.js` (lines 3084-3110, 3802-3825, 3065-3076, 3127-3136)

---

## Verification

Test file: `test_news_fix.json` (3 stories)
Result file: `output/test_news_result.json`

Command to verify:
```bash
curl -X POST http://localhost:3000/generate-full-script \
  -H "Content-Type: application/json" \
  -d @test_news_fix.json
```

---

## Status

✅ **COMPLETE** - News compilations now follow the same rhythm as Twitch (setup → clip → reaction) and pass Gate 1 with 100/100 score.
