# SHARED_NEWSCAST_SET_MIGRATION.md

**Author:** Claude Code (drafted 2026-04-13)
**Status:** Design doc — for Rob's review and approval before any code changes
**Not a handoff.** No commit template, no Cline checklist. Read, annotate, approve (or push back), then we'll write phase-specific handoffs from this spec.

---

## 1. The problem

CWN runs three content types through the long-form pipeline: News, NBA, and Twitch. Each one currently has its own independent path for rendering on-screen chrome (the non-clip, non-avatar visual layer — top bar, sidebar, lower-third flag, TV card, logo, ticker). This has produced three separate problems:

**A. TV card generation is three separate Canvas functions with different dimensions.** Twitch renders a 640×360 profile-photo rectangle, NBA renders a game-thumbnail rectangle, News renders an Open Graph-scraped article rectangle. The `CLAUDE.md` spec says all three should use the same 640×360 TV-shape with gold 5px border in the same `OVERLAY_ZONE` at `{x:1240, y:40, w:640, h:360}`, but the implementations have drifted. The actual current pixel dimensions per content type come from a separate Explore task that's queued — this doc flags the drift but does not resolve it.

**B. News newscast chrome is News-only.** Fix 7 shipped `tools/clipzworld_newscast.html` + `generateNewscastOverlay()` — a Puppeteer-rendered HTML template that produces a full-screen transparent PNG containing the top bar, sidebar, and lower-third flag positioned for the News layout. NBA and Twitch have no equivalent. Their current overlays are just TV card + logo + ticker burns layered onto raw source + avatar video. No top bar. No sidebar. No lower-third flag.

**C. Visual consistency is asymmetric.** News looks like a news broadcast. NBA and Twitch look like cropped source video with a floating card in the corner. Branding is not the same "set" across content types. When a viewer scrolls from a News upload to an NBA upload on the channel, there's no shared visual language tying them to CWN beyond the ticker and the logo.

The goal is to collapse all three onto a single shared chrome template, parameterized by brand config, so the "set" is the same and only the colors, labels, and inner content differ.

---

## 2. The target state

All three content types render the same chrome layout via the same Puppeteer template — one HTML file, one rendering function, one coordinate system. What changes per content type:

- Brand colors (primary hex + accent hex)
- Segment tag labels (what the top bar says after the episode number)
- Sidebar item list source (story / game / streamer)
- Lower-third flag text source and formatting
- TV card inner content (which PNG generator fills the 640×360 rectangle)

What does NOT change per content type:

- The template HTML structure
- The CSS positioning of top bar, sidebar, flag, TV card overlay zone, and ticker zone
- The Puppeteer render pipeline
- The FFmpeg burn call that composites the transparent PNG over source video

One template, three brand configs, same layout. A viewer scrolling through the channel sees the same visual frame regardless of content type, with color and content cues telling them what they're watching.

---

## 3. What becomes a shared template parameter

Currently hardcoded into `tools/clipzworld_newscast.html` and `generateNewscastOverlay()` for News. Target state: extracted into a `brandConfig` object passed via Puppeteer's `page.evaluate()` step.

**3.1 Brand primary hex color.** Used for top bar background, sidebar header bar, lower-third flag fill.
- News: existing News blue (current value in `tools/clipzworld_newscast.html`)
- NBA: **TBD — Rob to provide**
- Twitch: `#9146FF` (Twitch purple, already in `streamers.json` — confirm)

**3.2 Brand accent hex color.** Used for border strokes, highlight accents, tag dot.
- News: existing News gold
- NBA: **TBD — Rob to provide**
- Twitch: **TBD — Rob to provide**

**3.3 Top bar brand string.** Currently `"BECAUSE THE LIGHT WAS ON | EPISODE N"` for News. This string may be universal across all three content types (the "CWN brand voice") or may customize per type. Open question for Rob — see section 6.

**3.4 Segment tag label.** The small pill/tag text on the top bar indicating the current segment.
- News: `"WORLD NEWS"`, `"POLITICS"`, `"TECH"`, etc — per story category
- NBA: `"NBA"` as a flat label, OR `"GAME 1: LAKERS @ CELTICS"` style per-game — open question
- Twitch: streamer category (e.g. `"JUST CHATTING"`, `"VALORANT"`) per clip, OR a flat `"TWITCH"` — open question

**3.5 Sidebar item type.** Currently a vertical list of News stories with a "NOW" indicator on the active one.
- News: story list (headline + source)
- NBA: game list (matchup + score)
- Twitch: streamer list OR clip list — open question

**3.6 Lower-third flag text.** Currently scrolling/static flag at the bottom-left showing active item metadata.
- News: story headline + source (e.g. `"GAZA CEASEFIRE TALKS STALL — REUTERS"`)
- NBA: game matchup + venue (e.g. `"LAKERS @ CELTICS — TD GARDEN"`)
- Twitch: streamer display name + clip title (e.g. `"JASON — HE ACTUALLY DID IT"`)

**3.7 TV card inner content generator.** The 640×360 rectangle in `OVERLAY_ZONE` gets its inner image from a content-type-specific PNG generator. The template places the rectangle; the generator fills it.
- News: `generateNewsTVCard()` — og:image scrape + headline + source logo
- NBA: `generateNBATVCard()` — game thumbnail + team logos + scores + PPG leaders + W/L records
- Twitch: `generateTwitchTVCard()` — streamer profile image + name + origin + fact

These stay as three separate functions because the input data and visual treatment are genuinely different. The template just accepts a pre-rendered PNG path for the TV card layer.

---

## 4. What stays content-type-specific

Not everything should be shared. The following remain per-content-type and are explicitly NOT in scope for the unification:

- **TV card inner content generator** — as noted in 3.7, different data sources, different visual treatments, different PNG generators. Keep three.
- **Data ingestion** — News ingests RSS + scrapes article pages. NBA pulls from ESPN API. Twitch pulls from GQL API. Completely different upstream paths. Do not unify.
- **Gemini prompts** — News writes newscast-style narration. NBA writes live play-by-play narration over highlights. Twitch writes reaction/commentary setup-clip-reaction. Different content patterns, different style guides in `cwn_style_guides.json`. Same structural principles (scene headers, [beat] markers, display names) but different writing instructions. Keep three.
- **Assembly-time clip handling** — NBA uses voiceover mode (Bobby G talks over ESPN clip audio mixed down). News uses zoom-to-fill crop on scraped video. Twitch uses zoom-to-fill crop on Twitch CDN clips. These are different FFmpeg filter graphs and should stay separate.
- **Publish-time hashtags** — News uses news hashtags. NBA uses NBA/player/team hashtags. Twitch uses streamer/game hashtags. Already handled via `generatePublishCopy`, not part of the chrome template.

The rule of thumb: **chrome is shared, content is not.** If a change is about how the frame looks (colors, positions, layout), unify it. If a change is about what fills the frame (data, voice, clips), keep it per type.

---

## 5. Migration order

Five phases. Each phase gated on the previous one passing smoke tests before moving on.

**Phase 1: Lock News chrome via smoke test loop.** In progress as of 2026-04-13. Iterate through `CLINE_HANDOFF_NEWS_*` fix rotation until the News long-form pipeline produces N consecutive clean smoke test runs with no new Gate 3 failures and no new gap-list items surfacing. This is the reference implementation. Nothing downstream can start until News is locked. Rob defines "locked" based on his review of smoke test output.

**Phase 2: Extract brand params into a `brandConfig` object.** Refactor `tools/clipzworld_newscast.html` to read all color, label, and content-source values from a `brandConfig` object injected via Puppeteer `page.evaluate()`. Create `data/brand_configs.json` with three entries: `news`, `nba`, `twitch`. Initially only `news` is populated with the current locked values. `nba` and `twitch` are stub entries with `TBD` placeholders. Refactor `generateNewscastOverlay()` to accept a `contentType` arg and pass the corresponding brand config to the template. News keeps using its current config — zero visual regression expected. News smoke tests #9+ verify this: the output PNG should be byte-identical (or at minimum visually identical) to the pre-refactor output. If there's any drift, fix the refactor before proceeding.

**Phase 3: Wire NBA's assembly path to call the shared overlay.** Rob provides NBA brand hex values (primary + accent) and answers the NBA-specific open questions in section 6. Populate the `nba` entry in `data/brand_configs.json`. Update NBA's assembly path in `server.js` to call `generateNewscastOverlay('nba', ...)` instead of whatever NBA currently uses for chrome. Build `generateNBATVCard()` as the parallel PNG generator for the inner content of the 640×360 TV card — game thumbnail + team logos + scores + PPG + records. Run NBA long-form smoke tests. Iterate on NBA-specific issues surfaced (coordinate conflicts, text overflow in the flag, sidebar overcrowding for 5-game episodes). Gate phase completion on "NBA passes N consecutive clean smoke tests on the new chrome."

**Phase 4: Same for Twitch.** Rob provides Twitch brand hex values (confirm `#9146FF` primary, provide accent) and answers Twitch-specific open questions. Populate the `twitch` entry. Wire Twitch's assembly path. Build `generateTwitchTVCard()` (this may be close to the existing Twitch intro-card function, just re-targeted to the shared OVERLAY_ZONE). Smoke test loop. Iterate.

**Phase 5: Deprecate legacy overlay paths.** Once all three content types run through the unified overlay, delete or archive the old per-content-type overlay code paths. Update `CLAUDE.md` to reflect the new unified architecture. Update `GATED_PIPELINE_ARCHITECTURE.md` if needed. This is a cleanup pass, not a functional change.

**Rough schedule guess** (for planning only, not a commitment): Phase 1 is days-to-weeks depending on smoke test cadence. Phase 2 is a single focused session. Phase 3 is days. Phase 4 is days. Phase 5 is a single cleanup pass. Total wall-clock estimate: 2-4 weeks from News lock to Phase 5 done.

---

## 6. Open questions for Rob

These need answers before Phase 2 starts. Phase 2 can't populate `data/brand_configs.json` without them.

**Q1. NBA brand hex colors.** What primary + accent? Options: NBA league red/white/blue, a custom CWN-NBA palette (e.g. hardwood amber + net white), or team-agnostic dark+gold. Recommendation: pick one palette that works across all teams, don't swap per-game.

**Q2. Twitch brand hex colors.** Primary is presumably `#9146FF` (Twitch purple from `streamers.json`) — confirm. What's the accent? White? Neon pink? Custom CWN-Twitch accent?

**Q3. NBA segment tag labels.** Flat `"NBA"` on the top bar across the entire episode, OR dynamic per-game (`"GAME 1: LAKERS @ CELTICS"`, `"GAME 2: ..."`)? Flat is simpler and keeps the top bar stable across cuts. Dynamic adds context but means the top bar re-renders per game section.

**Q4. Twitch sidebar content.** Streamer list (one row per streamer in the episode, 10 rows for a 10-streamer compilation) OR clip list (one row per clip, could be 70+ rows)? Streamer list is cleaner; clip list gives per-clip metadata but overflows the sidebar.

**Q5. Tagline across types.** Does `"BECAUSE THE LIGHT WAS ON | EPISODE N"` stay verbatim across News, NBA, and Twitch? Or does each content type get its own tagline? Examples: NBA = `"BECAUSE THE GAME WAS ON | EPISODE N"`, Twitch = `"BECAUSE THE STREAM WAS ON | EPISODE N"`. Cute but may be gimmicky. Recommendation: keep the News tagline universal unless Rob feels strongly.

**Q6. Episode numbering.** Is the episode counter shared across all content types (one global counter) or per-content-type (News Ep 47, NBA Ep 12, Twitch Ep 89)? Current state: per-content-type (`data/episode_counters.json` has separate counters). Confirm this stays.

---

## 7. What this migration does NOT touch

Scope guardrails. These are out of scope and should not be pulled into any of the five phases:

- **Short-form split-screen layout.** Different format (9:16), different layout (top-half clip + bottom-half avatar), different overlay rules. A short-form migration is a separate doc and happens after long-form is unified.
- **Thumbnail generation.** Already unified via `generateThumbnail` in `server.js`. Canva templates are already parameterized. No work needed here.
- **Ticker.** Already shared via `TICKER_MAP` per content type. The ticker is already parameterized by content type and burned in a consistent bottom strip. No migration needed.
- **Publish-time metadata.** Already unified via `generatePublishCopy`. Title, description, hashtags, pinned comment generation is already a single code path with content-type branching inside it.
- **HeyGen avatar rendering.** Avatar choice + voice + script generation are content-type-specific and stay that way. This migration is only about the chrome layer that sits on top of the rendered avatar video.
- **Gate 1/2/3 QA prompts.** These are content-type-specific because the content is specific. Not touched.
- **NBA voiceover V2.** Separate dispatch (`CLINE_DISPATCH_NBA_VOICEOVER_V2_QUEUED.md`), queued behind Phase 3 of this migration. Not part of the chrome unification itself.

---

## 8. Risks and rollback

**Risk: News smoke tests regress during Phase 2 refactor.** Mitigation: before/after PNG diff on the overlay output. If News output drifts at all (even sub-pixel), back out Phase 2 and investigate. The refactor should be a pure extraction — no visual change to News.

**Risk: NBA chrome looks wrong on actual game content.** Mitigation: Phase 3 smoke test loop with Rob in the review seat, same cadence as News Phase 1.

**Risk: Brand colors clash with source video.** Particularly NBA, where source is ESPN highlights with their own heavy on-screen graphics. Mitigation: Phase 3 smoke tests surface this; adjust brand config iteratively. Don't lock NBA colors until we've seen them on real ESPN footage.

**Rollback path:** Each phase commits are isolated. If Phase 3 goes sideways, revert the NBA assembly-path wire-up commit and NBA is back on its old chrome. `brand_configs.json` stays but is unused by NBA until re-wired. Same pattern for Phase 4.

---

## 9. Next action

Rob reads this doc, answers the open questions in section 6, and either approves the phase plan as-is or pushes back on specific phases. After approval, Phase 2 gets its own handoff doc written from this spec and dispatched to Cline. Until then, no code changes.

---

## 10. Rob decisions 2026-04-13

Section 6 questions answered in-thread. Locking the values here so Phase 2 has a concrete config to populate.

### 10.1 Brand hex colors — unified CWN palette across all three types

Rob picked Option C for both NBA (Q1) and Twitch (Q2): **CWN covering X** should look like CWN, not like X's own brand. The palette stays anchored on the News foundation.

**Reference — News (already live in `tools/clipzworld_newscast.html:75-80`):**
```css
--navy:  #22304b   (primary background family)
--gold:  #c7af4f   (accent — borders, highlights)
--gold2: #f0d060   (accent highlight variant)
--red:   #c0392b   (LIVE indicator)
--white: #ffffff
--dark:  #0d1424   (deep background)
```

**NBA (Q1 answer = C):**
- Primary: `#0d1424` (deep dark, matches News `--dark`)
- Accent: `#c7af4f` (gold, matches News `--gold`)
- LIVE indicator red, white, and dark navy background all carry over from News unchanged.

**Twitch (Q2 answer = C):**
- Primary: `#6A4C93` (muted purple — recognizable as "Twitch-adjacent" without being Twitch's official `#9146FF`)
- Accent: `#c7af4f` (gold, matches News)
- LIVE indicator red, white, and dark navy background all carry over from News unchanged.

**Why the gold stays constant:** gold is the CWN channel identity thread. News, NBA, and Twitch all share the same gold, same border strokes, same highlight dot. Primary color is the per-show differentiator. Viewer scanning the channel instantly recognizes "CWN show" via the gold, then identifies which CWN show via the primary (blue = news, dark = NBA, purple = Twitch).

### 10.2 Show names per top bar (Q5 answer — derived from docs, not a letter choice)

Discovered mid-handoff that CWN already has three distinct show names referenced in `CLINE_HANDOFF_AUTO_PUBLISH_THUMB_AND_COMMENT.md:28-30` and `:52-54` — these are baked into the pinned YouTube comment templates and have been live production values for multiple episodes. They're show titles, not a generic channel tagline.

**Top bar show titles (format: `"{SHOW NAME} | EPISODE N"`):**
- **News:** `"BECAUSE THE LIGHT WAS ON | EPISODE N"` (current, unchanged — already live)
- **NBA:** `"OTHER SIDE OF THE PILLOW | EPISODE N"` (new — replaces whatever NBA's current top bar shows, if anything)
- **Twitch:** `"TWITCH SOUP | EPISODE N"` (new — replaces whatever Twitch's current top bar shows, if anything)

**Override to section 3.3 and section 6 Q5:** Q5's original wording ("keep News tagline universal vs invent variants") was the wrong framing. The correct framing is "use the established show name per content type." Each show is its own program on the ClipzWorld News channel; the top bar title is the show title, not the channel identity. Channel identity = the gold accent + `CWN` logo on mug, both of which are already shared.

### 10.3 NBA segment tag label (Q3 answer = A)

**Flat `"NBA"` on the top bar segment tag pill across the entire episode.** Static, doesn't change per-game.

Rationale: NBA's TV card in the top-right already shows the active game matchup (Lakers @ Celtics, scores, records, PPG leaders). Putting the same matchup on the top bar segment tag pill is redundant chrome noise. Flat `"NBA"` lets the top bar stay stable and lets the TV card do the per-game differentiation.

### 10.4 Twitch sidebar content and the 2-clip gate (Q4 answer — reframed)

**Sidebar = streamer list for the current episode, one row per streamer, capped at 5.**

Rob clarified the Twitch model mid-thread, correcting two earlier misunderstandings:

**Misunderstanding A — the "7 clips per streamer" framing.** An earlier revision of this doc (and the first draft of the accompanying test #7 handoff) referenced a "7-clip Twitch model." That model never existed in code or production. Historical path: 3 clips per streamer (early) → 2 clips per streamer (current). Any language in earlier revisions suggesting 7 is a Claude Code mistake and should be treated as retracted.

**Misunderstanding B — "2 clips per streamer" as a configurable setting.** The `cwn_production.html:3078` dashboard input (`twitch-clips-per-main` defaulting to `2`) looked like a tunable setting. It's not — **2 is the minimum gate, not a target.**

**The gate rule (Rob 2026-04-13):** a streamer must have **at least 2 valid clips** resolvable via GQL to be included in an episode. Streamers with 0 or 1 usable clips are **dropped from the episode entirely** before HeyGen submission. The dashboard fetches up to 20 clips per streamer (`fetchCount = Math.max(clipsPerStreamer * 5, 20)` at `cwn_production.html:3102`) specifically to survive GQL's ~50% resolution failure rate and still hit the 2-clip floor. If the pool after resolution still has fewer than 2 valid clips, that streamer is cut.

**Why this matters for the sidebar:** the 5-cap in the sidebar is a cap on streamers *that passed the 2-clip gate*, not a cap on streamers the user selected. A user could select 10 streamers in the comma-separated field, have 7 pass the gate, and end up with 5 in the episode (and optionally 2 more in a second episode via the multi-episode split logic in section 11.4).

**Episode composition after the gate:**
- User selects N streamers via comma-separated input (up to 12 active in roster)
- GQL resolution filters to M streamers where each has ≥2 valid clips (M ≤ N)
- Episode cap of 5 applies: first 5 of M go into episode 1, remaining go into episode 2, etc.
- Each episode = exactly 5 streamers × exactly 2 clips = exactly 10 clips (deterministic)
- Sidebar shows those 5 streamers, one row each (displayName + avatar + optional category)

**Edge case — fewer than 5 streamers pass the gate.** If a user selects 3 streamers and all 3 pass, the episode has 3 streamers in the sidebar, not 5. The sidebar renders 3 rows, no empty slots. Not a failure mode, just a smaller episode.

**Edge case — 0 streamers pass the gate.** Hard fail at the pre-HeyGen stage. User sees an error in the dashboard telling them no selected streamers had 2 resolvable clips, try a different set or wait for the Twitch GQL layer to recover. No HeyGen tokens burned on a dead episode.

**News parallel:** the same gate concept applies to News. A story must have scraped og:image metadata (for the TV card) to pass the gate. Stories that fail og:image scraping are dropped. Optional extension: News stories must also have a scrape-able clip video to pass if Rob wants to force clip presence on every story — currently News allows avatar-only stories with missing clips. Decision point for a future handoff.

### 10.5 Episode counter reset (Q6 answer — deferred)

**Do NOT reset `data/episode_counters.json` now.** Current values stay: `{twitch: 38, nba: 27, news: 32}`.

**Reset trigger:** after BOTH News long-form AND NBA long-form pass smoke tests cleanly (Rob's definition of "locked"). At that point, reset to `{twitch: 0, nba: 0, news: 0}`, and the first successfully-produced-and-published episode for each content type after the reset becomes that type's Episode 1. This is a clean-slate marker, not a renumbering of past episodes.

**What this means for in-flight work:** smoke tests #8, #9, #10+ all continue using the current counter (news: 32 → 33 → 34 etc) because they're throwaway test runs, not production episodes. The reset happens at a specific moment Rob declares.

**Per-type counters stay — no global counter.** Each show has its own continuity arc.

---

## 11. Episode length targets (new, 2026-04-13)

Rob's strategic call during the Q4 discussion: **all CWN long-form episodes target the 8-15 minute YouTube mid-roll ad window.** This replaces the previous "fit all source material into one episode" assumption.

### 11.1 The target range

- **Lower bound: 8 minutes.** Below 8 min = video is too short for mid-roll ads, loses monetization potential.
- **Upper bound: 15 minutes.** Above 15 min = diminishing engagement returns, harder to hit retention metrics that drive YouTube recommendation.
- **Sweet spot:** 10-12 min.

Source: YouTube monetization guidance for long-form content — 8 min is the minimum video length that unlocks mid-roll ad insertion; 15 min is roughly where viewer retention starts dropping off steeply for non-tentpole content.

### 11.2 Enforcement at Gate 3

**New Gate 3 deduction rule:** videos with `ffprobeDuration < 480 seconds` (8 minutes) lose **10-15 points** from the full-video QA sample (the one that watches the entire assembled MP4 end-to-end, not the 20-second early/middle/late samples).

This is a soft incentive, not a hard fail. An 7:30 episode can still pass Gate 3 if it scores high enough on content quality; it just takes a penalty that pushes future episodes to hit the 8+ min target.

**No upper-bound Gate 3 deduction** — if a specific episode genuinely needs to run 17 minutes because the story arc demands it, that's fine. The target is a floor for monetization and a soft ceiling for retention, not a hard box.

### 11.3 Multi-episode splitting

When source material would exceed the target range in a single episode, split into multiple episodes at the natural boundary:

- **News:** 10 stories → 2 episodes of 5 (already the case as of smoke test #8)
- **NBA:** N games → episodes of 3-4 games each, targeting the 8-15 min window based on average per-game narration length
- **Twitch:** N streamers → episodes of 5 streamers each (2 clips per = 10 clips per episode)
- **NFL (August):** Same constraint. TBD on per-game word count and episode composition.

**This replaces the dynamic sidebar rotation feature** that was previously proposed as a Fix 5 sub-item. Static 5-cap + multi-episode splitting is a simpler architecture that solves the "more than 5 items doesn't fit the sidebar" problem at the episode boundary instead of trying to rotate within a single episode.

**BUT: Rob wants to still try to build dynamic rotation as a test #9 candidate.** If it works within the existing 0.75s transition timing budget from Fix 5's state machine, it ships and unlocks single-episode "10 story" News/NBA/Twitch runs. If it doesn't work, permanent fallback = multi-episode splitting. The rotation experiment is additive, not a replacement for the split logic.

### 11.4 Dashboard auto-split (new gap for test #9 handoff)

When the dashboard's story count / streamer count / game count input exceeds 5 for a given content type, the dashboard should automatically produce N separate jobs of 5 items each instead of one job of N items. Examples:

- User selects 10 News stories → dashboard fires 2 jobs: stories 1-5 as episode M, stories 6-10 as episode M+1
- User selects 8 Twitch streamers → dashboard fires 2 jobs: streamers 1-5 as episode K, streamers 6-8 as episode K+1 (3 streamers in the second episode is OK, just below the cap)
- User selects 4 NBA games → dashboard fires 1 job of 4 games (fits)

**This is a new gap for the test #9 handoff cycle** or whenever Rob decides to scope it. Added to `LONGFORM_FIX_ROTATION.md` → cross-cutting section.

---

## 12. What changes in this doc vs. earlier revisions

Before Rob's 2026-04-13 clarifications, earlier revisions of this doc (and the first draft of the accompanying handoff) referenced:

- **A "7-clip Twitch model" that never existed.** Claude Code misread the Twitch history — there was never a 7-clip-per-streamer production mode. Always 3 (early) → 2 (current). Any doc language suggesting 7 is a Claude Code error and should be treated as retracted.
- **"2 clips per streamer" as a configurable setting with a dashboard toggle.** Wrong — it's a **gate**, not a setting. Streamers with fewer than 2 valid clips after GQL resolution are dropped from the episode entirely. The dashboard input's default of 2 reflects the gate floor, not a tunable target. See section 10.4 for the full gate semantics.
- **"Universal tagline" vs "per-type variants" as the framing for Q5.** Wrong framing — the correct framing is "each content type is a distinct show with its own established show name, already baked into `CLINE_HANDOFF_AUTO_PUBLISH_THUMB_AND_COMMENT.md`." Show names are: News = "Because the Light Was On", NBA = "Other Side of the Pillow", Twitch = "Twitch Soup".
- **Dynamic sidebar rotation as the Fix 5 sub-item.** Now reframed: static 5-cap is the baseline, dynamic rotation is a "try to build it" experiment for test #9, multi-episode splitting is the permanent fallback if rotation can't hit the timing budget.

Sections 3.3, 3.4, 6 Q4, 6 Q5 in the body of this doc are superseded by sections 10 and 11. Don't re-interpret the earlier sections without reading the decisions here.
