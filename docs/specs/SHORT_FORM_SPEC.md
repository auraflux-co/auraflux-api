# Short-Form Video Spec — AuraFlux

**Created:** 2026-04-19  
**Status:** AUTHORITATIVE — confirmed by Rob Gregory  
**Scope:** All short-form content types (twitch-short, nba-short, news-short)

---

## Short-form is a completely different script type from long-form

Not the same format with minor adjustments. Different scaffold, different structure, different assembly, different Gate 1 rules.

---

## Script Structure

```
HOOK (1-2 lines)
[CLIP PLAYS HERE]
REACTION (1-2 lines)
```

**That's it. Nothing else.**

- No INTRO scene
- No OUTRO scene  
- No "Subscribe. Appreciate you." as a separate scene
- No multi-scene structure
- No streamer/game/story INTRO scenes
- Total spoken words: ~20-40 words (Bobby G speaks very little)
- Duration: 45-60 seconds total

### HOOK
- 1-2 lines maximum
- Sets up the clip without spoiling it
- Immediate energy — no long setup
- Becomes (or informs) the CAPTION text overlay

### REACTION  
- 1-2 lines maximum
- Bobby G reacts to what just played
- Flat delivery, no hype
- No CTA, no "Follow [streamer]", no "Subscribe" — those are long-form only

### CAPTION
- 3-6 words
- Burned as text overlay in Bobby G panel lower-third (bottom-center of top panel, safely above split)
- Per content type rules:
  - twitch-short: ALL CAPS, internet speak, emoji ok (max 4 words)
  - nba-short: UPPERCASE, vibe-check (max 3 words)  
  - news-short: Title Case, slightly deadpan/absurd headline (max 6 words)
- Extracted from the CAPTION: line in the script
- NOT spoken by Bobby G — burned by FFmpeg only
- Readability defaults:
  - white text (`#FFFFFF`)
  - black stroke/outline
  - subtle black drop shadow
  - max two lines

---

## Assembly Layout (1080×1920 portrait)

```
┌─────────────────┐  ← y=0
│                 │
│   BOBBY G       │  Top 50% (1080×960)
│   (portrait     │  Portrait avatar reacting
│    avatar)      │
│                 │
│  [CAPTION TEXT] │  ← y≈920, just above split
├─────────────────┤  ← y=960 (split line)
│                 │
│   SOURCE CLIP   │  Bottom 50% (1080×960)
│   (playing)     │  
│                 │
└─────────────────┘  ← y=1920
```

- Bobby G on **TOP**, source clip on **BOTTOM**
- Both halves exactly 1080×960
- Caption burned bottom-center in Bobby's top panel (`y=960-text_h-36`), visible on Bobby G's half
- Bobby G must be reacting TO the clip — not just watching neutrally
- Portrait avatar framing: Bobby G visible from chest up

### Content-Type Playback Rule

- `news-short` and `twitch-short`: Bobby G remains visible on top, but does **not** speak during the clip window.
- `nba-short` (aka `sports-short`): Bobby G **does** speak during the clip window (voiceover style, like long-form NBA).

---

## HeyGen Avatar

- **Avatar ID**: `3714bb5af7234f28acad451db78b468c` (portrait avatar)
- **NOT** the landscape avatar `842f20b7` — that was wrong
- Voice: CW, speed 0.95 (faster than long-form's 0.85)
- Format: portrait (720×1280 from HeyGen)
- FFmpeg scales to 1080×960 for top half — crop/scale to fill, keep Bobby G centered

---

## FFmpeg Split-Screen Assembly

1. Download portrait avatar segments from HeyGen
2. Scale avatar to 1080×960 (top half): `scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960`
3. Source clip to 1080×960 (bottom half): `scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960`
4. Stack: `vstack` to produce 1080×1920
5. Burn caption via `drawtext` at y≈920 (above split line)
6. Burn logo 80px top-right

---

## Scaffold Structure

Short-form scaffold generates exactly 3 scene slots:

```
=== HOOK ===
[DIALOGUE]

=== CLIP ===
[CLIP PLAYS HERE]

=== REACTION ===
[DIALOGUE]
CAPTION: [text]
```

No INTRO. No OUTRO. No locked intro/outro text.

---

## Gate 1 Rules for Short-Form

Gate 1 checks short-form scripts against these rules only:
- HOOK present (1-2 lines)
- Exactly 1 [CLIP PLAYS HERE] marker
- REACTION present (1-2 lines)
- CAPTION present and within word limit for content type
- No forbidden hype words
- Total word count 20-40 (not 80-100 like long-form)
- Does NOT check for outro line
- Does NOT check for scene count beyond 3
- Does NOT check for intro structure

---

## What Changed from Previous Spec

Previous spec (now wrong — do not follow):
- Had INTRO + HOOK + CLIP + REACTION + OUTRO
- Had locked INTRO text ("Welcome to Twitch Soup...")
- Had locked OUTRO text ("Subscribe. Appreciate you.")
- Gate 1 checked for "Subscribe. Appreciate you." in OUTRO

Current spec (this document):
- HOOK + CLIP + REACTION only
- No locked INTRO or OUTRO scenes
- Caption is the only additional element — burned by FFmpeg, not spoken
- Gate 1 does not check for OUTRO

---

## Source Clips for Short-Form

- ONE clip per short-form video
- Twitch-short: 1 Twitch clip (GQL resolved, signed MP4)
- NBA-short: 1 ESPN highlight clip (HLS)
- News-short: 1 AJ portrait clip ONLY — landscape clips rejected entirely

---

## Content Type Aliases

| Dashboard type | Internal type | Avatar |
|---|---|---|
| twitch-short | clips-short | `3714bb5af7234f28acad451db78b468c` |
| nba-short | sports-short | `3714bb5af7234f28acad451db78b468c` |
| news-short | news-short | `3714bb5af7234f28acad451db78b468c` |
