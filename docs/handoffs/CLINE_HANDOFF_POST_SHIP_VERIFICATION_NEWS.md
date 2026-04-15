# CLINE_HANDOFF_POST_SHIP_VERIFICATION_NEWS.md

**Author:** Claude Code (dispatched 2026-04-12 late evening)
**For:** Cline (verification + small follow-up fixes)
**Scope:** News long-form — post-ship runtime verification + targeted small fixes after `CLINE_HANDOFF_NEWS_CLIP_SCRAPING.md` lands. Covers gaps #11, #14, #16 and conditional gap #7. **Wave 4-News — BLOCKED until News clip scraping (`CLINE_HANDOFF_NEWS_CLIP_SCRAPING.md`, Gap #1/2/3/4) has shipped AND Rob has run a successful News smoke test.**
**Ship order:** Each verified gap is its own commit. Do NOT bundle — some verifications may reveal new work that should be tracked separately.
**Before any commit:** Re-read `COMMIT_CHECKLIST.md`. Atomic staging. STATUS.md update. LONGFORM_FIX_ROTATION.md update per gap.

---

## Dependency gate

**MUST wait for News clip scraping to ship AND be verified on a live smoke test** before starting any of the tasks in this handoff. Most of these tasks depend on a successful News run existing to inspect.

**Gate check before starting:**
```bash
# News scraping shipped
grep -n "scrapeArticleVideo\|news.*clip.*scrape" server.js
# Should return hits in the News analysis block

# Find the most recent News long-form MP4
ls -t output/news_*_avatar_*_clips_*.mp4 2>/dev/null | head -1
# Should contain {N}_clips with N >= 1, NOT 0_clips

# Ask Rob: did the smoke test pass visually? (TV card visible, clips play, no obvious regressions)
```

If the smoke test hasn't run or is still producing `0_clips` files, stop. Wait for Wave 1-News to actually work end-to-end.

---

## Task 1 — Gap #11: Gate 3 TV card check wording ambiguity for News

### Context

`server.js:~1541 geminiQACheck()` adds a Gate 3 checklist item asking Gemini to verify "a TV-shaped overlay card with a gold border visible in the top-right area of the frame." Before Fix 8B, News had NO top-right TV card — Gemini's vision model was seeing the right-side sidebar story list (which has gold borders via `border-left: 4px solid var(--gold)`) and calling it the TV card, producing a false PASS on smoke test #4.

After Fix 8B shipped (commit `9b78580`), News actually has a real top-right TV card at `OVERLAY_ZONE` ({x:1360, y:60, w:520, h:293}) populated with the Al Jazeera article's og:image. **Now the check could be legitimately accurate** — but the ambiguity between "sidebar with gold borders" and "TV card with gold border" is still in the prompt wording.

### Task

Run a post-ship News smoke test (verify dependency gate first), capture the Gate 3 why-doc at `output/qa_failures/gate3_assembly_pass_*.txt`, read the EARLY sample's TV CARD check result. Three possible outcomes:

**Outcome A — Gemini passes the check and describes the top-right TV card correctly** (e.g., "TV-shaped card with gold border in top-right containing news headline and image"). **No action needed.** The ambiguity is resolved by the fact that there's now a real TV card matching the description. Mark Gap #11 as resolved in LONGFORM_FIX_ROTATION.md.

**Outcome B — Gemini passes but describes the sidebar story list instead of the TV card** (e.g., "gold-bordered news headlines visible on the right side of the frame"). **The check is still ambiguous.** Small fix: tighten the Fix 3 prompt at `server.js:1541+` to explicitly describe the TV card's distinguishing features that the sidebar doesn't have — namely, the article's hero image inside the card. Update the check wording to something like:

```
7. TV CARD: Is there a rectangular card in the top-right area of the frame
containing BOTH a news article photo/image AND a headline text overlay?
(yes = real TV card with photo + headline, no = no card visible or only text
headlines in a sidebar without a photo, not_applicable = this sample is during
a source clip with no chrome overlay visible)
```

The photo-AND-headline requirement distinguishes the TV card (has photo) from the sidebar (text only).

**Outcome C — Gemini fails the check** (reports "no TV card visible" even though Fix 8B rendered one). **Real bug.** Either the card isn't actually rendering in the final MP4 (unlikely — Fix 7 + Fix 8B both shipped visual-verified), or Gemini's vision model is failing to detect it for a specific reason (too small, wrong contrast, wrong position). Investigate by:
1. Opening the MP4 in QuickTime and eyeballing the top-right during STORY1_INTRO
2. Extracting a frame with `ffmpeg -ss 15 -i <mp4> -frames:v 1 /tmp/verify.jpg` and examining
3. Running the Gate 3 prompt manually against the frame via Gemini API to see what Gemini "sees"

Report findings back and decide on a fix path from there.

### Action if fix needed (Outcome B)

Small edit to `server.js` Gate 3 prompt wording. Single commit. Grep check:
```bash
grep -n "TV CARD.*top-right\|TV-shaped overlay card" server.js
```

Should have a hit in the updated Gate 3 prompt block.

### Commit message template (if Outcome B requires a fix)

```
fix(gate3): disambiguate News TV card check from sidebar story list (Gap #11)

Gemini was passing Gate 3's TV CARD check by identifying the Fix 7 newscast
chrome sidebar (gold border-left on each story item) as a "TV-shaped overlay
card." After Fix 8B shipped a real top-right TV card with an article hero
image, the wording is updated to require photo + headline together to
distinguish the TV card from the sidebar.

Changes:
- server.js:~1541 — Gate 3 TV CARD check wording tightened to require photo + headline

References: LONGFORM_FIX_ROTATION.md News Wave 4, gap audit Gap #11
```

---

## Task 2 — Gap #14: News pinned comment verification

### Context

`server.js:5163 PINNED_COMMENT_TEMPLATES.news = "What was your favorite news story? Let me know below! 👇 If you enjoyed this, consider subscribing for more Because the Light Was On episodes. www.youtube.com/@clipzworldnews?sub_confirmation=1"`

Per POST_PUBLISH_TASKS.md §1.3, Rob reported the pinned comment MAY not be reaching YouTube Studio despite the publish call returning `request_id` success. This needs runtime verification on a published News video.

### Task

After a News smoke test successfully publishes to YouTube (Upload-Post returns `request_id`), Rob checks YouTube Studio and verifies:

1. **Thumbnail** — is the custom thumbnail visible on the video card in YouTube Studio (not just the default frame grab)?
2. **Pinned comment** — open the video, scroll to comments, is the template "What was your favorite news story?..." comment present and pinned?
3. **Description chapters** — check the video description, are chapters (`0:00 Intro`, `0:30 STORY1_INTRO`, etc.) listed in the description?

### Findings routing

- **All three present:** mark gaps #14 (pinned comment) and #16 (thumbnail) as verified in LONGFORM_FIX_ROTATION.md. No code change.
- **Thumbnail missing:** runtime issue — check the `/assemble` log for `🖼 Thumbnail uploaded to Drive` and `thumbnailUrl` being forwarded in the `/publish` call. If log shows the thumbnail was sent but YouTube Studio doesn't show it, Upload-Post may be dropping the field silently. Escalate to Upload-Post support or check their API docs.
- **Pinned comment missing:** check assembly log for `💬 Pinned comment: ...`. If present, Upload-Post is dropping `first_comment`. If absent, `PINNED_COMMENT_TEMPLATES[baseContentType]` lookup failed — probably a `baseContentType` mismatch. Fix: grep for `baseContentType` at `server.js:~4873` and verify the `content_type` value being passed matches the map keys.
- **Chapters missing:** check assembly log for `📑 Chapters built (N markers)`. If absent, `req.body.segments` was empty when `buildYouTubeChapters()` ran. Fix: verify `segments` is being passed through from the dashboard `/publish` call.

### Action scope

Either zero code changes (if everything lands correctly) or one targeted fix based on which log line is missing. Each fix is its own commit.

---

## Task 3 — Gap #16: News thumbnail generation post-canvas-rewrite verification

### Context

Aider overnight commit `ded2afb` replaced Puppeteer with node-canvas for News/NBA thumbnail generation to fix a 500 error on `/generate-thumbnail`. MORNING_BRIEFING.md lists "manually test POST /generate-thumbnail with contentType: 'news' and 'nba' to confirm thumbnails are generated correctly" as a pending verification.

### Task

Test the endpoint directly:

```bash
curl -X POST http://localhost:3000/generate-thumbnail \
  -H "Content-Type: application/json" \
  -d '{
    "contentType": "news",
    "items": [
      {"title": "Test Story", "source": "Al Jazeera"}
    ]
  }' -o /tmp/test_news_thumb.json
cat /tmp/test_news_thumb.json
```

Expected: `{ok: true, path: "...", ...}` with no 500 error. The `path` field should point to a PNG in `output/` or `tmp/`. Open that PNG in Preview and verify:

1. Correct dimensions (1280×720 for long-form thumbnail or whatever the spec is)
2. "CLIPZWORLD NEWS - EPISODE N" branding visible per QA checklist in `qa/record_session.js:207`
3. No 500 error, no blank/white image, no rendering artifacts

### Findings routing

- **PNG renders correctly:** mark Gap #16 as verified in LONGFORM_FIX_ROTATION.md. No code change.
- **PNG is blank or malformed:** the canvas rewrite has a bug. Read the new canvas-based thumbnail function (probably at `server.js:~10280` based on earlier greps) and compare against the Puppeteer-based version in git history. Identify the missing step (background fill, text positioning, image loading) and fix.
- **Endpoint still returns 500:** Aider's fix didn't fully land. Check server.js syntax + exports, restart nodemon, re-test.

### Action scope

Zero code if thumbnail renders clean, OR one targeted canvas fix if broken.

---

## Task 4 — Conditional Gap #7: News `[CLIP PLAYS HERE]` prompt cleanup

### Context

Post-Fix 6, the News Gemini prompt at `server.js:6893-6942` still writes `[CLIP PLAYS HERE]` markers between SETUP and SUMMARY scenes. Assuming Wave 1-News (clip scraping) works, those markers now correspond to real playable clips and the prompt stays as-is. **BUT:** if Wave 1-News fails or is indefinitely deferred, the markers reference clips that don't exist, and the prompt should be rewritten to stop mentioning clips in SETUP/SUMMARY language.

### Task — DECISION BRANCH

**Run this ONLY IF Rob decides (after seeing Wave 1-News smoke test results) that News will NOT have video clips.** If clips work, skip this task entirely.

If decision = "News stays clipless":

1. Update the News Gemini prompt to remove `[CLIP PLAYS HERE]` marker requirement and rewrite SUMMARY semantics. SUMMARY was described in Fix 6 as "factual recap of what just played in the clip" — if there's no clip, SUMMARY needs a new job. Options:
   - **Option 1:** Delete SUMMARY entirely, revert to INTRO → SETUP → REACTION (3 scenes per story, scene count math becomes `1 + items*3 + 1`)
   - **Option 2:** Keep SUMMARY but rewrite as "factual deeper context about the story — a second beat that develops the headline" (non-clip-based recap). Scene count stays at 4.
2. Update Gate 1 expected clips math in `claudeScriptQA()` at `server.js:2259` — change `expectedClips = clipAnalyses.length` to `expectedClips = 0` for News content type.
3. Update the News prompt validation checklist to require ZERO `[CLIP PLAYS HERE]` markers instead of `items.length`.
4. Verify Gate 1 scores the clipless script cleanly.

### Commit message template (if this task runs)

```
fix(news): remove [CLIP PLAYS HERE] markers from News prompt (News clipless design)

Wave 1-News clip scraping was {deferred|abandoned|not-viable}. Rob decided
News long-form ships without mid-story video clips. This commit updates the
News Gemini prompt to match that design reality.

Changes:
- server.js:~6893 — News prompt: remove [CLIP PLAYS HERE] requirement, rewrite SUMMARY
- server.js:~2259 — Gate 1 expectedClips for News: items.length → 0
- server.js:~6940 — Validation checklist: ZERO [CLIP PLAYS HERE] markers required

{Option 1 or Option 2 description}

References: LONGFORM_FIX_ROTATION.md News Wave 4, gap audit Gap #7
```

### Skip this task if clips work

If Wave 1-News produces a successful News run with real clips flowing through, DO NOT run this task. Fix 6's current prompt is correct in that world. Mark Gap #7 as "resolved — clips working, no prompt change needed" in the rotation doc.

---

## Rotation doc updates after each task

For each task that completes (with or without a code change), update `LONGFORM_FIX_ROTATION.md`:

1. Move the Gap from `📤 Dispatched to Cline` → `✅ Shipped` (if code shipped) OR add to a `Verified` subsection (if verification only, no code)
2. Add a rotation log entry with date + outcome
3. Note any new findings that surface follow-up work (e.g., "Gap #14 verified except thumbnail missing — opened follow-up Gap #X")

---

## Checklist for Cline

Per task:

- [ ] Dependency gate verified (News clip scraping shipped + smoke test passed)
- [ ] Task 1 (Gate 3 TV card wording) outcome identified + action taken if needed
- [ ] Task 2 (pinned comment + thumbnail + chapters) verified on YouTube Studio
- [ ] Task 3 (thumbnail generation curl test) run against live endpoint
- [ ] Task 4 (clipless prompt cleanup) run ONLY if Rob decides News stays clipless
- [ ] Each code-change task committed separately with dedicated commit message
- [ ] STATUS.md updated per commit
- [ ] LONGFORM_FIX_ROTATION.md updated with verification outcomes
