# News VOD production — CPD-963

**Show:** Because the Light Was On (C0 localhost).

**Sources:** Al Jazeera scrape (primary); avoid AP/Reuters/BBC (Content ID). Daily cadence = **live host** (Rob on camera), not HeyGen.

**HeyGen:** Backup only — when a scheduled **Twitch show** cannot run live, pipeline can fall back to avatar render. Not the default for news VOD or daily Twitch Soup.

**Credit-safe test (HeyGen fallback path):** Dashboard → Hold before HeyGen → review → approve.

**Smoke:** `curl -s "http://localhost:3000/news/us-canada-videos?limit=3"`

See C0 `lib/routes/c0_sources.js` AJ thin-pool top-up (2026-06-13).
