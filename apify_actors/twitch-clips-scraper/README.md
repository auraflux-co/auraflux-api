# Twitch Clips Scraper — top clips by streamer, no API key

Scrape the **top Twitch clips** for any list of streamers and get clean, structured data back — clip titles, view counts, duration, game, who clipped it, follower counts, and the exact VOD timestamp each clip came from. **No Twitch API key, no OAuth app, and no login required.** Give it channel names, pick a time window, and press Run.

Whether you run a clip-compilation channel, feed a short-form video pipeline, scout esports talent, or monitor a game's coverage, this Twitch clip scraper turns Twitch's own view-ranked clips into a dataset you can filter, sort, and export to JSON, CSV, or Excel.

## Quick start

1. Add one or more streamers to the **Streamers** field — plain logins (`caseoh_`) or full channel URLs (`https://www.twitch.tv/jasontheween`), mixed freely.
2. Pick a **time window** (last 24 hours, 7 days, 30 days, or all time) and a **sort** (most viewed, most recent, or trending).
3. *(Optional)* set duration and minimum-view filters so you only get clips you can actually use.
4. Click **Run**. Results stream into the dataset and can be exported to JSON, CSV, or Excel, or pulled via the Apify API.

The default input works out of the box — press Run without changing anything to see example clips for two popular streamers.

## What you get per clip

| Field | Example | Notes |
|---|---|---|
| `title` | `"Bless You Case!😂"` | Clip title as shown on Twitch |
| `url` | `https://www.twitch.tv/caseoh_/clip/…` | Direct, shareable clip link |
| `viewCount` | `5293` | Twitch view count — the ranking signal |
| `durationSeconds` | `14` | Clip length; filter to match Shorts/TikTok limits |
| `createdAt` | `2026-06-27T04:44:16Z` | ISO timestamp |
| `game` | `"Just Chatting"` | Category the clip was captured in |
| `curator` | `"XxGamer_K1ngxX"` | Who created the clip |
| `broadcaster` | login, display name, **follower count** | Channel context in every row |
| `sourceVodId` + `vodOffsetSeconds` | `2806286803` @ `9591` | Where in the stream the clip happened |
| `thumbnailUrl`, `language`, `isFeatured` | — | Landscape thumbnail + metadata |

## Input options

- **streamers** *(required)* — Twitch logins or channel URLs, one per entry.
- **period** — `24h`, `7d`, `30d`, or `all`. Controls how far back clips are pulled.
- **sort** — `views` (most viewed), `recent` (newest), or `trending`.
- **maxClipsPerStreamer** — 1 to 100. Twitch serves up to 100 clips per streamer per window for anonymous access.
- **minDurationSeconds** / **maxDurationSeconds** — keep clips within a length range (great for short-form pipelines).
- **minViews** — skip clips below a view threshold so you only pay for high-signal results.

### Example input

```json
{
  "streamers": ["caseoh_", "https://www.twitch.tv/jasontheween"],
  "period": "7d",
  "sort": "views",
  "maxClipsPerStreamer": 25,
  "minDurationSeconds": 5,
  "maxDurationSeconds": 60,
  "minViews": 100
}
```

## Who uses this Twitch clip scraper

### Clip channels and video editors
Find the highest-performing moments per streamer per day without scrubbing hours of VODs. Sort by views, filter to the length you need, and pull the direct clip URL plus the source VOD timestamp so you can cut extra context around the moment.

### Short-form / Shorts / Reels / TikTok pipelines
Feed automation with pre-ranked source clips. The duration filters map directly to platform limits (e.g. keep clips under 60 seconds), and every row includes a thumbnail and view count so you can prioritize what to publish first.

### Esports and talent scouting
Track which streamers and which games are producing viral moments. Follower counts and per-game tagging in every row make it easy to spot rising channels and trending categories.

### Brand, game, and community monitoring
Watch the clips coming out of the streamers who play your game, or monitor a community's biggest moments over any time window. Run it on a schedule to build a daily leaderboard of top clips.

## Why choose this Twitch scraper

- **No Twitch API key or login** — no developer account, tokens, or rate-limit management on your side.
- **Ranked at the source** — uses Twitch's own view-count and trending ordering, not a guess applied after the fact.
- **VOD coordinates included** — `sourceVodId` + `vodOffsetSeconds` let you locate and cut the full context around any clip.
- **Built-in quality filters** — duration and view thresholds are applied before results are returned.
- **Clean, predictable output** — one flat dataset item per clip, ready for JSON/CSV/Excel export or the Apify API.

## How to export the data

After a run, open the **Dataset** tab and export to JSON, CSV, Excel, HTML, or RSS, or fetch results programmatically through the Apify API and client libraries. You can also schedule runs and connect the output to Make, Zapier, or your own webhook.

## Frequently asked questions

### Do I need a Twitch account or API key?
No. This scraper reads Twitch's public clip data, so there is nothing to configure — no API key, no OAuth app, no login.

### How many clips can I get per streamer?
Up to 100 clips per streamer per time window. Twitch limits anonymous access beyond one page of results, so for deeper history run several narrower windows (for example, pull the top clips every day rather than one big all-time run).

### Can I scrape multiple streamers at once?
Yes. Add as many logins or channel URLs as you like to the **streamers** field and each is scraped in turn.

### Can I filter by clip length or views?
Yes. Use `minDurationSeconds`, `maxDurationSeconds`, and `minViews`. Filters are applied before results are returned, so you only get — and only pay for — clips that match.

### What time windows are supported?
Last 24 hours, last 7 days, last 30 days, and all time, via the `period` option.

### Does it return the original stream location of a clip?
Yes. Each clip includes `sourceVodId` and `vodOffsetSeconds`, so you can jump to the exact moment in the broadcast the clip was taken from (when the VOD is still available).

### How do I run it on a schedule?
Use Apify Schedules to run the actor hourly, daily, or on any cron expression, then export or forward the dataset automatically.

### Is scraping Twitch clips allowed?
This actor collects publicly available clip metadata. You are responsible for using the data in line with Twitch's Terms of Service and applicable law. Do not use scraped content in ways that infringe creators' rights.

## Local development

```bash
npm install
npm test          # unit tests (mocked network)
npm run smoke     # live hit against real Twitch
apify run         # full actor run with .actor/INPUT
```
