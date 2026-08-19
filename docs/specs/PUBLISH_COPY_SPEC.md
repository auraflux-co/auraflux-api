# Publish Copy Spec — AuraFlux

**Author:** Claude Code
**Date:** 2026-04-18 · **Updated:** 2026-08-19 (CPD-1315 clip-channel vs talent)
**Status:** 🟢 AUTHORITATIVE — supersedes 2026-04-14 version
**Applies to:** `/generate-publish-copy` endpoint, `handleGeneratePublishCopy()` in `lib/publish.js`

---

## Shorts moment contract (CPD-1260) — Twitch clip comps

**Who writes what:** Gemini writes burned on-screen hooks + lead title draft; **GPT-4o** (Gemini fallback) refines YouTube title/description/tags. Claude Sonnet may QA hooks only — it is **not** the publish-copy writer.

**Rule:** Hook + YouTube title + first 1–2 description sentences must sync the **same searchable moment keywords** (streamer + guest / place / stunt / event). Paraphrase OK; inventing a different joke-only angle is not.

| Surface | Role | Must include |
|---|---|---|
| Burned hook | 3–8 word curiosity overlay (no streamer name) | Concrete searchable noun when present (DreamCon, Kai, YourRage, …) |
| `bestTitle` | YouTube Shorts CTR + Search | Streamer + those same moment nouns (query-style when natural) |
| Description opener | First ~150 chars / first 1–2 sentences | Same moment keywords again |

**Why:** Audit CPD-1259 — ExtraEmily Shorts were ~87% Shorts feed / ~7% Search. Query-named moments (e.g. Philippines Top 5) pulled ~70% Search. Feed-only packaging leaves revenue/legs on the table.

**Dual-focus ops (CPD-1261):** ExtraEmily (~6 Shorts/week) + FunnyMike (~2 Shorts/week). Same moment contract for both — not an EE-only code path. Publish few-shots include FunnyMike query winners (`Father's Day Chocolate Chaos`, `Cheapest iPad Hunt`, `Making It Rain`). Gate 5 auto-adds to ExtraEmily Clipz / Funny Mike's Clipz. Soft catalog backfill: `scripts/shorts_focus_seo_backfill.js`.

Enforced in prompts (`buildClipCompSeoInput`, `buildPublishCopySystemPrompt`, Hook Machine) and soft-checked in `metadata_qa.validateMomentKeywordSync`.

### Clip channel vs on-screen talent (CPD-1315)

Some Clip Library sources are **highlight / clip channels**, not the person on screen.

| Role | Example | Use in copy |
|---|---|---|
| **SEO subject (talent)** | IShowSpeed | YouTube title, tags, hashtags, description opener |
| **Source channel** | Speedy Boykins, SpeedUniverse | Lineup label + Featured Streamers credit only — **do not** lead the title |

Composer may show `Speedy Boykins 80s` as the clip slot. That is the source. Search demand is still **IShowSpeed** (e.g. *iShowSpeed Becomes Spider-Man On Fortnite*).

Map: `lib/clip_channel_seo.js`.

---

## What This Document Is

The authoritative spec for what the publish-copy generator produces when producing YouTube/TikTok/Instagram publish copy. All output must match the format and quality of the Customer 0 reference example below. The generator is **GPT-4o** (Gemini fallback). The output is a complete, ready-to-use package — nothing left for the operator to write.

---

## Customer 0 Reference Example — Twitch Long-Form

This is the exact format and quality level Claude must produce. Every field. Every section. Every tone choice.

### YouTube Title
```
Streamer Gets HUMBLED About Fighting Experience 😂 | Funniest Twitch Clips
```

### YouTube Description
```
Welcome to Twitch Soup by ClipzWorld News 🍜 — your daily dose of the funniest Twitch clips, viral streamer moments, and gaming highlights!

In today's episode, a streamer gets completely humbled talking about fighting experience 😂 plus 11 more insane moments from top creators!

⏱️ TIMESTAMPS

0:00 Intro
0:08 Jasontheween gets humbled 😂
0:45 HasanAbi reacts
1:20 StableRonaldo funny moment
1:55 Adapt clip
2:30 Lacy highlight
3:05 Marlon moment
3:40 Cinna reaction
4:10 Yonnajay clip
4:40 JayCinco highlight
5:10 Maya funny moment
5:40 ExtraEmily chaos 😂
6:10 YourRAGEGaming reaction

🎮 Featured Streamers (Support Them 💜)
Jasontheween
https://www.twitch.tv/jasontheween
HasanAbi
https://www.twitch.tv/hasanabi
Adapt
https://www.twitch.tv/adapt
StableRonaldo
https://www.twitch.tv/stableronaldo
Lacy
https://www.twitch.tv/lacy
Marlon
https://www.twitch.tv/marlon
Cinna
https://www.twitch.tv/cinna
Yonnajay
https://www.twitch.tv/yonnajay
JayCinco
https://www.twitch.tv/jaycinco
Maya
https://www.twitch.tv/maya
ExtraEmily
https://www.twitch.tv/extraemily
YourRAGEGaming
https://www.twitch.tv/yourrage

😂 What You'll See:
Funniest Twitch clips of the day
Streamer fails & viral moments
Gaming highlights & reactions
Unfiltered chaos 😂

🚀 Subscribe for DAILY Twitch Clips

If you love funny Twitch moments, streamer drama, and viral highlights, hit that Subscribe button and turn on notifications 🔔

📅 New uploads every day!

🎤 Hosted by:
Bobby G

📢 Disclaimer:
All content belongs to respective streamers. Used for entertainment and highlight purposes.

🔥 Hashtags:
#TwitchClips #FunnyMoments #StreamerFails #TwitchHighlights #Gaming #ViralClips
```

### YouTube Tags (no # prefix — copied into YouTube tag field)
```
twitch clips, funny twitch clips, twitch highlights, twitch fails, streamer fails, viral twitch clips, gaming funny moments, twitch compilation, twitch moments, funny streamers, hasanabi clips, yourrage clips, extraemily twitch, stableronaldo clips, twitch funny compilation, best twitch clips 2026, twitch trending, livestream fails, twitch drama, twitch reaction
```

### Thumbnail Text Options (for Canva or burn overlay — operator picks one)
```
"HUMBLED 😂"
"BRO WAS CONFIDENT…"
"INSTANT REGRET 💀"
"THIS WAS EMBARRASSING"
```

### Pinned Comment
```
What was your favorite streamer clip? Let me know below! 👇 If you enjoyed this, consider subscribing for more Twitch Soup episodes.
www.youtube.com/@clipzworldnews?sub_confirmation=1
```

---

## Description Structure — Section by Section

Every description Claude generates must follow this exact section order. Sections marked REQUIRED always appear. Sections marked CONDITIONAL appear when data is available.

```
1. SHOW INTRO LINE (REQUIRED)
   Format: "Welcome to [SHOW NAME] by [NETWORK] [EMOJI] — [tagline]"
   One line. Show brand emoji. Network name. Show tagline.

2. EPISODE HOOK (REQUIRED)
   1-2 sentences. The biggest moment in the episode.
   Specific, not generic. Makes a viewer who hasn't watched want to click.
   "a streamer gets humbled" not "amazing content today"

3. TIMESTAMPS (REQUIRED — long-form only)
   Header: ⏱️ TIMESTAMPS
   Format: M:SS Label [optional emoji on standout moments only]
   Always starts: 0:00 Intro
   One line per segment/story/game
   Runtime derived from actual segment durations — not estimated

4. FEATURED SOURCES (CONDITIONAL — content type determines format)
   Twitch:  🎮 Featured Streamers (Support Them 💜)
            [Display name]\n[twitch.tv/handle] per streamer
   NBA:     🏀 Games Featured
            [Team A] vs [Team B] — [score if available] per game
   News:    📰 Stories Covered
            [Headline ≤60 chars] per story — no source attribution

5. WHAT YOU'LL SEE (REQUIRED)
   4 bullet points. Specific to this episode's content.
   Not generic. Not "amazing moments" — specific to what this episode has.
   Emoji on 1-2 bullets max.

6. SUBSCRIBE CTA (REQUIRED)
   Platform-cadence line + notification bell 🔔
   Upload cadence line ("New uploads every day!")

7. HOST LINE (REQUIRED)
   🎤 Hosted by: [HOST NAME]

8. DISCLAIMER (CONDITIONAL — Twitch and Sports only)
   📢 Disclaimer: All content belongs to respective [streamers/leagues/networks].
   Used for entertainment and highlight purposes.

9. HASHTAGS FOOTER (REQUIRED)
   Header: 🔥 Hashtags:
   5-6 hashtags inline
   Mix: show-specific + content-type + platform broad
```

**Customer 0 hashtag sets:**

| Content type | Hashtags |
|---|---|
| Twitch/clips | #TwitchClips #FunnyMoments #StreamerFails #TwitchHighlights #Gaming #ViralClips |
| NBA/sports | #NBA #Basketball #NBAHighlights #Sports #GameHighlights #ClipzWorldNews |
| News | #News #WorldNews #NewsHighlights #ClipzWorldNews #BecauseTheLightWasOn |

---

## Timestamps — How to Generate

Timestamps are derived from actual segment durations in the assembled video. Claude receives `segments[]` with `label` and `durationSeconds` per segment.

```
Running total approach:
  0:00  Intro                          ← always first
  [MM:SS from running sum] [label] [emoji on standout moments]

Label formatting per content type:
  Twitch:  [DisplayName] [hook moment from script] — emoji on best 2-3 moments
  NBA:     [Team A] vs [Team B]
  News:    [Story headline truncated to 60 chars]

Emoji rule: maximum 3 emojis across all timestamp lines.
Only on the moments that are genuinely the standout clips.
```

YouTube auto-detects chapters from timestamp format in description. No separate chapter field needed — the timestamp block IS the chapters block.

---

## Title — Rules

```
Format:  [HOOK MOMENT] [EMOJI] | [SHOW DESCRIPTOR]
Max:     100 characters
Hook:    The single most clickable thing in the episode
         Specific > generic
         "Streamer Gets HUMBLED" not "Funny Twitch Clips"
Emoji:   One max in hook. None in show descriptor.
         Pipe ( | ) separator between hook and descriptor.
No:      ALL CAPS show descriptor
         Trailing punctuation
         More than one hashtag
```

Claude generates **5 A/B title variants** — operator picks in dashboard, recommended is index 0:

```json
{
  "titles": [
    "Primary — most clickable hook",
    "Alt 1 — different angle on same moment",
    "Alt 2 — broader episode theme",
    "Alt 3 — question format",
    "Alt 4 — reaction/emotion format"
  ],
  "recommended": 0
}
```

---

## Pinned Comment — Rules

```
Structure:
  Line 1: Episode-specific engagement question
  Line 2: Subscribe CTA with channel URL

Format:
  "[Specific question]? Let me know below! 👇 If you enjoyed this,
   consider subscribing for more [SHOW NAME] episodes.
   www.youtube.com/@[CHANNEL_HANDLE]?sub_confirmation=1"

Episode-specific questions by content type:
  Twitch:  "What was your favorite streamer clip?"
  NBA:     "Which game surprised you the most?"
  News:    "Which story hit different for you?"

Rules:
  - Question must be specific to THIS episode — not a generic CTA
  - Channel handle resolved from customer.config.youtubeHandle — never hardcoded
  - sub_confirmation=1 always appended — forces subscribe dialog on click
  - Operator sees this as a suggestion and can edit before approving
```

**Customer 0 channel handle:** `@clipzworldnews`
**Customer 1+:** `customer.config.youtubeHandle` — required field in customer account setup.

---

## Thumbnail Text Options

Claude generates 4 options per episode. Operator picks in Canva or as burn overlay. These are suggestions — not auto-burned.

```
Format:   Short, punchy, uppercase or title case
Max:      4 words per line, 2 lines max
Style:    Reaction text, not descriptive

At least 1: the reaction/emotion to the moment
At least 1: the setup (what happened before)
Emoji:    On 2 of 4 options max
All:      Must work standalone on a thumbnail without context

Examples from reference:
  "HUMBLED 😂"             ← emotion
  "BRO WAS CONFIDENT…"    ← setup
  "INSTANT REGRET 💀"     ← consequence
  "THIS WAS EMBARRASSING" ← plain reaction
```

---

## Per-Platform Output Schema

Claude returns this complete JSON. Every field. Nothing optional that has a known value.

```json
{
  "youtube": {
    "title": "string — primary title ≤100 chars",
    "titles": ["5 A/B options"],
    "recommended": 0,
    "description": "string — full description with all required sections",
    "tags": ["array", "no hash prefix", "combined 490-500 chars target, hard max 500"],
    "hashtags": ["#in", "#description", "#footer"],
    "categoryId": "string — content-type specific (see table below)",
    "pinnedComment": "string — question + subscribe URL with {{CHANNEL_HANDLE}} resolved",
    "thumbnailTextOptions": ["4 options"],
    "chapters": "string — timestamp block (same as in description, sent separately for YouTube chapter parsing)"
  },
  "tiktok": {
    "caption": "string — hook + hashtags inline ≤2200 runes",
    "coverTimestamp": 1000
  },
  "instagram": {
    "caption": "string — hook + bullets + hashtags ≤2200 chars ≤30 hashtags",
    "mediaType": "REELS"
  }
}
```

**categoryId per content type:**

| Content type | categoryId | YouTube category |
|---|---|---|
| `clips-long` / `clips-short` | `"24"` | Entertainment |
| `sports-long` / `sports-short` | `"17"` | Sports |
| `news-long` / `news-short` | `"25"` | News & Politics |

---

## Customer Account Variables

These must exist in every customer's account config before publish copy runs:

| Variable | Customer 0 | Purpose |
|---|---|---|
| `youtubeHandle` | `clipzworldnews` | Pinned comment subscribe URL |
| `hostName` | `Bobby G` | Hosted by line |
| `network` | `ClipzWorld News` | Show intro line |
| `uploadCadence` | `every day` | Subscribe CTA |

**Show names + taglines per content type (Customer 0):**

| Content type | Show name | Tagline |
|---|---|---|
| `clips-long/short` | Twitch Soup | your daily dose of the funniest Twitch clips, viral streamer moments, and gaming highlights |
| `sports-long/short` | The Other Side of the Pillow | where we appreciate all of yesterday's games in the association |
| `news-long/short` | Because the Light Was On | where we bring you the most impactful news stories of the day, our way |

---

## What Is Manual — Confirmed

Cannot be done via Upload-Post or YouTube Data API. Always done in YouTube Studio after private draft lands:

| Feature | Status |
|---|---|
| YouTube cards | ❌ Manual only |
| End screens | ❌ Manual only |
| A/B thumbnail testing | ❌ Manual — use Claude's 5 title options as the A/B set |
| Playlist assignment | ❌ Manual only |
| Chapter verification | ⚠️ Auto-detected by YouTube from timestamp format — verify manually that YouTube parsed correctly |

Claude generates thumbnail text options and 5 title variants so the operator has everything they need for manual steps without writing anything themselves.

---

## What Flows to /publish — Full Wiring

After operator approves publish copy (or `approvalMode: 'auto'`), the complete package flows to the upload gate. Nothing discarded.

```javascript
{
  // YouTube
  youtube_title:         titles[recommended],        // Primary title
  youtube_description:   description,                // Full description — timestamps + hashtags included
  tags:                  tags,                       // Array, no # prefix
  categoryId:            categoryId,                 // Content-type specific
  thumbnail_url:         thumbnailUrl,               // From Canva export — required, not optional
  first_comment:         pinnedComment,             // Channel handle resolved — required, not optional
  containsSyntheticMedia: true,                     // Always — AI-generated content
  embeddable:            true,
  publicStatsViewable:   true,
  license:               'youtube',

  // TikTok
  tiktok_title:          tiktok.caption,            // Full caption — NOT 90-char truncated
  privacy_level:         tiktokPrivacy,
  post_mode:             'DIRECT_POST',
  is_aigc:               true,
  cover_timestamp:       tiktok.coverTimestamp,     // 1000ms default

  // Instagram
  instagram_title:       instagram.caption,          // Full caption
  media_type:            instagram.mediaType,        // REELS or STORIES

  // Scheduling
  scheduled_date:        deliverySpec.scheduledAt   // From Job Spec if scheduled
}
```

**Fields that were previously conditional and silently dropped — now required:**
- `thumbnail_url` — if missing, pre-publish gate hard fails. Generate thumbnail first.
- `first_comment` — if missing, pre-publish gate hard fails. Generate publish copy first.
- `tags` — always sent from publish-copy output, not dependent on frontend passing them.

---

*This spec is the reference for all publish copy generation. Claude matches this format. Customer-specific values (show names, handles, taglines) live in customer account config, not in code. Last updated 2026-04-18 by Claude Code.*
