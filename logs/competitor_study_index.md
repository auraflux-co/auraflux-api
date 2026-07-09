# Competitive Study Index — Opus · CapCut · TubeBuddy · vidIQ

**Ticket:** [CPD-1235](https://aurafluxco.atlassian.net/browse/CPD-1235) (expanded scope)  
**Repo:** `~/cwn-c0` · **Method:** help/docs scrape + public browser walkthrough (auth where available)

## Artifacts

| Competitor | Inventory | Coverage log | vs C0 focus |
|------------|-----------|--------------|-------------|
| **Opus Clip** | `opus_suite_inventory.md` | `opus_full_coverage_log.md` | Clip discovery, editor, publish |
| **CapCut** | `capcut_suite_inventory.md` | `capcut_full_coverage_log.md` | Editor, AI captions, export |
| **TubeBuddy** | `tubebuddy_suite_inventory.md` | `tubebuddy_full_coverage_log.md` | YouTube SEO, bulk, A/B |
| **vidIQ** | `vidiq_suite_inventory.md` | `vidiq_full_coverage_log.md` | YouTube growth, AI metadata, clipping |
| **vidIQ MCP** | `vidiq_mcp_probe.md` | 46-tool probe + C0 benchmark harness | Platform-wide vs ClipzWorld memory |

Shared Opus artifacts: `opus_walkthrough_notes.md`, `opus_learning_center_catalog.json`, `opus_arcade_remaining_notes.md`, **`opus_public_github.md`** (MCP + CLI + skills)

Walkthrough notes: `capcut_walkthrough_notes.md`, `tubebuddy_walkthrough_notes.md`, `vidiq_walkthrough_notes.md`, `youtube_studio_walkthrough_notes.md`

**Extension Studio matrix (TB + vidIQ):** `extension_studio_surfaces.md`

**Position + roadmap:** `competitive_position_roadmap.md`  
**Render API:** `auraflux_render_api.md` (`https://api.auraflux.co/v1`)

## C0 relationship (one line each)

| Competitor | C0 overlap | C0 unique |
|------------|------------|-----------|
| Opus | Compose, clip assembly, publish | Soup bookends, HeyGen, operator gates, live grid |
| CapCut | `lib/routes/c0_capcut.js` draft export (VectCut API) | Full pipeline assembly — not a general NLE |
| TubeBuddy | `lib/intelligence/ab_rotation.js`, calendar publish, SEO copy | Operator production line; ROADMAP TubeBuddy-lite via YT Analytics |
| vidIQ | Hook Machine cites `vidiq-viral-hooks`; competitor tracking CPD-1209 | End-to-end produce + publish, not browser extension |

## Auth status (browser)

| Product | Public marketing | Logged-in app |
|---------|------------------|---------------|
| Opus | — | ✅ clipzworldmail (complete) |
| CapCut | ✅ capcut.com/tools + help | **doc-complete** (login blocked — see alternative coverage) |
| TubeBuddy | ✅ tubebuddy.com/tools | ✅ ClipzWorld News — **Legend** license (`tubebuddy.com/account`) |
| vidIQ | ✅ vidiq.com/features | ✅ clipzworldmail — Feed, Optimize, Research, Clipping (`vidiq_walkthrough_notes.md`) |

## Next passes (when authed)

1. ~~CapCut~~ — **closed** (`capcut_alternative_coverage.md`) — consumer login blocked
2. ~~**vidIQ**~~ — **done** (2026-07-09 authed walkthrough)
3. ~~**TubeBuddy**~~ — account logged in + extension docs complete (`extension_studio_surfaces.md`); live extension UI needs operator Chrome
4. **Opus benchmark** — CLI ✅ + MCP ✅ (`logs/opus_benchmark/`); next: C0 same-URL timing row

## Opus test video (when we circle back)

| Source | Path / URL | Works with |
|--------|------------|------------|
| ClipzWorld VOD | `data/post_live_vod_sessions.json` YouTube URLs | ✅ Opus API `videoUrl` |
| Local test MP4 | `output/apply_sources_test.mp4` | ✅ Dashboard file upload; API needs **public** URL (S3 or platform) |
| `assets/` | No `.mp4` committed in repo | — |

`OPUS_API_KEY` probes **200** on `api.opus.pro` (2026-07-09). Plan: short ClipzWorld YT URL via API + same asset on `clip.opus.pro` for editor/score comparison vs C0.
