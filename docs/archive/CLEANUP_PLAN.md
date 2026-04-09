# CWN Production — Cleanup & Reorganization Plan

**Created:** 2026-04-09
**Status:** PROPOSAL ONLY — awaiting Rob approval before any files are moved or deleted
**Current root file count:** ~180 files (should be ~20)

---

## 🗑️ DELETE IMMEDIATELY (No Value, Safe to Remove)

These files have zero production value and should be deleted now:

### Duplicate HTML iterations (numbered copies — keep only the final)
These are "Save As" copies from iterating on designs. Only the un-numbered version is the final:
```
clipzworld_ticker_auto (1).html through (13).html   ← DELETE 13 files, keep clipzworld_ticker_auto.html
clipzworld_news_banner (1).html                      ← DELETE, keep clipzworld_news_banner.html
market_close_thumbnail (1).html                      ← DELETE, keep market_close_thumbnail.html
market_diag (1).html through (13).html               ← DELETE 13 files, keep market_diag.html
thumbnail_celtics_hawks (1).html through (10).html   ← DELETE 10 files, keep thumbnail_celtics_hawks.html
thumbnail_pistons_thunder (1).html                   ← DELETE, keep thumbnail_pistons_thunder.html
uconn_duke_live (1).html through (9).html            ← DELETE 9 files, keep uconn_duke_live.html
0347a9aa-e396-49a5-b0f1-31261704bab8-profile_image-70x70 (1).jpeg  ← DELETE duplicate
```
**Total: ~49 files deleted**

### Junk / OS / IDE files
```
.DS_Store                          ← macOS metadata, delete
installer.log                      ← install log, delete
github.copilot-chat-0.42.3.vsix   ← VS Code extension installer (21MB!), delete
cwn_twitch_ticker .textClipping    ← macOS text clipping, delete
debug_raw_output.txt               ← debug artifact, delete
```
**Total: 5 files deleted**

### Data exports (CSV files — not code, not needed in repo)
```
internal_all.csv                              ← DELETE
url_all.csv                                   ← DELETE
meta_description_all.csv                      ← DELETE
search_console_all.csv                        ← DELETE
issues_overview_report.csv                    ← DELETE
video_generation_custom_2026-04-05_16-42.csv  ← DELETE
video_generation_custom_2026-04-05_16-42 (1).csv ← DELETE
```
**Total: 7 files deleted**

### Large MP4 files in root (1.1GB total — should be in output/ or external storage)
```
TWITCH Apr 4 (40 avatar + 28 clips).mp4   ← 558MB — MOVE to output/ or DELETE
TWITCH Apr 5 (38 avatar + 27 clips).mp4   ← 513MB — MOVE to output/ or DELETE
```
**Note:** These are already in .gitignore (*.mp4) so they're not tracked. Safe to move/delete.

---

## 📁 PROPOSED FOLDER STRUCTURE

```
cwn-production/
│
├── 📄 CORE (stay in root — agents read these)
│   ├── server.js                    ← Main API
│   ├── cwn_production.html          ← Dashboard
│   ├── package.json
│   ├── package-lock.json
│   ├── nodemon.json
│   ├── .env
│   ├── .gitignore
│   ├── .aider.conf.yml
│   └── .clineignore
│
├── 📚 docs/                         ← ALL markdown docs
│   ├── CLAUDE.md                    ← Architecture (READ FIRST)
│   ├── STATUS.md                    ← Current tasks (READ SECOND)
│   ├── MORNING_BRIEFING.md          ← Overnight run results
│   ├── QA_GATES.md                  ← QA gate specs
│   ├── COMMIT_CHECKLIST.md          ← Pre-commit rules
│   ├── OVERNIGHT_TASKS.md           ← Aider task queue
│   ├── SERVER_SPLIT_PLAN.md         ← server.js refactor plan
│   ├── VISUAL_DESIGN_SPEC.md        ← Short-form layout spec
│   ├── CREATIVE_VS_OPERATIONS.md    ← Phase 5 creative decisions
│   ├── PRODUCTION_SCHEDULE.md       ← Volume targets
│   ├── PLATFORM_REQUIREMENTS.md     ← Platform specs
│   ├── HEYGEN_SCRIPT_FORMAT.md      ← HeyGen format rules
│   ├── README.md                    ← Project overview
│   ├── CLINE_PLAN_TEMPLATE.md       ← Cline plan format
│   ├── CLINE_USAGE_GUIDE.md         ← Cline workflow
│   ├── CLINE_WORKFLOW_SUMMARY.md    ← Cline summary
│   ├── CANVA_MCP_SETUP.md           ← Canva setup
│   ├── CANVA_SETUP.md               ← Canva setup
│   ├── CWN_Production_Manual.html   ← Production manual
│   └── archive/                     ← Stale docs (don't delete, just move)
│       ├── TODO.md
│       ├── AUTOMATION_STATUS.md
│       ├── HANDOVER.md
│       ├── SESSION_SUMMARY.md
│       ├── MASTER_TASK_LIST.md
│       ├── WORKFLOW_GAPS_ANALYSIS.md
│       ├── COMPREHENSIVE_REVIEW.md
│       ├── CODEBASE_OVERVIEW.md
│       ├── IMPLEMENTATION_PLAN.md
│       ├── IMPLEMENTATION_SPEC.md
│       ├── IMPLEMENTATION_AUTOMATION.md
│       ├── NEXT_TEST_PLAN.md
│       ├── FIGMA_DESIGN_SPEC.md
│       ├── UI_TEST_PLAN.md
│       ├── EXAMPLE_PLAN_NBA_CARDS.md
│       ├── HEYGEN_TAIL_README.md
│       ├── CANVA_FIX_SUMMARY.md
│       ├── DESIGN_REVIEW_SUMMARY.md
│       ├── NEWS_COMPILATION_FIX.md
│       ├── FIX_PLAN_SCENE_STRUCTURE.md
│       ├── TEST_FAILURE_ANALYSIS.md
│       ├── TEST1_POSTMORTEM.md
│       ├── URGENT_TEST_FAILURE_INVESTIGATION.md
│       ├── TEST_RESULTS_FINAL_2026-04-09.md
│       ├── GATE1_MAX_DATA_LIMITS.md
│       └── PLATFORM_REQUIREMENTS.md (if superseded)
│
├── 🎨 templates/                    ← HTML overlay/thumbnail templates
│   ├── thumbnails/
│   │   ├── nba_thumbnail_generator.html
│   │   ├── cwn_news_tool.html
│   │   ├── market_close_thumbnail.html
│   │   ├── thumbnail_celtics_hawks.html
│   │   └── thumbnail_pistons_thunder.html
│   ├── tickers/
│   │   ├── clipzworld_ticker_auto.html
│   │   ├── cwn_combined_ticker.html
│   │   ├── cwn_news_ticker.html
│   │   ├── cwn_twitch_ticker.html
│   │   └── sports_ticker.html
│   ├── overlays/
│   │   ├── clipzworld_news_banner.html
│   │   ├── clipzworld_newscast.html
│   │   ├── clipzworld_studio_bg.html
│   │   ├── cwn_broadcast_bg.html
│   │   ├── cwn_seo_preview.html
│   │   └── cwn_twitch_tool.html
│   ├── live/
│   │   ├── nba_game_live.html
│   │   ├── uconn_duke_live.html
│   │   ├── uconn_duke_scoreboard.html
│   │   └── michigan_tennessee_live.html
│   └── market/
│       ├── market_center.html
│       ├── market_diag.html
│       ├── market_master.html
│       ├── market_panel_left.html
│       ├── market_panel_right.html
│       └── market_ticker.html
│
├── 🧪 test/                         ← Test files (already exists, consolidate here)
│   ├── test_suite_12cases.json      ← KEEP — active 12-test suite
│   ├── run_12_test_cases.js         ← KEEP — test runner
│   ├── test_3_longform_production.js ← KEEP — production test
│   ├── test_assembly_payload.json   ← KEEP — assembly test data
│   └── archive/                     ← Old one-off test files
│       ├── test_canva_mcp.js
│       ├── test_newscast_highlights.js
│       ├── test_overlay.js
│       ├── debug_test1.json
│       ├── debug_test2_prompt.js
│       ├── test_fix_client.json
│       ├── test_news_fix.json
│       ├── test_news_thumbnail.json
│       ├── test_script_72scenes.json
│       ├── test_split_1a.json
│       └── test_twitch_thumbnail.json
│
├── 🔧 scripts/                      ← Utility scripts
│   ├── cwn-auth.js                  ← Google Drive auth
│   ├── canva_oauth_helper.js        ← Canva OAuth
│   ├── get_canva_token.js           ← Canva token
│   ├── heygen_monitor.js            ← HeyGen monitor
│   ├── tail_heygen.sh               ← HeyGen tail
│   └── game_config.js               ← Game config
│
├── 📊 data/                         ← JSON data files
│   ├── streamers.json               ← Streamer roster (CRITICAL)
│   ├── cwn_style_guides.json        ← Gemini style guides (CRITICAL)
│   ├── episode_counters.json        ← Episode tracking (CRITICAL)
│   ├── reference_library.json       ← Reference library
│   └── openapi.json                 ← API spec
│
├── 🔑 config/                       ← Config files (gitignored sensitive ones)
│   ├── canva_app_config.json
│   └── [cwn-drive-key.json]         ← Already gitignored
│
├── 📖 reference/                    ← Creative reference materials
│   ├── Space Ghost.pdf
│   ├── The Daily Show.pdf
│   ├── Weekend Update with Norm MacDonald.pdf
│   ├── Creative Requirements and Direction.txt
│   └── basketball only.rtf
│
├── 🖼️ assets/                       ← Already exists, keep as-is
│   ├── cwn_logo.png
│   ├── cwn_banner.png
│   ├── banner_cwn.png
│   ├── logo_cwn.png
│   ├── cwn_logo_transparent.png
│   ├── twitch_glitch.png
│   └── twitchsoup_thumbnail.jpeg
│
├── 📦 lib/                          ← Already exists (clients, error logger)
├── 🐍 VectCutAPI/                   ← Already exists
├── 📋 qa/                           ← Already exists
├── 🪵 logs/                         ← Already exists
└── 🧪 test/                         ← Already exists (consolidate above)
```

---

## 📊 Impact Summary

| Action | Files | Disk Saved |
|--------|-------|------------|
| Delete numbered HTML duplicates | ~49 files | ~500KB |
| Delete junk/OS files | 5 files | ~22MB |
| Delete CSV data exports | 7 files | ~600KB |
| Move MP4s out of root | 2 files | ~1.1GB |
| Move docs to docs/ | ~30 files | 0 (just moves) |
| Move templates to templates/ | ~35 files | 0 (just moves) |
| Move test files to test/ | ~11 files | 0 (just moves) |
| Move scripts to scripts/ | ~6 files | 0 (just moves) |
| Move data to data/ | ~5 files | 0 (just moves) |
| **Root files remaining** | **~20 files** | — |

---

## ⚠️ Important Notes Before Executing

1. **CLAUDE.md must stay in root** — Aider and Claude Code look for it there
2. **STATUS.md must stay in root** — same reason
3. **server.js, cwn_production.html, package.json stay in root** — Node.js convention
4. **These JSON files MUST stay in root** — server.js uses `path.join(__dirname, 'filename')`:
   - `streamers.json` (lines 3240, 8390, 9093)
   - `cwn_style_guides.json` (lines 1668, 6067, 6695, 6883, 8300, 8319)
   - `episode_counters.json` (lines 7991, 7997, 9052)
   - Moving these to `data/` requires updating ~15 path references in server.js
5. **These HTML files MUST stay in root** — server.js serves them via `res.sendFile(__dirname, ...)`:
   - `cwn_news_tool.html` (line 1006)
   - `cwn_twitch_tool.html` (line 1014)
   - Moving these requires updating server.js paths
6. **Ticker HTMLs referenced by filename only** (lines 4390-4391) — `sports_ticker.html`, `cwn_combined_ticker.html` — Puppeteer loads these from the dashboard port, not by file path. Safe to move IF dashboard static server path is updated.
7. **MP4 files** — already gitignored (*.mp4), safe to move to `output/` or delete
8. **client_secret_*.json** — ✅ CONFIRMED in .gitignore — safe, not committed to git

---

## ✅ Security Check Result

```
client_secret_281415000137-...json
```
✅ **Already in .gitignore** (`client_secret_*.json` pattern). Not committed to git history. No action needed.

---

## ✅ Approval Checklist (Before Executing)

- [ ] Rob approves this plan
- [ ] Claude Code notified (some HTML paths may be referenced in server.js)
- [ ] Verify which HTML files server.js references by path (audit needed)
- [ ] Confirm MP4 files can be deleted (not needed for production)
- [ ] Confirm CSV files can be deleted (not needed for production)
- [ ] Check client_secret JSON is in .gitignore
