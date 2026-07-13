# ClipzWorld YouTube — North Star

**Channel:** [@clipzworldnews](https://www.youtube.com/@clipzworldnews)  
**Scope:** CWN dashboard only (`cwn-c0` → Channel Stats). Not AuraFlux product UI.  
**Goal:** Earn **$300/day** from YouTube ad revenue on reaction content — streamer drama, world news, sports.

---

## 1. Revenue target

| Format | Typical RPM | Views needed for $300/day |
|--------|-------------|---------------------------|
| Long-form VOD + live replays (mid-rolls) | $2–5 / 1k | **60k–150k** daily views |
| Shorts only | $0.01–0.05 / 1k | **6M–30M** daily views |

**Realistic mix for ClipzWorld:** edited VODs carry most ad revenue; Shorts are discovery; lives add engagement + Super Chats (not counted in the $300 ad model).

Use **measured channel RPM** once OAuth revenue data is wired — do not plan off generic Shorts RPM alone.

---

## 2. Target daily cadence

| Surface | Target/day | Role |
|---------|------------|------|
| Livestreams | 0–2 | Breaking stories, live grid reactions; Super Chats bonus |
| VODs (edited) | 1–2 | 10–15 min highlights; mid-roll ads; highest RPM |
| Shorts | 3–5 | 30–60s hooks; funnel to VODs via related video links |

**Content pillars:** Streaming (primary) · News · Sports — already categorized in `lib/services/channel_stats.js`.

---

## 3. View decay model (hypothesis — validate with data)

Reaction/news content decays faster than evergreen tutorials. Treat these as **targets to measure**, not facts.

### Livestreams / live replays
- **Day 1:** ~70% of lifetime views  
- **Days 2–3:** steep drop (~80%)  
- **Day 4+:** near zero unless major event

### Edited VODs (news / streamer / sports)
- **Days 1–3:** ~60% of views  
- **Days 4–7:** ~50% drop as story ages  
- **Day 8+:** 5–10% of peak; search traffic if title has durable entity (streamer name, team, event)

### Shorts
- **Day 1:** ~40% of views (Shorts feed)  
- **Days 2–5:** secondary shelf spike (~50% more)  
- **Day 6+:** flat unless search-driven

### Back catalog (snowball)
Older uploads contribute passive daily views. For reaction channels, catalog share is **lower** than evergreen niches — expect meaningful compounding only when titles are search-durable (streamer names, `#twitch`, team names).

**Week 1:** 100% of daily views must come from new uploads.  
**Month 3+:** catalog may contribute thousands/day if library + search titles grow.  
**Measure it** — do not assume 50–80% from catalog until Analytics proves it.

---

## 4. Three north-star KPIs

These belong at the top of **Channel Stats** (scrollable section below existing cards).

| KPI | Definition | Healthy signal |
|-----|------------|----------------|
| **Daily progress** | Yesterday’s views + est. revenue vs $300 target | Trending up week over week |
| **Back-catalog ratio** | Day 4+ daily views ÷ total daily views | Rising over months (search + library) |
| **Format RPM** | est. revenue ÷ views × 1k, split Shorts / VOD / Lives | VOD RPM > live replay RPM |

**Secondary:** Shorts decay curve (avg views by age Day 1–7) · upload cadence vs target · subs gained per surface.

---

## 5. Catalog tactics (execution, not dashboard)

1. **Title for search, thumbnail for browse** — entity names in title (streamer, team, event).  
2. **Playlists** — e.g. streamer drama trackers, weekly sports reactions.  
3. **Shorts → VOD links** — related video on Shorts pointing at edited long-form.

---

## 6. Stats dashboard — what exists today

**Page:** `cwn_production.html` → sidebar **Channel Stats** → `GET /stats/channel` → `lib/services/channel_stats.js`

| Block | Data | Notes |
|-------|------|-------|
| Summary cards | Lifetime views by Shorts / Videos / Lives + subs | Public via yt-dlp |
| BY SURFACE & CATEGORY | Count + lifetime views + avg | Streaming / News / Sports |
| Per-video table | Views, engaged views, avg % viewed, subs gained | OAuth → `channel_analytics.js` (365d window, max 200 videos) |
| Upload-Post card | Cross-platform followers / impressions | Optional |
| OAuth banner | Analytics connected or reconnect prompt | Needs `yt-analytics.readonly` |

**Also on dashboard (not Stats page):** YOUTUBE HOURLY ANALYTICS on broadcast ops — daily views chart, separate from Channel Stats.

---

## 7. Gap — what we need to track toward north star

| Need | Have today | Gap |
|------|------------|-----|
| **Daily views** (not lifetime) | Partial — `channelSummary.daily` fetched but **not shown on Stats page** | Surface 7d / 28d daily views + avg/day |
| **$300/day progress** | Nothing | Target bar: yesterday revenue or views-at-RPM vs $300 |
| **Back-catalog ratio** | Nothing | Per-day query: views by video × age bucket (Day 1–3, Day 4+) |
| **Views by format × age** | Nothing | Join Analytics daily video rows + catalog `published` + `tab` |
| **Format RPM** | No `estimatedRevenue` in API calls | Add `yt-analytics-monetary.readonly` scope + revenue metrics |
| **Upload cadence vs target** | Can derive from catalog `published` dates | Count uploads/day by surface; compare to 1–2 / 1–2 / 3–5 targets |
| **Shorts decay curve** | Nothing | Aggregate Shorts views by days-since-publish (Day 1–7) |
| **New-upload burden** | Nothing | Daily views from videos published in last 3 days vs total |

---

## 8. Proposed Stats page layout (scroll)

Keep existing blocks. Add **below summary cards**, before BY SURFACE & CATEGORY:

```
┌─────────────────────────────────────────────────────────────┐
│ NORTH STAR — $300/day                          [28d ▼]      │
│ ████████░░░░░░░░  $47 / $300 est. (28d avg $1.68/day)       │
│ Yesterday: 1,240 views · 2 VODs · 4 Shorts · 1 Live         │
└─────────────────────────────────────────────────────────────┘

┌──────────────┬──────────────┬──────────────┬──────────────┐
│ 28d views    │ Back catalog │ VOD RPM      │ Cadence      │
│ 34,820       │ 12% Day 4+   │ $3.40/1k     │ 3.2 Shorts/d │
│ avg 1,243/d  │ target 30%+  │ (est.)       │ target 3–5   │
└──────────────┴──────────────┴──────────────┴──────────────┘

┌─ DAILY VIEWS (28d) ────────────────────────────────────────┐
│  ▂▄▆█▆▄▂  mini bar chart from analytics.channelSummary.daily │
└─────────────────────────────────────────────────────────────┘

┌─ VIEWS BY AGE × SURFACE (yesterday) ────────────────────────┐
│           Day 1   Day 2   Day 3   Day 4+                    │
│  Shorts     420     180      90      12                   │
│  VODs       310      95      40     880  ← catalog tail   │
│  Lives      890     120      30       4                   │
└─────────────────────────────────────────────────────────────┘

┌─ SHORTS DECAY (avg views by age, last 30 Shorts) ───────────┐
│  D1 ████████  D2 ████  D3 ███  D4 ██  D5 █  D6–7 ░         │
└─────────────────────────────────────────────────────────────┘

… existing BY SURFACE & CATEGORY, Upload-Post, video table …
```

---

## 9. Implementation plan (cwn-c0)

### Phase A — Quick wins (no new API scopes)
**Ticket:** CPD-1060 (proposed)

- [x] Env/config: `CWN_NORTH_STAR_DAILY_USD=300`, cadence targets in config or `.env`
- [x] Stats UI: **North Star** section using data already in report
- [x] Files: `cwn_production.html`, `lib/services/north_star_stats.js`, `lib/services/north_star_config.js`, tests

### Phase B — Video-age matrix (Analytics API)

- [x] `lib/services/north_star_analytics.js` — day×video join, age buckets, cache
- [x] Extend `buildChannelStatsReport()` → `northStar` block

### Phase C — Revenue + RPM

- [x] `estimatedRevenue` in channel summary + age rows when `yt-analytics-monetary.readonly` connected
- [x] OAuth scope added — **reconnect at /connect/youtube** to enable
- [x] North Star progress bar + format RPM cards

### Phase D — Alerts & calendar tie-in

- [x] Cadence alerts on Channel Stats + Content Calendar north star card

---

## 10. API reference (implementation notes)

**Already connected:** YouTube Data (OAuth) + Analytics readonly via `/connect/youtube`  
**Scopes needed for full north star:**

| Scope | Purpose |
|-------|---------|
| `yt-analytics.readonly` | Views, retention, subs — **have** |
| `yt-analytics-monetary.readonly` | `estimatedRevenue`, RPM — **need for Phase C** |

**Age bucketing logic:**

```
ageDays = daysBetween(viewDate, video.published_date)
bucket = ageDays <= 1 ? 'day1' : ageDays === 2 ? 'day2' : ageDays === 3 ? 'day3' : 'day4plus'
surface = catalog.tab  // shorts | videos | streams
```

**Back-catalog ratio:**

```
backCatalogRatio = sum(views where ageDays >= 4) / sum(all views)   // for selected period
```

Use catalog `tab` for surface (not liveStreamingDetails flag). Short detection already handled by yt-dlp tab listing.

---

## 11. Current channel baseline (2026-06-23)

From cached `data/channel_stats_clipzworldnews.json`:

| Metric | Value |
|--------|-------|
| Subscribers | ~144 |
| Catalog items | 83 (12 videos · 34 shorts · 37 streams) |
| Lifetime views | ~45.6k |
| Analytics merge | OAuth metrics null in cache — reconnect for engaged views / subs |

At current scale, north star tracking is **directional** (cadence, daily views trend, age matrix) until view volume supports stable RPM.

---

## 12. Definition of done

North star section is **done** when Channel Stats answers, without opening YouTube Studio:

1. Are we trending toward $300/day? (revenue or views proxy)  
2. What % of yesterday’s views came from catalog (Day 4+)?  
3. Are we hitting daily upload cadence by surface?  
4. Which surface pays best per 1k views (RPM by format)?  
5. Are Shorts getting a Day 3–4 shelf spike?
