# Operator studio audio — Twitch Soup

Curated audio from Rob. **Operator files bypass auto-extraction and Gemini QA.**

## Cold open music bed

**File:** `opening_music_bed.mp3`

- Plays under the announcer VO for the full cold open montage only
- Hard cut when Bobby G INTRO starts (cold open is a separate prepend segment)
- Current track: *Forsaken — Under Earth* (Epidemic Sound)
- Volume: `musicVolume` in `c0.json` (currently 0.36)

## Reaction laugh segments

**Folder:** `segment_laughs/`

- Tight studio audience laugh after each `*_REACTION` Bobby G scene
- Current: `reaction_laugh.mp3` (~4.7s, Komedia Comic Boom crowd)
- Add more MP3s here to rotate variety across reactions in future episodes

## Status

`GET http://localhost:3000/studio-laugh/library`
