# CLINE HANDOFF — Phonetic Pronunciation Bug (HeyGen Reads Parentheticals Aloud)

**Priority:** HIGH — Bobby G says "eye-RAHN" after saying "Iran" in every News video  
**Agent:** Aider (prompt engineering, `server.js` — surgical 3-site text change)  
**Estimated scope:** 3 small prompt block rewrites, no logic change  
**Branch:** main

---

## Problem

The script system prompts tell Gemini to write phonetic pronunciation hints in parentheses after difficult words:

> "Iran (ee-RAHN)" or "Zelenskyy (zeh-LEN-skee)"

The intent was to help HeyGen pronounce correctly. But HeyGen reads **everything** in the script literally. There is no silent annotation mechanism. Bobby G says "Iran" then immediately says "ee-RAHN" as a second word. The parenthetical hint is being spoken aloud.

This explains Rob's observation: "Bobby G is saying Iran then phonetically saying 'ee-RAHN' right after."

---

## Root Cause — Location

Three system prompt blocks contain the broken pronunciation rule:

| Content Type | Location in server.js | Rule text |
|---|---|---|
| NBA | `~6717-6720` | "Add simple phonetic respelling in parentheses on FIRST mention only" |
| News | `~6777-6782` | "Add phonetic respelling in parentheses on FIRST mention only" |
| Twitch | `~6824-6826` | "If streamers.json has phonetic field, use it on FIRST mention" |

---

## Fix — 3 Prompt Block Rewrites

### Site 1: NBA prompt (`server.js ~6716-6736`)

**Find:**
```
HEYGEN PRONUNCIATION BEST PRACTICES:
The avatar (HeyGen AI) reads your script aloud. Follow these rules for perfect pronunciation:
1. **Unusual names**: Add simple phonetic respelling in parentheses on FIRST mention only
   - Example: "Giannis Antetokounmpo (YAH-nis ON-tet-oh-KOON-po)"
   - Example: "Luka Dončić (LOON-kuh DON-chich)"
   - Common names like "LeBron", "Curry", "Durant" need no help
```

**Replace with:**
```
HEYGEN PRONUNCIATION BEST PRACTICES:
The avatar (HeyGen AI) reads your script aloud — EVERYTHING in the script is spoken, including parenthetical text.
1. **Difficult names**: Write the phonetic spelling DIRECTLY as the spoken word. Do NOT add parenthetical hints.
   - WRONG: "Giannis Antetokounmpo (YAH-nis)" — Bobby G will say both
   - RIGHT: Write "Yan-is An-tet-oh-KOON-po" OR just "Giannis" (HeyGen handles common NBA names fine)
   - Common names (LeBron, Curry, Durant, Luka) need no changes — HeyGen knows them
   - Only respell if a name is genuinely unusual AND HeyGen will mispronounce it
```

### Site 2: News prompt (`server.js ~6776-6784`)

**Find:**
```
HEYGEN PRONUNCIATION BEST PRACTICES:
The avatar (HeyGen AI) reads your script aloud. Follow these rules for perfect pronunciation:
1. **Unusual names/places**: Add phonetic respelling in parentheses on FIRST mention only
   - "Zelenskyy (zeh-LEN-skee)", "Xi Jinping (shee jin-PING)", "Qatar (KAH-tar)"
2. **Numbers**: Spell out for clarity → "twenty-three" NOT "23"
3. **Abbreviations**: Spell out OR hyphenate → "UN" becomes "U-N" OR "the UN"
4. **Foreign words**: Simple phonetic respelling → "coup d'état (koo day-TAH)"
5. **Punctuation = pacing**: Use commas for natural speech rhythm
```

**Replace with:**
```
HEYGEN PRONUNCIATION BEST PRACTICES:
The avatar (HeyGen AI) reads your script aloud — EVERYTHING in the script is spoken, including any text in parentheses.
1. **Difficult names/places**: Write them as they should be HEARD. Do NOT add parenthetical pronunciation guides — they will be spoken aloud.
   - WRONG: "Zelenskyy (zeh-LEN-skee)" → Bobby G says "Zelenskyy zeh-LEN-skee"
   - RIGHT: "Zelenskyy" — HeyGen handles this fine. Or write "zeh-LEN-skee" directly if needed.
   - Most common names (Iran, Qatar, Beijing, Ukraine) HeyGen pronounces correctly — leave them as-is.
   - Only rewrite if the word is genuinely obscure AND you are certain HeyGen will mispronounce it.
2. **Numbers**: Spell out for clarity → "twenty-three" NOT "23"
3. **Abbreviations**: Spell out OR hyphenate → "UN" becomes "U-N" OR "the UN"
4. **Punctuation = pacing**: Use commas for natural speech rhythm
```

### Site 3: Twitch prompt (`server.js ~6823-6830`)

**Find:**
```
HEYGEN PRONUNCIATION BEST PRACTICES:
The avatar (HeyGen AI) reads your script aloud. Follow these rules for perfect pronunciation:
1. **Streamer names**: If streamers.json has phonetic field, use it on FIRST mention
   - Example: "Yonna (YAWN-uh)" if phonetic: "Yawn-uh" exists in data
   - Common names like "xQc", "Pokimane", "Kai Cenat" usually fine as-is
```

**Replace with:**
```
HEYGEN PRONUNCIATION BEST PRACTICES:
The avatar (HeyGen AI) reads your script aloud — EVERYTHING is spoken, including parenthetical text.
1. **Streamer names**: If streamers.json has a phonetic field, use the phonetic spelling DIRECTLY as the spoken name.
   - WRONG: "Yonna (YAWN-uh)" → Bobby G says "Yonna YAWN-uh"
   - RIGHT: Write "YAWN-uh" directly in the script where the name is first spoken. After that, use the display name normally.
   - Most streamer display names (xQc, Pokimane, Kai Cenat, Hasan) are fine as-is — HeyGen handles them.
```

---

## How to Find These Blocks

```bash
grep -n "HEYGEN PRONUNCIATION" server.js
```

Should return 3 lines. Edit each block per the replacements above.

---

## Testing

After the fix, generate a News script with Al Jazeera stories. Check the raw script text returned from `/generate-full-script` — confirm there are no `(phonetic)` parenthetical annotations. If there are, Gate 1 should catch them as potential placeholders, but the real fix is the prompt change.

---

## What NOT to change

- Do not touch the `phonetic` field in `streamers.json` — that data is still useful, the prompt just needs to use it differently
- Do not touch `getDisplayName()` or the streamer phonetic lookup logic in server.js

---

## Commit Message

```
fix(prompts): remove parenthetical phonetic hints — HeyGen reads them aloud

All 3 pronunciation rule blocks (NBA/News/Twitch) updated to direct
phonetic respelling instead of parenthetical annotations. Bobby G was
saying "Iran ee-RAHN" because HeyGen speaks everything in the script.
```
