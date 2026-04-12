# Post-Publish & Polish Tasks

**Purpose:** Tracked list of everything that needs attention after the 6-case validation suite passes. Items discovered during Rob's Twitch long-form review on 2026-04-11 (the "best ever" run) plus architectural decisions from the research marathon that night.

**Last updated:** 2026-04-12

---

## Priority 1 — Fix before next production run

### 1.1 White strip at top of video frame
**Status:** Undiagnosed — needs ffprobe evidence
**Symptom:** Thin bright/white horizontal band at the very top of the assembled MP4. Visible in Rob's review of the 12-streamer Twitch long-form compilation.
**Likely cause:** HeyGen avatar segments may render with baked-in letterbox bars (native 4K scaled to 1920×1080 with sub-pixel rounding artifacts). OR FFmpeg concat is adding padding when mixing avatar + source clip frames with different pixel aspect ratios.
**Diagnostic:** Run `ffprobe -show_streams tmp/{latest_heygen_segment}.mp4` to check actual dimensions of a raw HeyGen segment. If NOT exactly 1920×1080, that's the source.
**Fix path:** If HeyGen source issue → crop avatar segments during assembly (same approach as commit `45f8980` for source clips). If FFmpeg issue → add explicit `setsar=1:1` to concat filter chain.

### 1.2 Ticker gap (white strip above ticker)
**Status:** Partial fix shipped — CONFIG.TICKER.HEIGHT reverted to 64 in tonight's commit. Watch next run to confirm gap is gone.
**Root cause:** Cline bumped config to 72 but ticker HTML (`tools/cwn_twitch_ticker.html`) still renders at 64px height. Capture at 72 produced 8px transparent padding. Reverting to 64 aligns capture + HTML.
**Long-term task:** If we want a taller ticker (80px+), redesign the ticker HTML internals (font sizes, avatar sizes, padding) to fill the new height. Not a config change — a CSS redesign across 3-4 HTML files.

### 1.3 Auto-publish: thumbnail + pinned comment + chapters not landing on YouTube
**Status:** Code shipped (`60af887`), publish call succeeded (Upload-Post `request_id` returned), but Rob reports no thumbnail and no pinned comment on the YouTube private draft.
**Diagnostic needed (next run):** Watch nodemon terminal for these specific log lines during Gate 6:
- `🖼 Thumbnail uploaded to Drive: https://...` — if absent, thumbnail extraction or Drive upload failed silently
- `💬 Pinned comment: What was your favorite streamer clip?...` — if absent, `PINNED_COMMENT_TEMPLATES` lookup failed (probably `contentType` mismatch)
- `📑 Chapters built (N markers)` — if absent, `req.body.segments` was empty when `buildYouTubeChapters()` ran
- `📋 Description length: XXX chars (includes chapters)` — if absent, chapters weren't appended
**Action:** If log lines ARE present but YouTube still shows nothing → Upload-Post is silently dropping `thumbnail_url` and `first_comment`. Escalate to Upload-Post support or check their API docs for required field formats.

---

## Priority 2 — Scene delivery craft (ongoing improvement area)

### 2.1 Reaction → CTA run-together
**Symptom:** After Bobby G's second clip reaction, the "Follow [streamer]. Link in description." line runs into the reaction with no breathing room. Even with SSML `<break time="1000ms"/>`, the lines feel continuous because they're one HeyGen render with one gesture envelope.
**Fix:** Split `CLIP2_REACTION` into two separate scenes:
```
=== JASON_CLIP2_REACTION ===
Well, that's one way to end a stream.
[beat]

=== JASON_FOLLOW_CTA ===
Follow Jason. Link in description.
[beat]
```
**Scope:** Touches Gemini prompt, Gate 1 scene count validation, `parseSegments_v2` header recognition, scene count math. ~2 hours of coordinated work.
**Test:** 1 streamer × 1 clip run after shipping, verify reaction and CTA land as separate spoken deliveries with a natural concat boundary between them.
**Decision:** Rob approved Option 1 (split scenes) for tomorrow.

### 2.2 Outro head-floating / abrupt clip end
**Symptom:** At "Appreciate you!" Bobby G's head drifts upward as the last word lands, then the video hard-cuts to end. No hold, no fade.
**Fix (short-term):** FFmpeg freeze-hold on the last 0.5–1.0 seconds of the outro segment before assembly finalizes. Rob approved this for tomorrow.
**Fix (long-term):** Signature sign-off clip (see 3.1 below).

### 2.3 Phonetic parenthetical glitch (Yonna, Adapt, Lacy)
**Symptom:** Bobby G says "Yonna" then immediately repeats "YAWN-uh" — reading both the canonical name and the parenthetical phonetic hint aloud. Happens for any streamer with a `phonetic` field in `streamers.json`.
**Affected:** Yonna (phonetic: "Yawn-uh"), Adapt (phonetic: "AD-apt"), Lacy (phonetic: "LAY-see").
**Important:** Hasan was finally pronounced correctly WITH the phonetic system. Don't strip the system entirely.
**Next step:** Send the specific Yonna scene to Gemini and ask WHY the phonetic is being written inline instead of just influencing pronunciation. May be a prompt wording issue, not a code issue.
**Future fix paths:**
- Fix B: Strip parenthetical phonetics in `cleanAvatarText` before HeyGen (keeps canonical name, loses phonetic guidance)
- Fix C: SSML `<sub alias="Yawn-uh">Yonna</sub>` tag (best architectural answer, needs HeyGen SSML `<sub>` support probe)
- Fix D: Remove phonetic-hint rule from Gemini prompt entirely (loses the feature)

### 2.4 Bobby G micro-glitch at segment boundaries
**Symptom:** Subtle shoulder/hand position change at scene transitions — visible as a "tick" when FFmpeg concats back-to-back HeyGen segments.
**Root cause:** Each HeyGen render starts from the avatar's neutral pose. No pose continuity API exists (confirmed — see `HEYGEN_OPTIONS_INVENTORY.md` Tier 4 ceiling).
**Mitigations:**
- Short FFmpeg crossfade between adjacent avatar segments (0.15–0.3s dissolve)
- Frame-freeze hold at segment ends (same technique as 2.2)
- Per-scene emotion parameter (if it indirectly reduces idle gesture variation)
- Avatar 5 migration (when API access is available, ~1-2 months per HeyGen support)

---

## Priority 3 — Production polish

### 3.1 Signature outro sign-off move
**Vision:** Bobby G has a recurring sign-off motion (wave, nod, point at camera) that becomes a brand identifier.
**Paths (ranked):**
- Path B: Longer SSML `<break>` + intentional script shape at outro → cheapest, uses existing tools
- Path C: Curated library of 3-5 pre-rendered 1-2s sign-off clips in `assets/bobby_g_signatures/`. Assembly picks one at random → zero HeyGen cost per run
- Path A: HeyGen Photo Avatar Motion API (`/v2/photo_avatar/add_motion`) → most control, requires architectural migration to photo avatar. NOT available for studio avatars.
**Status:** Post-12-test investigation. No work until all 6 test cases pass.

### 3.2 Intro card duration — shipped as 10s
**Status:** Shipped in tonight's commit (config-driven, `CONFIG.INTRO_CARD.DURATION_SECONDS = 10`). Rob timed it against the video and approved. Card stays visible through intro + first clip. Acceptable even if Bobby G's first clip starts while card is still up.
**Future tuning:** If 10s feels wrong on NBA or News content types (shorter/longer intros), can make duration per-content-type.

### 3.3 Style library teaching workflow (Gemini reference videos)
**Endpoint:** `POST /analyze-style-library` (`server.js:7175`)
**Dashboard:** Settings page → "TEACH GEMINI" button
**Process:** Rob compiles ~10 YouTube URLs of reference reaction/commentary videos. Dashboard sends to server, server uses `yt-dlp` to download (first 32MB), uploads to Gemini, Gemini watches 10×, extracts style fingerprint, saves to `data/cwn_style_guides.json`.
**Probe first:** Before building the 10-URL list, test with ONE URL to confirm the endpoint still works end-to-end. Watch nodemon for `[style-library] ✓ Viewing 1/10 complete` through 10/10.
**URL selection guidance:**
- Short clips (≤3 min) so Gemini sees full content within 32MB cap
- Flat deadpan reactions (Norm MacDonald, Dave Attell, Anthony Jeselnik style)
- Clean setup → clip → reaction → next structure
- Avoid hype/yelling, long podcasts, music overlays

---

## Priority 4 — Architecture & pipeline

### 4.1 Short-form fan-out architecture (Gate 5 → 3× Gate 6)
**Status:** Not yet built. Short-form hasn't been tested end-to-end.
**What:** After Gate 5 passes on a short-form video, the pipeline branches into 3 parallel Gate 6 delivery jobs:
- Gate 6a: Upload-Post → TikTok (`privacy_level: 'SELF_ONLY'`)
- Gate 6b: Upload-Post → Instagram (`media_type: 'REELS'`)
- Gate 6c: Upload-Post → YouTube Shorts (`privacyStatus: 'private'`)
**Dashboard UX:** One card per short-form job with platform checkboxes. Single progress indicator for Gates 1-5, then three parallel indicators for fan-out deliveries.
**Job persistence:** Per-platform publish status on the job card so Gate 7 can track "approved on TikTok, pending IG, rejected YT."
**Scope:** ~1-2 days of work touching dashboard UI, server.js Gate 6 branching, job card schema, status polling, metrics tracking.

### 4.2 Short-form clip window stays 24h (intentional)
**Decision (Rob, 2026-04-12):** Short-form stays 24h for freshness ("this just happened" editorial). Long-form moved to 48h (every-other-day production schedule avoids duplicates). Both formats can share clips — same clip in a long-form AND a short-form is fine.
**Code locations:** `cwn_production.html:4395, 4644` — these already use 24h and should NOT be changed.

### 4.3 Test suite restructure (12 → 6)
**Current:** `test/test_suite_12cases.json` has 12 cases (6 long + 6 short), runner stops at Gate 6.
**New:** 6 runs total — 3 long-form (Twitch/NBA/News) + 3 short-form (Twitch/NBA/News), each going all the way through Upload-Post to platform private drafts. Rob reviews on each social media account.
**Action:** Rewrite `test_suite_12cases.json` after NBA long-form test reveals any additional adjustments needed. Runner may need to push through to Upload-Post or be deprecated in favor of dashboard-driven production runs.

### 4.4 Gate-by-gate self-healing upgrade status

| Gate | Current state | Target (per GATED_PIPELINE_ARCHITECTURE.md) | Gap |
|---|---|---|---|
| **Gate 1** — Script QA | Claude reviews, retry loop with Gemini re-gen, claudeScriptFix for clip-match-only failures | Specific failure diagnostics, strategy-based fix proposals, no arbitrary retry limits | Partially done — `f8395b7` fixed source-of-truth. Still uses MAX_RETRIES=3 instead of strategy exhaustion. |
| **Gate 2** — Segment Structure | parseSegments_v2 + 6-check pure-code validator (shipped `a1439b6`) | Add Gemini as judge for ambiguous cases | Mostly done — pure-code path works. Gemini fallback not wired yet. |
| **Gate 3** — HeyGen Render QA | Gemini samples first/middle/last, scores lip sync/audio | Re-render affected segments as fix strategy, phonetic enhancement retry | Partially done — QA runs, but no automated fix path (just pass/fail). |
| **Gate 4** — Assembly QA | Gemini reviews assembled MP4 (existing Gate 3 in current code) | Frame-level analysis at segment boundaries, pillarbox detection, overlay verification | Basic — current "Gate 3 QA" check is really Gate 4 per the architecture. Rename + expand checks. |
| **Gate 5** — Full Video QA | Does not exist as separate gate | Chunked upload, full-video audio/visual/pacing review, broadcast-readiness judgment | Not started |
| **Gate 6** — Publish Delivery | Drive upload + Upload-Post call, basic success check | Retry with backoff, platform-specific error handling, per-platform status tracking | Partially done — auto-publish works but no retry logic, no per-platform tracking for short-form fan-out |
| **Gate 7** — Rob Reviews | Manual (Rob reviews on social platforms) | Dashboard shows per-platform status with Approve/Reject/Delete buttons | Approve/Reject buttons exist (`cwn_production.html:2145`) but don't feed back to the pipeline state machine cleanly |

### 4.5 Per-scene emotion parameter (future HeyGen experiment)
**Status:** Parked. Bobby G works well with SSML alone after tonight's fixes.
**When to revisit:** After 6-case validation suite is green. Then write `scripts/probe_heygen_emotions.js` to test which emotion values and field locations HeyGen accepts.
**Architecture C plan:** Scene-type → emotion mapping (COLD_OPEN → serious, CLIP_SETUP → neutral, etc.). Needs the probe results before spec'ing.
**Where to experiment:** HeyGen web UI ("Build with AI" or avatar editor), which may let Rob explore Bobby G's emotional range without code changes. The API is not available for Avatar V yet (~1-2 months per HeyGen support).

### 4.6 Avatar 5 migration
**Status:** Parked. Avatar V API access not available for ~1-2 months (Rob confirmed with HeyGen support).
**When available:** Side-by-side comparison render: current landscape 4K avatar vs Avatar 5, same script, same SSML, same speed. Pick the winner.
**What to test:** micro-expression quality, idle gesture range, lip-sync accuracy, emotional delivery with `emotion` parameter, matting/transparent background support.

---

## Post-publish manual work (permanently manual per Upload-Post API limits)

These items require manual work in YouTube Studio / TikTok / Instagram after every auto-publish. They cannot be automated with current Upload-Post API capabilities.

| Item | Where | How |
|---|---|---|
| **YouTube cards** | YouTube Studio → Video details → Cards | Add cards manually pointing to previous episodes, merch, etc. |
| **YouTube end screens** | YouTube Studio → Video details → End screen | Add subscribe button + next video recommendation (last 5-20 seconds) |
| **YouTube privacy flip** | YouTube Studio → Video details → Visibility | Change from Private → Public when approved |
| **TikTok privacy flip** | TikTok → Profile → Drafts | Change from "Only me" → Public |
| **Instagram privacy flip** | Instagram → Profile → Reels drafts | Publish the draft reel |
| **YouTube description edits** | YouTube Studio → Description | Add chapters manually if auto-chapters didn't land, adjust links, add sponsors |
| **YouTube video editor** | YouTube Studio → Editor | Trim, blur, or adjust if needed |

**Rob's framing:** *"YouTube would be the most because you can even edit the video if you want, so everything is nice-to-have vs changing status to publish."* Post-publish manual work at the social platform is a permanent part of the workflow. The pipeline's job ends at Gate 6 (successful private delivery). Gate 7 is Rob's domain.

---

## Related existing tasks (from task tracker)

- **Task #8** — Streamer dropdown UX (multi-select UI, replaces textarea)
- **Task #15** — `/assemble status='done'` race condition
- **Task #18** — Stage 3.5 Topaz ring removal
- **Task #21** — Scheduled content generation from dashboard
- **Task #22** — Drawtext ticker replacement (long-term ticker fix)
- **Post-12-A** — Dashboard metrics panel (blocked until 12-test-suite completes)

---

*This doc supersedes ad-hoc TODO lists and in-conversation task tracking for post-pipeline polish work. Update it as items are shipped or new items surface. Keep it under 1 page of priorities — if the list grows beyond 20 items, prune completed items to a "Shipped" section at the bottom.*
