# vidIQ MCP — tool inventory (probed 2026-07-09)

**Endpoint:** `https://mcp.vidiq.com/mcp`  
**Auth:** Bearer `VIDIQ_MCP_API_KEY`  
**C0 bridge:** `lib/intelligence/adapters/vidiq_mcp.js`  
**Compare harness:** `lib/intelligence/vidiq_compare.js` · `scripts/vidiq_c0_benchmark.js`

## Scope difference

| Source | Corpus | What it knows |
|--------|--------|----------------|
| **C0** | ClipzWorld News jobs + `config/competitors.json` | Your channel memory, publish decisions, peer Shorts catalog |
| **vidIQ MCP** | 135M+ channels, 12B+ videos | Global keywords, outliers, trends, cross-niche patterns |

Same YouTube OAuth on our side — vidIQ adds **platform-wide** indexes we do not have locally.

## All 46 MCP tools

| Tool | Title | C0 native equivalent |
|------|-------|---------------------|
| `vidiq_keyword_research` | Keyword Research | **GAP** — `recommendContext` only (channel memory) |
| `vidiq_outliers` | Video Outliers | `competitors.js` outlier patterns (peer tier only) |
| `vidiq_channel_stats` | Channel Stats | Channel Stats page + Analytics API |
| `vidiq_trending_videos` | Trending Videos | **GAP** |
| `vidiq_breakout_channels` | Breakout Channels | **GAP** |
| `vidiq_channel_search` | Channel Search | **GAP** |
| `vidiq_video_stats` | Video Stats History | Content Memory per-video sync |
| `vidiq_get_videos_by_ids` | Get Videos by IDs | YouTube Data API |
| `vidiq_youtube_search` | Search YouTube | **GAP** |
| `vidiq_get_channels_by_ids` | Get Channels by IDs | **GAP** |
| `vidiq_balance` | Credits Balance | — |
| `vidiq_user_channels` | User Channels | `YOUTUBE_CHANNEL_ID` |
| `vidiq_channel_videos` | Channel Videos | Content Memory list |
| `vidiq_video_transcript` | Video Transcript | composition / post-live paths |
| `vidiq_video_comments` | Video Comments | **GAP** |
| `vidiq_channel_performance_trends` | Channel Performance Trends | Analytics sync |
| `vidiq_channel_analytics` | Channel Analytics | `channel_analytics.js` |
| `vidiq_trend_categories` | Trend Categories | **GAP** |
| `vidiq_similar_channels` | Similar Channels | competitor roster (manual) |
| `vidiq_submit_feedback` | Submit Feedback | — |
| `vidiq_score_title` | Score Title | `publish_optimize.js` |
| `vidiq_score_thumbnail` | Score Thumbnail | **GAP** (thumbnail QA partial) |
| `vidiq_generate_titles` | Generate Titles | `publish.js` / OpenAI |
| `vidiq_generate_thumbnail` | Generate Thumbnail | VectCut / Imagen |
| `vidiq_refine_thumbnail` | Refine Thumbnail | **GAP** |
| `vidiq_video_watch` | Watch Video | Gemini video review gates |
| `vidiq_ig_*` | Instagram tools | Upload-Post IG (partial) |
| `vidiq_list_competitors` | List Competitors | `competitors.js` |
| `vidiq_update_competitors` | Update Competitors | `config/competitors.json` |
| `vidiq_generate_*` | Clip/script/video gen | Pipeline portals (different scope) |

## Benchmark scenarios (C0 routes)

`POST /intelligence/vidiq/compare`

| Scenario | vidIQ tool | C0 path |
|----------|------------|---------|
| `optimize_title` | `vidiq_score_title` | `scorePublishMetadata` |
| `keyword_research` | `vidiq_keyword_research` | `recommendContext` |
| `outliers_shorts` | `vidiq_outliers` | `competitorPatterns` |
| `channel_analytics` | `vidiq_channel_analytics` | Analytics API + Content Memory |

## How to run compare tests

```bash
# Add key to .env (not committed):
# VIDIQ_MCP_API_KEY=vidiq_...

node scripts/vidiq_c0_benchmark.js
node scripts/vidiq_c0_benchmark.js --scenario optimize_title --title "Your title"

# Or Intelligence page → vidIQ vs C0 BENCHMARK → Run compare
```

Results append to `logs/vidiq_c0_benchmark.jsonl`.
