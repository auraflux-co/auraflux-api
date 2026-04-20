# CUSTOMER CREATIVE CONFIG SPEC

**Created:** 2026-04-19  
**Status:** AUTHORITATIVE — confirmed by Rob Gregory  
**Scope:** All creative decisions for Customer 0 (ClipzWorld News). Template for all future customers.  
**Rule:** Every creative decision lives here. Code reads from config. Nothing hardcoded.

---

## What This Covers

Everything a customer decides once that the pipeline executes forever:
- Show identity (name, host, brand)
- Locked script text (intro, outro — system-owned, Gemini never touches)
- Voice persona (how Bobby G speaks per show)
- Visual identity (colors, overlay, caption, logo)
- Scaffold structure (which scenes are locked vs dialogue slots)
- Assembly rules (clip duration, audio mix)
- Publishing identity (platforms, handles)

---

## Customer 0 — ClipzWorld News

### Channel Brand
- **Channel name:** ClipzWorld News
- **Host:** Bobby G
- **Handle:** @clipzworldnews

---

## LOCKED SCRIPT TEXT — Confirmed 2026-04-19

These are system-owned. Gemini never writes them. Scaffold pre-fills them. Gate 1 reads from here to verify. No other source.

### Long-Form Intros

**TALK SOUP (Twitch / clips):**
```
Welcome to Twitch Soup. I'm your host Bobby G, and for the next five minutes, I'll be your guide through the digital world that is livestreaming.
```

**OTHER SIDE OF THE PILLOW (NBA / sports):**
```
What's up, ClipzWorld! Grab your shades, because we're heading to the Other Side of the Pillow. I'm Bobby G, and we're breaking down the highlights that weren't just good—they were cold.
```

**BECAUSE THE LIGHT WAS ON (News):**
```
I'm Bobby G, and this is Because the Light was on. I'm told this is the news. A recent study shows that people who watch news programs are 40% more likely to be aware that a news program is currently happening. ... [Pause] ... Here are some things that occurred while we weren't looking.
```

### Long-Form Outro — ALL SHOWS (same)
```
That's all the time we have before the light bill is due. I'm Bobby G for ClipzWorld News. Keep your clips short and your takes shorter. Goodnight and good luck.
```

### Short-Form
- **No locked intro** — short-form starts with HOOK ([DIALOGUE] slot)
- **No locked outro** — short-form ends with REACTION ([DIALOGUE] slot)
- HOOK + [CLIP PLAYS HERE] + REACTION + CAPTION only

---

## SHOW NAMES & COLORS

| Content Type | Show Name | Primary | Accent | Active |
|---|---|---|---|---|
| clips (Twitch) | TALK SOUP | #6441A5 | #7d5bbe | #6441A5 |
| sports (NBA) | OTHER SIDE OF THE PILLOW | #17408B | #1a4fa8 | #C9082A |
| news | BECAUSE THE LIGHT WAS ON | #22304b | #c7af4f | #C0392B |

---

## CAPTION DESIGN (Short-Form Only)

Caption appears at bottom of Bobby G's half (top section), just above the split line (~y=920).
Centered horizontally. Per content type colors:

| Content Type | Text Color | Style | Max Words |
|---|---|---|---|
| clips (Twitch) | #6441A5 (purple) | ALL CAPS, internet speak, emoji ok | 4 words |
| sports (NBA) | #1CE8FF (electric blue) | UPPERCASE, vibe-check | 3 words |
| news | #c7af4f (gold) | Title Case, deadpan/absurd | 6 words |

Caption font: Arial Bold Italic, size 68px  
Box: black 75% opacity background, 18px border padding  
Position: `x=(w-text_w)/2` (centered), `y=920` (just above split)

---

## OVERLAY DESIGN (Long-Form)

### Top Bar (always on)
- Height: 48px
- Left side: Episode number + Show name (same side, this order)
- Right side: Date + LIVE badge
- Background: primary color
- Bottom border: accent color 2px

### Flag (top-left, per scene)
- Width: 620px, Height: 88px
- Row 1: category label (accent background)
  - clips: "ON STREAM"
  - sports: "NBA GAME"  
  - news: "WORLD NEWS"
- Row 2: story/streamer/game title (primary background, accent left border 4px)
- Hidden on: COLD_OPEN, SOURCE_CLIP, OUTRO scenes

### Sidebar (right side, per scene)
- Top: 120px from top, Right margin: 32px, Width: 420px
- Item height: 90px, Gap: 12px, Max: 5 items
- Inactive: accent border 4px
- Active: active color border 5px + "▶ ON AIR" badge
- Hidden on: SOURCE_CLIP, OUTRO scenes

### Logo
- Asset: assets/cwn_logo.png
- Long-form: 120px, bottom-right
- Short-form: 80px, top-right

---

## SPLIT-SCREEN LAYOUT (Short-Form)

```
┌─────────────────┐  y=0
│   BOBBY G       │  Top 50% (1080×960) — portrait avatar reacting
│   (TOP)         │
│  [CAPTION]      │  y≈920 — just above split, centered
├─────────────────┤  y=960 (split line)
│   SOURCE CLIP   │  Bottom 50% (1080×960)
│   (BOTTOM)      │
└─────────────────┘  y=1920
```

Bobby G TOP. Source clip BOTTOM. This is fixed — never reversed.

---

## VOICE PERSONA

### All Shows — Base Rules
- Never: "incredible", "amazing", "crazy", "wild"
- Never explain the joke
- Never hype — state fact, one observation, done
- [beat] used for timing and segment boundaries

### TALK SOUP (Twitch)
Fast, slightly annoyed, high-frequency. The host has seen everything and is no longer impressed. Reporting from the digital dumpster fire. Does not enjoy it. The clip is the joke — he just witnesses it and says one flat thing.

### OTHER SIDE OF THE PILLOW (NBA)
Cool, melodic, percussive. Stuart Scott flow. Short bursts. Named. Specific. Then the flat landing. Warmth comes from specificity not adjectives.

### BECAUSE THE LIGHT WAS ON (News)
Dry, mid-tempo, monotone with long pauses. Present facts. Make one observation. Move on. Not alarmed. Not your friend. Comedy comes from the gap between what happened and how calmly it is reported.

---

## SCAFFOLD STRUCTURE

### Long-Form
| Content Type | Structure |
|---|---|
| news | INTRO (locked) + (STORY#_INTRO + STORY#_SETUP + STORY#_CLIP + STORY#_SUMMARY + STORY#_REACTION) × N + OUTRO (locked) |
| clips | INTRO (locked) + (ITEM#_INTRO + ITEM#_CLIP1_SETUP + ITEM#_CLIP1_REACTION + ...) × N + OUTRO (locked) |
| sports | INTRO (locked) + (GAME#_INTRO + GAME#_CLIP + GAME#_NARRATION + GAME#_REACTION) × N + OUTRO (locked) |

### Short-Form (all types)
```
HOOK ([DIALOGUE])
CLIP ([CLIP PLAYS HERE])
REACTION ([DIALOGUE])
CAPTION: [text per content type rules]
```
No INTRO. No OUTRO. Gemini fills HOOK, REACTION, CAPTION only.

---

## ASSEMBLY CONFIG

| Field | news | clips (Twitch) | sports (NBA) |
|---|---|---|---|
| sourceCropFilter | crop=1920:1080 | crop=1880:1040 | crop=1920:1080 |
| clipIntroSkipSecs | 5 | 0 | 0 |
| clipMaxSecs (long) | 25 | null | null |
| clipMinSecs (short) | 30 | 30 | 30 |
| clipMaxSecs (short) | 90 | 90 | 90 |
| audioMix | source only | both | voiceover |
| voiceover | false | false | true |

---

## IMPLEMENTATION NOTES

### What changes in code
1. `lib/scaffold.js` — LOCKED_INTROS and LOCKED_OUTROS read from customerConfig, not hardcoded
2. `lib/script_gen.js` — system prompts read locked text from customerConfig; strip HOOK:/REACTION: labels before HeyGen
3. `lib/qa/checklists/*.js` — checklist intro/outro checks read from customerConfig
4. `lib/gates/gate1.js` — checkOutro() and intro check read from customerConfig
5. `lib/assembly.js` — caption position/colors from customerConfig; splitTop/splitBottom from designDefaults
6. `config/customers/c0.json` — receives all values from this spec

### What gets deleted from code
- All hardcoded intro/outro strings in script_gen.js
- All hardcoded intro/outro strings in qa/checklists/*.js  
- All hardcoded show names in publish.js
- The mislabeled NBA intro in scaffold.js LOCKED_INTROS['news-long']
- The fallback intro injection at script_gen.js:2317
- Any creative text not sourced from customerConfig

### Single source of truth chain
```
CREATIVE_CONFIG_SPEC.md (this doc — human decisions)
    ↓ implemented in
config/customers/c0.json (machine-readable)
    ↓ read by
scaffold.js → Gate 1 → script_gen.js → qa/checklists → assembly.js → publish.js
    ↓ verified by
Gate 1 QA (checks intro/outro against customerConfig)
Gate 3a/4 (checks overlay against designDefaults)
```
