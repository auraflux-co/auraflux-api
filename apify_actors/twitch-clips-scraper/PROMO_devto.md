<!--
Promo / SEO article draft for dev.to (or Medium / hashnode) — CPD-1224.
Popularity is 10% of Apify's actor quality score, and external tutorials that
link back drive both referral traffic and Google ranking for the actor page.

Before posting:
1. Publish the actor first, then confirm its public URL. Expected:
   https://apify.com/adventurous_vanity/twitch-clips-scraper
   (replace everywhere below marked <ACTOR_URL> if the slug differs)
2. On dev.to add tags: twitch, webscraping, javascript, api
3. Set a cover image (reuse the actor logo or a Twitch-clip screenshot).
4. Canonical URL: leave as dev.to; if cross-posting to Medium, set the
   canonical to whichever you published first.
-->

---
title: "How to get the top Twitch clips for any streamer — no API key"
published: false
description: "Pull ranked Twitch clips (views, duration, game, VOD offsets) for any list of streamers without a Twitch API key, using a small Apify actor."
tags: twitch, webscraping, javascript, api
---

If you run a clip channel, a short-form video pipeline, or you're just tracking which streamers are producing viral moments, you've probably hit the same wall I did: **getting Twitch clip data is annoying.** The official Helix API needs a registered app, a client ID, an OAuth token you have to refresh, and rate-limit handling. That's a lot of plumbing before you get a single clip.

Here's a way to skip all of it and get **ranked Twitch clips for any list of streamers with zero credentials.**

## The problem with the "normal" way

To use Twitch's official clips endpoint you need to:

1. Create a Twitch developer application
2. Manage a client ID and secret
3. Mint and refresh an OAuth app access token
4. Resolve each streamer's numeric broadcaster ID before you can query clips
5. Handle pagination and rate limits yourself

None of that is hard, exactly — but it's a half day of boilerplate for what should be a one-liner.

## The shortcut: a keyless Twitch clips scraper

Twitch's own web player talks to a public GraphQL endpoint using a public client ID. That means you can read the same clip data the website shows — view counts, durations, games, who clipped it, and the exact VOD timestamp — **without any account of your own.**

I packaged this into an Apify actor so you can run it from a UI, on a schedule, or via API: **[Twitch Clips Scraper](<ACTOR_URL>)**.

### Input

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

- **streamers** — logins or full channel URLs, mixed freely
- **period** — `24h`, `7d`, `30d`, or `all`
- **sort** — `views`, `recent`, or `trending`
- **min/max duration + minViews** — quality filters applied before results are returned

### Output — one clean row per clip

```json
{
  "title": "Bless You Case!",
  "url": "https://www.twitch.tv/caseoh_/clip/PunchySavory...",
  "viewCount": 5293,
  "durationSeconds": 14,
  "game": "Just Chatting",
  "curator": "XxGamer_K1ngxX",
  "broadcaster": { "login": "caseoh_", "displayName": "caseoh_", "followers": 8711003 },
  "sourceVodId": "2806286803",
  "vodOffsetSeconds": 9591,
  "createdAt": "2026-06-27T04:44:16Z"
}
```

Notice `sourceVodId` and `vodOffsetSeconds` — those tell you *where in the original stream* the clip happened, so you can cut extra context around any moment instead of being stuck with the fixed clip length.

## Three things you can build with it

### 1. A daily "top clips" leaderboard
Schedule the actor to run every morning with `period: "24h"` and `sort: "views"` across your favorite streamers. Export to a sheet or push to a webhook and you've got an automatic daily digest of the best moments.

### 2. A short-form content feed
Set `maxDurationSeconds: 60` and `minViews: 500`, and every result is a pre-ranked, platform-ready source clip for TikTok / Shorts / Reels automation — thumbnail and view count included so you know what to publish first.

### 3. Trend + talent tracking
Because each row carries the game and the broadcaster's follower count, you can watch which categories are producing viral clips and which smaller channels are punching above their weight.

## Running it

The easiest path is the actor's **Run** button in the Apify console — the default input works out of the box. To automate, call the run-sync endpoint and get the dataset back in one request:

```bash
curl -X POST "https://api.apify.com/v2/acts/<ACTOR_ID>/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"streamers":["xqc"],"period":"7d","sort":"views","maxClipsPerStreamer":10}'
```

That returns a JSON array of clips, ranked, filtered, and ready to use.

## The one limitation to know

Anonymous access returns up to ~100 clips per streamer per time window (Twitch gates deeper pagination). In practice that's plenty — and if you want more history, run narrower windows on a schedule (a daily `24h` pull beats one big `all`-time run and keeps your data fresh).

## Try it

Grab it here: **[Twitch Clips Scraper on Apify](<ACTOR_URL>)**. No Twitch API key, no login — point it at streamer names and go.

If you build something with it, I'd love to hear what — drop a comment.
