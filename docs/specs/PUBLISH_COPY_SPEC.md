# PUBLISH_COPY_SPEC.md
**Author:** Claude Code, 2026-04-14  
**Status:** LOCKED — reference before touching `/generate-publish-copy` or any publish metadata  
**Purpose:** Defines exactly what the publish copy generator must produce, what inputs it needs, and which values are CWN-specific vs customer-configurable for AuraFlux.

---

## The Standard to Match

The canonical reference for output quality is the ChatGPT session from 2026-04-14 that produced the Twitch Soup #1 description. Key properties of that output:

- 5 title options with emotion hooks, not 1 generic title
- Full description with show identity opening line
- Accurate timestamps per streamer/segment
- Featured streamers section with clickable Twitch URLs
- "What You'll See" bullet section
- Subscribe CTA with notification reminder
- Upload frequency line
- Host credit (Bobby G)
- Disclaimer for non-owned content
- Hashtags (in description) AND tags (separate YouTube backend field) — two distinct things
- Playlist description as a separate deliverable
- Thumbnail text ideas (3-5 options)

---

## What the Current Endpoint Gets Wrong

| Problem | Root Cause |
|---|---|
| Output too short | Script truncated to 600 chars — not enough context |
| 1 title, not 5 options | Prompt asks for one title |
| No streamer URLs | `streamers.json` not passed to prompt |
| Hashtags and tags conflated | Prompt doesn't distinguish them |
| No playlist description | Never requested |
| No thumbnail text ideas | Never requested |
| No show identity line | "Twitch Soup" / "Other Side of the Pillow" not in prompt |
| No host credit | Bobby G not mentioned |
| No disclaimer | Not in prompt |
| No episode number | Not passed in |
| Timestamps are guessed | `buildYouTubeChapters()` output not passed to prompt |

---

## Required Inputs

### Always required
| Field | Source | Notes |
|---|---|---|
| `contentType` | Job card | `twitch` / `nba` / `news` |
| `formType` | Job card | `long` / `short` |
| `script` | Job card | **Full script, not excerpt** |
| `date` | Auto | Today's date, long format |
| `episodeNumber` | Job card / operator input | e.g. `1`, `47` |
| `channelConfig` | Job card (see below) | Show name, host, handle, CTA, upload frequency |

### Twitch only
| Field | Source | Notes |
|---|---|---|
| `streamers` | Job card | Array of display names in episode order |
| `streamerRoster` | `streamers.json` | Full roster with `{ displayName, twitchUrl, twitchUsername }` — filter to featured streamers |
| `hookMoment` | Derived from script | The single funniest/most surprising moment — used in title + description opener |

### NBA only
| Field | Source | Notes |
|---|---|---|
| `games` | Job card | Array of `{ away, home, awayScore, homeScore }` |
| `hookMoment` | Derived from script | Best play/moment of the night |

### News only
| Field | Source | Notes |
|---|---|---|
| `stories` | Job card | Array of `{ headline, source }` |
| `hookMoment` | Derived from script | Most compelling story for title hook |

### For accurate timestamps
| Field | Source | Notes |
|---|---|---|
| `chapters` | `buildYouTubeChapters()` output | Pre-built timestamp string — pass directly to prompt, do not re-generate |

---

## Channel Config Object

This travels with every job. For CWN it is hardcoded. For AuraFlux customers it comes from their profile.

```json
{
  "showName": "Twitch Soup",
  "channelName": "ClipzWorld News",
  "handle": "@clipznashite",
  "host": "Bobby G",
  "uploadFrequency": "every other day",
  "ctaSubscribe": "Subscribe & turn on notifications 🔔 so you never miss an upload!",
  "disclaimer": "All content belongs to respective streamers. Used for entertainment and highlight purposes.",
  "userType": "curator",
  "niche": "gaming / twitch clips",
  "tone": "funny, deadpan, unfiltered"
}
```

**CWN show names by content type:**
- Twitch: `"Twitch Soup"`
- NBA: `"Other Side of the Pillow"`
- News: `"Because the Light Was On"`

**Customer-configurable fields (AuraFlux):**
- `showName` — their show
- `channelName` — their channel
- `handle` — their YouTube/TikTok handle
- `host` — their on-screen host name
- `uploadFrequency` — their schedule
- `disclaimer` — curator vs streamer (streamers don't need it)
- `userType` — `'streamer'` | `'curator'`
- `niche` — their content category
- `tone` — their voice

---

## Required Output Structure

```json
{
  "youtube": {
    "titles": [
      "Streamer Gets HUMBLED About Fighting Experience 😂 | Twitch Soup #1",
      "Funniest Twitch Clips of the Day 😂 | Twitch Soup",
      "Twitch Streamer Gets ROASTED About Fighting Skills 😂",
      "Top Twitch Fails & Funny Moments 😂 | ClipzWorld News",
      "You Won't Believe What This Streamer Said… 😂 | Best Twitch Clips 2026"
    ],
    "description": "...(full description per spec below)...",
    "tags": ["twitch clips", "funny twitch clips", "twitch highlights", "streamer fails", "..."],
    "hashtags": ["#TwitchClips", "#FunnyMoments", "#StreamerFails", "#Gaming"],
    "pinnedComment": "Which clip was funniest? Drop your timestamp below 👇",
    "playlistDescription": "...(per spec below)...",
    "thumbnailTextIdeas": ["HUMBLED 😂", "BRO WAS CONFIDENT…", "INSTANT REGRET 💀", "THIS WAS EMBARRASSING"]
  },
  "tiktok": {
    "caption": "...(90-150 chars, hook first, 4-6 hashtags mixed in naturally)..."
  },
  "instagram": {
    "caption": "...(125 char hook, then full description, 10-15 hashtags at end)..."
  }
}
```

---

## YouTube Description Structure (in order)

```
[Show identity line] — "Welcome to [SHOW NAME] by [CHANNEL NAME] [emoji] — [one-line show pitch]"

[Episode hook] — "In today's episode, [HOOK MOMENT] [emoji] plus [N] more [content descriptor]!"

⏱️ TIMESTAMPS
[chapters string from buildYouTubeChapters() — accurate, not guessed]

🎮 Featured [Streamers / Teams / Stories] (Support Them! 💜)
[For Twitch: DisplayName\nhttps://www.twitch.tv/username — one per line]
[For NBA: Team names + game result]
[For News: Headline + source]

😂 What You'll See:
[4 bullet points derived from script content]

🚀 Subscribe CTA
[ctaSubscribe from channelConfig]

📅 [uploadFrequency from channelConfig]

🎤 Hosted by: [host from channelConfig]

📢 Disclaimer: [disclaimer — only for curator userType]

🔥 Hashtags: [5-8 description hashtags]
```

---

## YouTube Tags (separate from hashtags)

Tags go in the YouTube Studio tags field, NOT in the description. They are comma-separated keywords for the algorithm, not display hashtags.

**Format:** lowercase, no `#`, search-intent phrases
**Count:** 15-25 tags
**Pattern:** specific → broad
- Specific: streamer names, game names, specific moments
- Mid: "twitch clips", "twitch highlights", "funny streamers"  
- Broad: "gaming", "livestream", "funny moments 2026"

**Must include for Twitch:** streamer usernames as tags (YouTube indexes them)
**Must include for NBA:** team names, player names from script
**Must include for News:** story topics, countries/regions mentioned

---

## Playlist Description Structure

```
Welcome to [SHOW NAME] by [CHANNEL NAME] [emoji] — [one-line series pitch]

This series features:
[4 bullet points describing series content]

[Broad appeal line — who will enjoy this]

🔥 [Update frequency line]
```

---

## Title Rules

- **5 options always** — operator picks one
- **Option 1:** Hook moment + show name + episode number (e.g. "Streamer Gets HUMBLED 😂 | Twitch Soup #1")
- **Option 2:** Content descriptor + emotion (e.g. "Funniest Twitch Clips of the Day 😂")
- **Option 3:** Curiosity/intrigue hook (e.g. "You Won't Believe What This Streamer Said…")
- **Option 4:** Keyword-first SEO title (e.g. "Best Twitch Clips Compilation 2026 😂")
- **Option 5:** Show brand + episode number only (e.g. "Twitch Soup #1 | ClipzWorld News")
- Max 100 chars hard limit (YouTube truncates at ~70 in search)
- Include 1 emoji per title
- Never generic — must reference something specific from the script

---

## Platform Caveats

| Element | YouTube | TikTok | Instagram |
|---|---|---|---|
| Title | Separate field, 5 options | No title — caption only | No title — caption only |
| Description | Long-form, structured | Not used | Not used |
| Caption | Not used | 90-150 chars optimal, 2200 max | 125 char hook, 2200 max |
| Hashtags | In description (5-8) + tags field (15-25) | 4-6 mixed into caption | 10-15 at end of caption |
| Timestamps | In description | Not used | Not used |
| Streamer links | In description | Not used | @mentions if possible |
| Playlist desc | Separate deliverable | N/A | N/A |
| Thumbnail | Uploaded separately | Auto-generated or uploaded | Uploaded separately |

---

## Hook Moment Extraction

The `hookMoment` drives the title Option 1 and description opener. It is the single most compelling moment in the episode.

**How to extract from script:**
- For Twitch: find the most emotionally charged segment — biggest laugh, most surprising moment, most shareable reaction. Look for capitalized words, [beat] pauses around punchlines, or the cold open subject.
- For NBA: find the most dramatic play — buzzer beater, big comeback, unexpected upset
- For News: find the most provocative story — highest stakes, most unexpected development

**Format for title:** "[Emotion verb in caps] + context" — e.g. "Gets HUMBLED", "ROASTED", "LOSES IT", "CAN'T BELIEVE"

---

## What Does NOT Change Per Customer (CWN constants)

- Bobby G voice and name
- CWN show names (Twitch Soup / Other Side of the Pillow / Because the Light Was On)
- `@clipznashite` handle
- Gold/dark brand aesthetic references
- Disclaimer text

## What DOES Change Per Customer (AuraFlux variables)

Everything in `channelConfig` — show name, host, handle, upload frequency, niche, tone, disclaimer, userType. When AuraFlux ships, these come from the customer's profile. Until then, CWN values are hardcoded constants in server.js.

---

## Implementation Notes for Cline

1. **Pass full script** — remove the `script.substring(0, 600)` truncation at `server.js:8776`. Pass the full script. Claude can handle it.
2. **Pass `streamerRoster`** — filter `streamers.json` to only the streamers featured in this episode (match against `job.streamers` array). Pass as structured array with `displayName` + `twitchUrl`.
3. **Pass `chapters`** — the output of `buildYouTubeChapters()` is already computed at `server.js:5286`. Pass it directly to `/generate-publish-copy` so the prompt can embed it verbatim — do not ask Claude to regenerate timestamps.
4. **Pass `episodeNumber`** — add to job card at script gen time, pass through to publish copy.
5. **Pass `channelConfig`** — hardcode CWN values as a constant in server.js for now. AuraFlux will replace with customer profile lookup.
6. **Request 5 titles** — update prompt to explicitly request 5 title options in the `titles` array.
7. **Separate tags from hashtags** — prompt must explicitly distinguish YouTube description hashtags (display, `#Tag`) from YouTube tags field (algorithm, lowercase keywords).
8. **Request playlist description** — add to prompt output requirements.
9. **Request thumbnail text ideas** — add to prompt output requirements.
10. **hookMoment extraction** — add a pre-pass that scans the script for the most compelling moment before the main prompt runs. Can be a simple Claude call or regex heuristic on the cold open subject.
