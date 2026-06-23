# News VOD production — CPD-963

**Show:** Because the Light Was On (C0 localhost).

**Sources:** Al Jazeera scrape (primary); avoid AP/Reuters/BBC (Content ID). Prefer live-host desk lane for daily cadence.

**Credit-safe test:** Dashboard → Hold before HeyGen → review → approve.

**Smoke:** `curl -s "http://localhost:3000/news/us-canada-videos?limit=3"`

See C0 `lib/routes/c0_sources.js` AJ thin-pool top-up (2026-06-13).
