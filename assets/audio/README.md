# Epidemic Sound fallback beds (CPD-1030)

Royalty-free tracks licensed via Epidemic Sound. Primary copy: `cwn-production/assets/audio/` (ES_* prefix).

The live grid resolves beds from, in order:

1. `LIVE_GRID_FALLBACK_MUSIC_DIR` env override
2. `cwn-c0/assets/audio/` (local copy)
3. `../cwn-production/assets/audio/` (sibling repo)

Used when music guard mutes copyrighted Twitch audio.

**Clip comps:** Creative Mode music bed picker reads this folder (`GET /clip-comp/audio-beds`). Drop any `ES_*.mp3` here — it appears in the dashboard select on next load. Built-in keys: `low_trap`, `neutral_lofi`.
