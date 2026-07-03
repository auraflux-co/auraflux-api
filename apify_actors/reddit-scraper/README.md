# Reddit Scraper Lite — posts & comments

Clean, minimal Reddit scraping: subreddit listings and full comment threads as structured JSON. **No Reddit API credentials, no OAuth app** — pay only for the results you get.

## Two modes

### `subreddit_posts`

```json
{
  "mode": "subreddit_posts",
  "subreddits": ["PublicFreakout", "r/videos"],
  "sort": "top",
  "timeFilter": "day",
  "maxResults": 25
}
```

One dataset item per post: `title`, `score`, `upvoteRatio`, `numComments`, `created`, `author`, `externalUrl`, `domain`, `isVideo` + direct `videoUrl` for v.redd.it hosted video, `thumbnail`, `over18`, `stickied`.

### `post_comments`

```json
{
  "mode": "post_comments",
  "postUrls": ["https://www.reddit.com/r/videos/comments/abc123/some_post/"],
  "maxCommentsPerPost": 200
}
```

Returns the post followed by its comment tree, flattened with `depth`, sorted by score, `[removed]`/`[deleted]` filtered out.

## Who this is for

- **Content pipelines** — pull the day's top posts from your niche subs on a schedule
- **Video sourcing** — `isVideo` + `videoUrl` surface v.redd.it clips ready for download tooling
- **Sentiment / research** — full comment threads with scores and nesting depth
- **Trend monitoring** — `top` + `timeFilter` snapshots per subreddit per day

## Notes

- Runs over residential proxy on the Apify platform (Reddit blocks datacenter IPs).
- Post items and comment items share one dataset; filter by the `type` field.
- Max 100 posts per subreddit per run, 500 comments per post.

## Local development

```bash
npm install
npm test      # unit tests (mocked network)
apify run     # live run — uses your own IP locally
```
