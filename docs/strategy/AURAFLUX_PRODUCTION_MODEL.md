# AuraFlux — Production Model
**Author:** Claude Code + Rob Gregory, 2026-04-14
**Status:** LOCKED — foundational product spec. Read before any feature work.
**Purpose:** Defines the top-level production model: desired output → source possession → assembly track → gates.

---

## The Two Questions That Drive Everything

Every customer session starts with two questions:

**Question 1: What do you want to make?**
- Short-form videos (TikTok, Reels, YouTube Shorts)
- Long-form video (YouTube episode, full production)

**Question 2: What do you bring?**
- I possess it (files on my machine or Drive)
- I can point you to it (URL, channel, VOD link)
- I can't point you to anything (you source it for me)

These two answers determine the assembly track, the gate behavior, the sourcing strategy, and the publish copy. Everything else is execution.

---

## Short-Form Output

### Track S1 — I possess the clips
- Customer uploads or points to local clips
- Platform packages them into short-form with chrome, avatar intro, captions
- **Assembly:** Forward (clips → short)
- **Sourcing:** None — customer-supplied
- **Gates:** Gate 1 (script/hook), Gate 3 (assembly QA), Gate 6 (publish)

### Track S2 — I can't point you to clips (you source them)
- Customer describes what they want (streamer name, team, topic, date range)
- Platform scrapes, resolves, and selects best clips
- **Assembly:** Forward (scraped clips → short)
- **Sourcing:** Platform scrapes Twitch / ESPN / news sources
- **Gates:** All gates — Gate 1 (script), Gate 2 (footage check), Gate 3 (assembly QA), Gate 6 (publish)
- **CWN today:** This is Rob's primary model

### Track S3 — I possess a long-form, make shorts from it
- Customer uploads or points to a finished long-form video they own
- Platform analyzes it, finds best moments, cuts into short-form packages
- **Assembly:** Reverse (long-form → shorts)
- **Sourcing:** None — customer-supplied long-form
- **Gates:** Gate 3 (clip selection QA), Gate 6 (publish)
- **Status:** Not built — Phase 2

### Track S4 — I can point you to a long-form, make shorts from it
- Customer provides URL (YouTube, Drive, Twitch VOD, podcast)
- Platform ingests, analyzes, extracts best moments, packages into shorts
- **Assembly:** Reverse (ingested long-form → shorts)
- **Sourcing:** Platform downloads/ingests from URL
- **Gates:** Gate 2 (ingest QA), Gate 3 (clip selection QA), Gate 6 (publish)
- **Status:** Not built — Phase 2

---

## Long-Form Output

### Track L1 — I possess the clips, make a long-form
- Customer uploads shorts or clips they own
- Platform scripts around them, adds avatar host, assembles into episode
- **Assembly:** Forward (possessed clips → long-form)
- **Sourcing:** None — customer-supplied
- **Gates:** Gate 1 (script), Gate 3 (assembly QA), Gate 6 (publish)
- **Status:** Partially built — needs clip upload UI

### Track L2 — I can't point you to clips, make a long-form (you source everything)
- Customer describes the show (topic, tone, roster, date)
- Platform sources clips, writes script, renders avatar, assembles episode
- **Assembly:** Forward (scraped clips → long-form)
- **Sourcing:** Platform scrapes all content
- **Gates:** All gates
- **CWN today:** This is Rob's primary model for Twitch Soup / OSOP / Because the Light Was On

### Track L3 — I possess a long-form, give it better production
- Customer has a finished long-form (interview, podcast, stream VOD) they own
- Platform adds: avatar host intro/outro, chrome overlays, ticker, recut for pacing, publish copy
- **Assembly:** Production upgrade (long-form in → produced long-form out)
- **Sourcing:** None — customer-supplied
- **Gates:** Gate 3 (production QA), Gate 6 (publish)
- **Status:** Not built — Phase 2
- **Primary use case:** Podcaster wants YouTube-ready version of their show

### Track L4 — I can point you to a long-form, give it better production
- Customer provides URL to their own content (their YouTube channel, their Twitch VOD)
- Platform ingests it, adds production layer, republishes
- **Assembly:** Production upgrade (ingested long-form → produced long-form out)
- **Sourcing:** Platform ingests from URL
- **Gates:** Gate 2 (ingest QA), Gate 3 (production QA), Gate 6 (publish)
- **Status:** Not built — Phase 2

---

## Source Possession Matrix

| | Possess It | Can Point To It | Need You To Source It |
|---|---|---|---|
| **Want Short-Form** | Track S1 | Track S4 | Track S2 |
| **Want Long-Form** | Track L1 / L3 | Track L4 | Track L2 |

---

## Assembly Tracks

| Track | Direction | Input | Output |
|---|---|---|---|
| **Forward** | Clips → Episode | Clips (possessed, scraped, or pointed-to) | Long-form or short-form |
| **Reverse** | Episode → Clips | Long-form (possessed or pointed-to) | Short-form packages |
| **Production Upgrade** | Long-form → Long-form | Long-form (possessed or pointed-to) | Same content, better production |
| **Clip-Only** | Clips → Clips | Source footage | Packaged individual clips, no episode |

---

## Clip-Only Track

A fourth output type: **just give me clips**.

Customer doesn't want an episode. They want:
- Best 10 moments from last night's stream, packaged as individual clips
- Each clip trimmed, captioned, formatted for platform
- No avatar, no assembly, no episode structure

**Use cases:**
- Streamer wants to post individual moments to TikTok without a compilation
- Curator wants a clip library for future use
- Highlight reel without host commentary

**Status:** Not built — Phase 3

---

## Gate Map by Track

| Gate | Forward (S2/L2) | Forward (S1/L1) | Reverse (S3/S4) | Production Upgrade (L3/L4) |
|---|---|---|---|---|
| **Gate 1 — Script** | ✅ Required | ✅ Required | Optional (hook extraction) | Optional (intro/outro only) |
| **Gate 2 — Footage** | ✅ Required (scraping) | ❌ Customer supplied | ✅ Required (ingest) | ✅ Required (ingest) |
| **Gate 3 — Assembly QA** | ✅ Required | ✅ Required | ✅ Required | ✅ Required |
| **Gate 6 — Publish** | ✅ Required | ✅ Required | ✅ Required | ✅ Required |

---

## Source Type → Platform Behavior

| Source Type | Clip Expiry Risk | Attribution Needed | Disclaimer Needed | Scraping Required |
|---|---|---|---|---|
| Customer possesses (their own content) | None | No | No | No |
| Customer possesses (licensed/rights) | None | Depends on license | Depends | No |
| Customer points to (their own channel/VOD) | Low | No | No | Ingest only |
| Customer points to (third-party) | Medium | Yes | Yes | Ingest only |
| Platform sources (curator model) | High | Yes | Yes | Full scrape |

---

## CWN Today vs AuraFlux

| Track | CWN Today | AuraFlux |
|---|---|---|
| S2 — Sourced short-form | ✅ Built | Multi-customer |
| L2 — Sourced long-form | ✅ Built (primary) | Multi-customer |
| S1 — Possessed clips → short | ❌ Not built | Phase 2 |
| L1 — Possessed clips → long | ❌ Not built | Phase 2 |
| S3 — Possessed long-form → shorts | ❌ Not built | Phase 2 |
| S4 — Pointed long-form → shorts | ❌ Not built | Phase 2 |
| L3 — Possessed long-form → production upgrade | ❌ Not built | Phase 2 |
| L4 — Pointed long-form → production upgrade | ❌ Not built | Phase 2 |
| Clip-only track | ❌ Not built | Phase 3 |

---

## Streamer-First Priority

The primary AuraFlux customer is a **mid-tier Twitch streamer** who:
- Possesses their own content (Twitch VODs via OAuth)
- Wants both long-form (highlight episode) and short-form (clip packages)
- Does not need scraping, attribution, or disclaimer
- Needs Tracks S1, S3, L1 — all possession-based tracks

**Why streamer-first:** They own the content so there are no expiry, attribution, or rights issues. Simpler pipeline, no scraping, no token refresh bugs. Every feature built for streamers is reusable for curators who possess their own content (Track S1, L1, L3).

**Build order:** Streamer tracks first → curator possession tracks reuse the same code → curator sourced tracks (CWN model) already exist.

---

## The Intake Form (UX)

Two screens. No more.

**Screen 1:**
> What do you want to make?
> ○ Short-form videos
> ○ Long-form video

**Screen 2:**
> What are you working with?
> ○ I have the files (upload or connect Drive)
> ○ I have a link (paste URL)
> ○ Tell me what you want and I'll find it

These two answers route the customer to the correct assembly track. Everything after is execution.

---

## The Four Engines

Every production track runs through four engines in sequence. These are the customer-facing names for what the pipeline does internally.

### 1. Moment Engine
**Finds clips.**
Locates, resolves, and selects the best source footage — whether scraped from Twitch/ESPN/news, ingested from a URL the customer provides, or received directly from the customer's own files. For reverse assembly, analyzes a long-form to find the highest-value moments to extract.

**Maps to:** Gate 2 (footage check), clip scraping, Twitch GQL resolution, Brightcove HLS re-scrape, content library (Phase 2)

---

### 2. Story Engine
**Structures the video.**
Writes the script, determines scene order, decides pacing, assigns which clips go where. For forward assembly this is Gemini script generation. For reverse assembly this is moment selection and short-form structure. For production upgrade this is the recut logic.

**Maps to:** Gate 1 (script QA), `geminiScriptGeneration()`, directive sidecar, scene schema, `orderedClipUrls`

---

### 3. 🔥 Scene Engine
**Controls visuals.**
Renders everything the viewer sees: avatar host video (HeyGen), chrome overlays (TV card, lower-third flag, sidebar), ticker, intro cards, transitions, logo, zoom-to-fill crop, thumbnail. The visual production layer.

**Maps to:** Gate 3 (assembly QA), HeyGen rendering, FFmpeg assembly, `generateNewscastOverlay()`, intro card generation, Puppeteer chrome, `assemblyPreFlightCheck()`

---

### 4. Distribution Engine
**Publishes.**
Generates SEO-optimized title/description/tags/thumbnail text, schedules publish time, uploads to YouTube/TikTok/Instagram, adds chapters, cards, end screens, playlists. Tracks post-publish performance and feeds it back into future episodes.

**Maps to:** Gate 6 (publish), `/generate-publish-copy`, Upload-Post API, YouTube Data API v3 (Phase 2), content calendar (Phase 2)

---

### Engine → Gate Map

| Engine | Gate | Pass Condition |
|---|---|---|
| Moment Engine | Gate 2 | Footage downloaded, tokens valid |
| Story Engine | Gate 1 | Score ≥90, no placeholders |
| Scene Engine | Gate 3 | Score ≥70, no freeze, no missing clips |
| Distribution Engine | Gate 6 | Upload-Post returns job_id |

---

## What This Is NOT

- Not a content type selector (Twitch / NBA / News) — that's a sourcing detail, not a product decision
- Not a user type selector (streamer / curator) — that emerges from possession vs sourcing
- Not a form type selector (long / short) — that's Question 1

Content type, user type, and form type are **implementation labels** that live inside the pipeline. The customer never sees them.
