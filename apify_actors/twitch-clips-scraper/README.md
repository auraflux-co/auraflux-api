# Twitch Clips Scraper

Get the top Twitch clips for any list of streamers — **no Twitch API key, no OAuth app, no login**. Point it at channel names, pick a time window, and get clean structured clip data back.

## What you get per clip

| Field | Example |
|---|---|
| `title` | `"Bless You Case!😂"` |
| `url` | `https://www.twitch.tv/caseoh_/clip/PunchySavory…` |
| `viewCount` | `5293` |
| `durationSeconds` | `14` |
| `createdAt` | `2026-06-27T04:44:16Z` |
| `game` | `"Just Chatting"` |
| `curator` | who clipped it |
| `broadcaster` | login, display name, **follower count** |
| `sourceVodId` + `vodOffsetSeconds` | where in the stream the clip happened |
| `thumbnailUrl`, `language`, `isFeatured` | — |

## Input

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

- **streamers** — logins or channel URLs, mixed freely
- **period** — `24h`, `7d`, `30d`, `all`
- **sort** — `views`, `recent`, `trending`
- **min/max duration + minViews** — server-side quality filters so you only pay for clips you can use

## Who this is for

- **Clip channels & editors** — find the highest-performing moments per streamer per day without scrubbing VODs
- **Short-form pipelines** — feed TikTok/Shorts/Reels automation with pre-ranked source clips (duration filters match platform limits)
- **Esports & talent scouting** — track which streamers and games are producing viral moments
- **Brand monitoring** — watch clips mentioning your game across the streamers who play it

## Why this Actor

- **Keyless** — no Twitch developer account, tokens, or rate-limit management on your side
- **Ranked at the source** — Twitch's own view-count / trending ordering, not post-hoc guessing
- **VOD coordinates included** — `sourceVodId` + `vodOffsetSeconds` let you cut longer context around any clip
- **Quality filters** — duration and view thresholds applied before results are charged

## Limits

Anonymous Twitch access serves up to **100 clips per streamer per window**. For deeper history, run multiple windows (`24h` daily beats `all` once).

## Local development

```bash
npm install
npm test          # unit tests (mocked network)
npm run smoke     # live hit against real Twitch GQL
apify run         # full actor run with .actor/INPUT
```
