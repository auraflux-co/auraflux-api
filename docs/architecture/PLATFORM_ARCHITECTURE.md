# PLATFORM_ARCHITECTURE.md
**Author:** Claude Code, 2026-04-14  
**Status:** LOCKED — read before any customer-facing feature work  
**Purpose:** Defines the two-sided platform model, three-layer architecture, user types, and what maps to existing CWN code vs net-new AuraFlux work.

---

## The Two-Sided Platform

CWN is one operator on a platform that serves two distinct user types. Every feature, label, and data model must work for both.

### User Type A — The Streamer (owns the content)
A mid-tier Twitch streamer doing 6-8 hour streams. Has hours of clippable content every day. Has no time to edit, package, and publish to YouTube/TikTok/Instagram. Their content is already better than most — they just need the production layer removed.

**What they give the platform:**
- Twitch OAuth token — platform accesses their clips directly via Twitch API
- Show preferences — name, tone, upload frequency
- Approval threshold — auto-publish or review before publish

**What the platform gives them:**
- Daily episode ready for YouTube/TikTok/Instagram — no editing required
- SEO-optimized title, description, tags, thumbnail
- Accurate timestamps, streamer credits, CTAs
- Scheduled publish at optimal time
- Time back — hours per day

**Key difference from curator:** They own the content. No disclaimer needed. Clips come direct from their API, never expire, always high quality.

---

### User Type B — The Curator (covers other people's content)
Rob's model today. Runs a show about streamers, NBA, or news. Does not own the source content — reacts to, covers, and highlights it.

**What they give the platform:**
- Content type (Twitch / NBA / News)
- Roster — which streamers/teams/sources to cover
- Show identity — name, host, handle, brand voice

**What the platform gives them:**
- Same output as User Type A — but with source attribution and disclaimer
- Content library (see Layer 1 below) — clips pre-indexed, no on-demand scraping

**Key difference from streamer:** Needs attribution. Clips have expiry issues (Twitch CDN, Brightcove tokens). Show is about others, not themselves.

---

## The Three Layers

### Layer 1 — Content Library
**What it is:** A persistent, indexed store of clips, games, and stories. Replaces on-demand scraping at job time.

**For streamers:** Auto-populated via Twitch OAuth. Platform ingests their clips continuously. Always fresh, no expiry issues.

**For curators:** Built from scraping + GQL resolution at ingest time (not job time). Clips resolved once, cached, reused across episodes. Solves the Brightcove fastly_token expiry problem permanently — tokens are refreshed at ingest, not 30-60 minutes before assembly.

**Library structure per content type:**
- Twitch: `{ clipId, streamerId, title, url, resolvedMp4Url, resolvedAt, viewCount, duration, thumbnailUrl, game }`
- NBA: `{ gameId, date, away, home, awayScore, homeScore, highlights[], espnUrl }`
- News: `{ articleId, source, headline, summary, videoUrl, ogImage, publishedAt }`

**CWN today:** No library. Every job scrapes fresh. This is why token expiry is a recurring bug.

**AuraFlux:** Library is the core database. Jobs pull from library, never scrape at job time.

---

### Layer 2 — Production Pipeline
**What it is:** The existing CWN pipeline. Script gen → HeyGen → Assembly → QA gates → Drive upload.

**Already built for CWN.** Needs these changes for multi-customer:
- `channelConfig` object on every job (see PUBLISH_COPY_SPEC.md)
- `userType` field drives attribution, disclaimer, clip sourcing
- Labels renamed from internal technical names to customer-facing language (see Naming section below)
- Show-specific constants moved out of server.js hardcoding into job card / customer profile

**Does NOT change:** Gate logic, FFmpeg assembly, HeyGen integration, QA scoring. These are universal.

---

### Layer 3 — Distribution & Growth
**What it is:** Publish + schedule + optimize + iterate.

**Phase 1 (now — CWN):**
- Upload-Post API for YouTube/TikTok/Instagram publish
- Auto-generated title/description/tags/thumbnail (PUBLISH_COPY_SPEC.md)
- Manual: cards, end screens, TubeBuddy SEO

**Phase 2 (AuraFlux):**
- YouTube Data API v3 integration — chapters, cards, end screens automated
- TubeBuddy-equivalent pre-flight: keyword research, best time to publish, SEO score
- A/B title + thumbnail testing (Upload-Post supports this)
- Post-publish: tag management from actual search traffic, comment management
- Playlist management — auto-add episodes to correct playlist, update playlist description

**TubeBuddy parity target (post-Phase 2):**
- Keyword Explorer → built into script gen (keywords inform title + description)
- SEO Studio → built into `/generate-publish-copy` (real-time score)
- Thumbnail Analyzer → Gate 3 + thumbnail preview in dashboard
- Best Time to Publish → YouTube Data API v3 audience analytics
- A/B Testing → Upload-Post title/thumbnail variants
- Search Traffic → YouTube Data API v3 search term reports

---

## Naming — Labels Must Reflect Customer Intent

Every internal label that exposes to a customer must be renamed. The pattern:

> "What is the end user trying to accomplish?" → that's the label.  
> Not: "what does the code do internally?"

### Current internal names → Customer-facing names

| Internal (now) | Customer-facing (target) |
|---|---|
| `contentType` | Content Category |
| `assembleJob()` | Create Episode |
| `segmentData` | Video Segments |
| `source_clip` | Source Footage |
| `orderedClipUrls` | Selected Clips |
| `Gate 1` | Script Review |
| `Gate 2` | Footage Check |
| `Gate 3` | Episode Review |
| `Gate 6` | Publish |
| `qaOutcome: pass` | Ready to Publish |
| `qaOutcome: manual_review` | Needs Your Review |
| `qaOutcome: fail` | Issues Found |
| `formType: compilation` | Long-Form Episode |
| `formType: short` | Short Clip |
| `HeyGen render` | Generating Host Video |
| `Assembly` | Building Episode |
| `Drive upload` | Saving Episode |
| `thumbDriveUrl` | Episode Thumbnail |
| `channelConfig` | Channel Settings |
| `streamerRoster` | Your Roster |

These renames apply to:
- Dashboard UI labels and button text
- API response field names (breaking change — needs versioning)
- Log messages shown to operator
- Error messages
- Email/notification copy

**Rule:** Internal code variable names can stay as-is (server.js, lib/). Only what surfaces in UI, API responses, or docs needs the customer-facing name.

---

## User Type Detection Flow

```
Onboarding:
  → "Are you a content creator covering your own streams?"
    YES → userType: 'streamer' → Twitch OAuth flow → library auto-populates
    NO  → userType: 'curator' → content type selection → roster setup
  
Per job:
  → userType flows from customer profile to job card
  → Pipeline reads userType at each stage:
    - Script gen: streamer = first-person voice; curator = third-person coverage
    - Attribution: streamer = no disclaimer; curator = disclaimer required
    - Clip source: streamer = library (their own); curator = library (curated)
    - Publish copy: streamer = "MY channel"; curator = "featuring [streamer names]"
```

---

## What Maps to Existing CWN Code

| Platform Feature | CWN Code Today | Status |
|---|---|---|
| Script generation | `geminiScriptGeneration()` | Works, needs channelConfig |
| QA gates 1-3 | `claudeScriptQA()`, `geminiQACheck()` | Works |
| HeyGen avatar | `/assemble` pipeline | Works |
| Assembly | `server.js` run() function | Works |
| Drive upload | `uploadToDrive()` | Works |
| Multi-platform publish | Upload-Post via `/publish` | Works |
| Publish copy | `/generate-publish-copy` | Needs full rewrite per PUBLISH_COPY_SPEC.md |
| Thumbnail generation | HTML tools (manual screenshot) | Phase 2: Puppeteer render |
| Content library | None | Net new — Phase 2 |
| Customer profiles | None | Net new — AuraFlux DB |
| Twitch OAuth | None | Net new — streamer user type |
| YouTube Data API | None | Net new — Phase 2 distribution |
| TubeBuddy parity | None | Net new — Phase 2/3 |

---

## Implementation Priority

### Now (CWN production — before any customer)
1. Fix `/generate-publish-copy` per PUBLISH_COPY_SPEC.md — outputs 5 titles, full description, accurate timestamps, streamer links, tags vs hashtags, playlist description, thumbnail text ideas
2. Wire `channelConfig` to job card — hardcode CWN values, design the object shape for AuraFlux reuse
3. Fix thumbnail pipeline — `thumbDriveUrl` persisted to job card (CLINE_HANDOFF_THUMBNAIL_WIRE.md)
4. News + NBA smoke tests passing

### Phase 2 (AuraFlux MVP)
1. Customer profile + `channelConfig` from DB
2. Content library (curator path first — Twitch clip indexing)
3. Puppeteer thumbnail rendering from HTML generators
4. YouTube Data API v3 — chapters, cards, end screens automated
5. UI label rename pass

### Phase 3 (Streamer user type)
1. Twitch OAuth integration
2. Auto-library population from streamer's own clips
3. First-person script voice for streamers
4. Streamer-specific publish copy (no disclaimer, different CTA)

---

## YouTube Data API v3 — What We Actually Need

**Auth:** OAuth 2.0 — same pattern as the existing Google Drive auth (`cwn-auth.js`). One-time browser flow, saves refresh token to `.env`. Scopes needed: `youtube.readonly` (analytics) + `youtube.upload` (upload management, already handled by Upload-Post) + `youtube.force-ssl` (required for write operations).

**Daily quota:** 10,000 units free. Posting once daily costs ~50-100 units. Reading analytics costs 1-5 units per call. No meaningful cost at CWN volume.

---

### The 6 Endpoints That Actually Matter

#### 1. Upload metadata — `videos.update`
**What it does:** Sets title, description, tags, category, thumbnail, scheduled publish time after upload.  
**Why:** Upload-Post handles the upload but doesn't set everything. This fills the gap — accurate timestamps, full description, all tags.  
**Cost:** 50 units per call.  
**When to call:** Immediately after Upload-Post confirms upload success (Gate 6 complete).  
**Replaces:** Manual YouTube Studio editing.

#### 2. Add to playlist — `playlistItems.insert`
**What it does:** Adds the new video to the correct series playlist (e.g., "Twitch Soup", "Other Side of the Pillow").  
**Why:** Every episode should auto-join its series playlist. Manual today.  
**Cost:** 50 units per call.  
**When to call:** Same time as videos.update.

#### 3. Add cards + end screens — `videos.update` with `suggestions`
**What it does:** Adds subscribe card, end screen with subscribe button + link to latest video.  
**Why:** Rob sets these manually today. Same end screen template on every video — fully automatable.  
**Cost:** 50 units per call (same call as title/description update).  
**When to call:** Same time as videos.update.

#### 4. Search traffic report — `youtubeAnalytics.reports.query`
**What it does:** Returns which search terms drove views to each video over the past 28 days.  
**Why:** Feed actual search terms back into the next episode's tags. TubeBuddy's "Search Traffic" tool does exactly this — we can replicate it from our own data.  
**Cost:** 1 unit per call.  
**When to call:** Daily cron job — pull report for all videos published in last 30 days, store in job card.  
**Output:** `{ videoId, searchTerms: [{ term, views, impressions, ctr }] }` — used to update tags on existing videos AND inform tags on next episode.

#### 5. Audience timing — `youtubeAnalytics.reports.query` with `viewerPercentage` by hour
**What it does:** Returns what hours your audience watches. Requires 100+ subscribers to get meaningful data.  
**Why:** "Best time to publish" — schedule episodes at peak audience hours instead of guessing.  
**Cost:** 1 unit per call.  
**When to call:** Weekly cron job once channel has subscribers. Store result as `channelConfig.bestPublishHour`.  
**Output:** Hour of day (0-23) with highest `viewerPercentage` for your audience timezone.

#### 6. Video performance — `videos.list` with `statistics`
**What it does:** Returns views, likes, comments, impressions, CTR for any video.  
**Why:** Feed performance data back into script gen and thumbnail decisions. Which title style got highest CTR? Which thumbnail text worked? Over time this trains the generator.  
**Cost:** 1 unit per call.  
**When to call:** 48h after publish (initial spike), 7 days after (algorithm window), 30 days after (long tail).  
**Output:** Stored on job card as `job.publishMetrics` — feeds into future episode prompts.

---

### What We Explicitly Skip

| TubeBuddy Feature | Why Skip |
|---|---|
| Keyword Explorer | YouTube's search suggest API gives 80% of this free — add later if needed |
| Competitor analytics | Requires TubeBuddy's proprietary crawl — not available via official API |
| A/B thumbnail testing | Upload-Post supports this — add in Phase 3 |
| Comment management | Low priority until channel has meaningful comment volume |
| Bulk metadata update | Useful later for fixing old videos — not Phase 2 |
| Channel audit | Nice to have, not blocking growth |

---

### Integration Architecture

```
Gate 6 complete (Upload-Post returns videoId)
    ↓
youtubeApi.updateVideo(videoId, {
  title:       selectedTitle,         ← operator picked from 5 options
  description: fullDescription,       ← from /generate-publish-copy
  tags:        tags[],                ← from /generate-publish-copy
  thumbnail:   thumbDriveUrl,         ← from assembly
  scheduledAt: channelConfig.bestPublishHour  ← from analytics cron
})
    ↓
youtubeApi.addToPlaylist(videoId, playlistId)  ← from channelConfig
    ↓
youtubeApi.addEndScreen(videoId)               ← standard template
    ↓
job.stage = 'published'
    ↓
[48h later] youtubeApi.getStats(videoId) → job.publishMetrics
[7d later]  youtubeApi.getStats(videoId) → job.publishMetrics
[28d later] youtubeApi.getSearchTerms(videoId) → feed back to tags
```

---

### Auth Setup (same as Drive)

Add to `cwn-auth.js` — one additional OAuth scope, one additional token stored in `.env`:

```
YOUTUBE_REFRESH_TOKEN=   # run cwn-auth.js once to generate
```

One auth flow covers both Drive and YouTube since both are Google APIs.

---

## The North Star

A mid-tier Twitch streamer wakes up, opens the platform, sees last night's 6-hour stream already processed into a 10-minute YouTube episode and three TikTok clips — titles written, thumbnails generated, description SEO-optimized, scheduled to post at the optimal time for their audience. They approve it in 30 seconds and go back to streaming.

That is what we are building toward. Every architectural decision should be evaluated against whether it gets closer to or further from that outcome.
