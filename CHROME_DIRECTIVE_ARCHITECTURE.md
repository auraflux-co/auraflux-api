# CHROME_DIRECTIVE_ARCHITECTURE.md

**Author:** Claude Code, drafted 2026-04-13 evening from Rob's "proactive vs reactive execution" design session
**Status:** Parked architecture design doc — not a handoff, not a Cline work item, no code changes
**Companion docs:**
- `CLINE_HANDOFF_NEWS_SMOKE_TEST_10_FIXES.md` — the emergency Tier 1 fix (Track A) that unblocks test #10 under the CURRENT reactive architecture
- `SHARED_NEWSCAST_SET_MIGRATION.md` — the shared chrome template across Twitch/NBA/News
- `PHASE_2_BUILD_SPEC.md` — Phase 2 build plan
- `AUTONOMOUS_PRODUCTION_ROADMAP.md` — 5-phase strategic roadmap

**When to build this:** NOT now. Phase 1 smoke test loop continues on the reactive state-machine architecture. This doc captures WHAT to build WHEN Rob says "it's time" — which could be anywhere from late Phase 1 to early Phase 2 depending on how much pain the reactive architecture causes first.

---

## 1. The problem statement

### 1.1 Current architecture — reactive / in-the-moment

The CWN pipeline today has a **reactive chrome state machine**:

```
Gemini writes plain-text script with scene headers
  ↓
FFmpeg concat assembles avatar segments + source clips in order
  ↓
Chrome state machine (Fix 5/7 at server.js:3876-3925) tries to
figure out mid-assembly "what chrome should be on screen right now"
by string-matching scene labels:

  if (sceneLabel.includes('STORY') && sceneLabel.includes('INTRO')) {
    showFlag = true;
    showTVCard = true;
    hideSidebar = true;
  } else if (sceneLabel.includes('SETUP') || sceneLabel.includes('SUMMARY') || sceneLabel.includes('REACTION')) {
    showFlag = true;
    showTVCard = false;
    hideSidebar = false;
  } else if (sceneLabel.includes('source_clip')) {
    showFlag = false;
    showTVCard = false;
    hideSidebar = true;
  }
  ↓
Per-scene PNG generated and burned as FFmpeg overlay
```

**Where this breaks:**

1. **String matching is fragile.** If Gemini writes `STORY1_SETUP_` instead of `STORY1_SETUP`, the `.includes('SETUP')` catches it but the order-of-checks matters. Add a new scene type and the cascading `else if` chain quietly breaks old scenes.

2. **Chrome timing is locked to scene boundaries.** A scene with a 120-second source clip stays in "chrome hidden" state for the full 120 seconds. Can't mid-scene update the flag text, can't mid-scene swap the TV card image, can't mid-scene show a graphic for 5 seconds and hide it again.

3. **Gemini has no idea chrome exists.** Gemini writes the script blind. It doesn't know what the flag says, what the TV card shows, what the sidebar lists. If the story has a nuance that should be reflected on-screen ("this is the FIRST story about Iran today" → badge on flag), Gemini can't express it because it has no output channel for that kind of signal.

4. **Adding a new chrome element is code-deep.** If you want to introduce a callout box or a weather strip or a breaking-news alert banner, you edit FFmpeg filter graph code in server.js + add conditions to the state machine + update tests. Every chrome element becomes an engineering project.

5. **Debugging is inference-based.** "Why did the flag show the wrong story name at 02:15?" requires stepping through FFmpeg filter graph generation, reproducing the concat order mentally, and guessing which branch of the state machine fired. No ground-truth record of what chrome SHOULD have been on screen.

### 1.2 Rob's proposed architecture — proactive / ahead-of-time

Rob's words 2026-04-13 PM:

> "are the story cards, tv cards, top left flag, cutting to clips all of these need to be lined out somehow for our script in terms of when one fires or not, basically what are the movable items on the set visual doing during the whole episode and just repeat pattern based on the script that gemini creates, each individual scene by gemini needs to have and what movable elements or what design elements are doing what for each of these scenes and either tag something that only means something to our script or another way so when scenes are being compiled early with gemini thats where it happens so that when it comes to post ffmpeg everything lines up and then have it where when the script either is doing the telling of what i just stated or it has to wait but its getting the info from initial stage to be ready — proactive vs in the moment reactive execution"

**Decoded:** shift the chrome decisions from assembly-time (reactive state machine) to script-generation-time (Gemini output). Gemini writes a structured script that includes per-scene chrome directives — exactly what every movable element should be doing during that scene. Assembly just reads the directives and executes them literally.

**The pattern:**

```
Gemini writes STRUCTURED script with chrome directives embedded per scene
  ↓
Script output contains, for every scene:
  - scene type (avatar / source_clip)
  - spoken text (for avatar scenes)
  - clip URL (for source_clip scenes)
  - chrome.flag.{visible, text, source}
  - chrome.tvCard.{visible, imageUrl, durationSec}
  - chrome.sidebar.{visible, activeIndex, items}
  - chrome.ticker {always}
  - chrome.logo {always}
  - any new chrome elements that get added later
  ↓
Assembly pipeline reads directives directly — no state machine, no
string matching, no inference. Just: "Gemini said flag.visible=true
with text='TRUMP POPE FEUD', do that."
  ↓
Chrome overlay PNG generated from the directive, burned as before
  ↓
If directives change mid-scene (flag text updates halfway through a
long clip), the chrome layer supports time-indexed directives too
(future extension)
```

### 1.3 Why proactive is better

**1. Gemini knows the content better than the assembly code does.**

The assembly code only sees scene filenames like `asm_1776114779533_3_story1_clip.ts`. It has no idea story 1 is about Trump and Iran. It has to look up story metadata in a separate `orderedClipUrls` array and string-match. Gemini, by contrast, is the one that WROTE "Story 1: Trump threatens blockade of Hormuz" — it knows the story's subject, tone, urgency, and narrative arc firsthand.

Making Gemini responsible for chrome content is cleaner because Gemini has the information FIRST and doesn't have to serialize it through a fragile string-matching layer.

**2. Chrome becomes data, not logic.**

Instead of:

```javascript
// Reactive state machine (current)
if (sceneType === 'STORY_INTRO' && burnIndex < introDur) {
  overlay.showFlag = true;
  overlay.flagText = storyList[activeStoryIdx].title;
  overlay.hideSidebar = true;
  overlay.tvCardImage = storyList[activeStoryIdx].ogImage;
} else if (sceneType === 'STORY_SETUP' || ...) {
  // ...
}
```

You have:

```javascript
// Proactive directive consumption (target)
const chrome = scene.chromeDirectives;
generateChromeOverlay(chrome);
```

Every chrome element is a field on an object. Adding a new element is `scene.chromeDirectives.newThing = {...}` in Gemini's prompt template. No branches, no cascading conditionals, no "which scene type does this apply to" questions — Gemini decides per-scene.

**3. Debugging becomes grep-able.**

"Why was the flag showing 'TRUMP HORMUZ' at 02:15?"

Reactive debug path: step through FFmpeg filter graph code, mentally replay the concat order, identify which state machine branch fired, reverse-engineer why the state machine thought it was in the "Hormuz" scene at that moment.

Proactive debug path: `grep -A 5 'flag' script.json | grep -B 2 'TRUMP HORMUZ'`. Read the directive. Done.

**4. Gemini gets a first-class output channel for story metadata.**

Right now, if Gemini wants to convey "this story is urgent / breaking / emotional / boring", it has no way to signal that. The script is pure narration text. Gemini could embed hints in the text but the assembly code won't read them.

With directives, Gemini can say:

```yaml
- id: STORY1_INTRO
  chrome:
    flag:
      visible: true
      text: "IRAN TENSIONS ESCALATE"
      urgencyBadge: "BREAKING"  # only shown when urgent
      urgencyColor: "#c0392b"
```

The assembly code doesn't care what "urgencyBadge" means — it just renders what Gemini told it to render. Adding new directive fields is free.

**5. Catches the Rob meta-insight about signaling.**

Rob's words: *"we need to huddle up again on this review the code and figure out how to make the signals or prompts easier for the code to know when to switch elements on the frame."*

The signals ARE the directives. Gemini writes the signals, assembly reads them. No inference gap.

---

## 2. What this enables

### 2.1 Mid-scene chrome state changes (future)

Directives can be time-indexed within a scene:

```yaml
- id: STORY1_CLIP  # source_clip scene, 25 seconds long
  type: source_clip
  clipUrl: "..."
  duration: 25
  chromeTimeline:
    - at: 0
      flag: {visible: false}
      sidebar: {visible: false}
    - at: 20  # 5 seconds before clip ends
      flag: {visible: true, text: "STORY 2 NEXT"}  # teaser for next story
      sidebar: {visible: true, activeIndex: 1}
```

During the first 20 seconds of the clip, chrome is hidden. During the last 5 seconds, the flag appears with a teaser for the next story and the sidebar highlights story 2. The assembly code just reads the timeline and burns chrome states at the right moments.

**Not in v1.** Scene-level directives first, time-indexed directives later if the need emerges.

### 2.2 Content-type agnostic assembly

Today, News uses one chrome state machine (Fix 5/7) and NBA/Twitch use different paths. The proactive architecture **abstracts chrome decisions out of content-type-specific code**. Every content type's Gemini prompt outputs directives in the same shape. Assembly doesn't branch on content type — it just reads directives.

This aligns perfectly with `SHARED_NEWSCAST_SET_MIGRATION.md` section 10-12 — the shared newscast set across Twitch/NBA/News. Once News is locked, NBA's chrome directives follow the same schema with NBA brand config swapped in. Twitch too. One assembly code path, three content types, N customer brands.

### 2.3 Adding new chrome elements without engineering

Today, adding (say) a "weather strip" to the bottom of the screen requires:
1. Design it in HTML/CSS in `tools/clipzworld_newscast.html`
2. Add state machine branches in `server.js` for when it's visible
3. Update Gemini's prompt to know when to toggle it
4. Coordinate timing with existing chrome elements
5. Test every content type
6. Ship a Cline handoff

With proactive directives:
1. Design it in HTML/CSS in `tools/clipzworld_newscast.html`
2. Add `weatherStrip` field to the directive schema (one line in types)
3. Update Gemini's prompt to emit the field when appropriate
4. Done. No state machine, no branches, no coordination code.

Steps 4 and 5 disappear. Engineering effort per new element drops by ~70%.

### 2.4 A/B testing chrome designs

Because directives are data, you can A/B test by running two parallel pipelines with different Gemini prompts emitting different directive patterns, assembling both, and comparing viewer retention. Impossible today because chrome is hardcoded in the state machine.

### 2.5 Customer customization

Phase 2 customer dashboards let creators configure their chrome. "Hide the sidebar", "show a custom callout", "use my logo instead of CWN's". Each customer's preferences become a set of directive defaults that Gemini inherits when generating their scripts.

Impossible with reactive state machine (you can't customize a switch statement per customer). Trivial with directives (override the default directive values from customer config).

---

## 3. Directive schema (v1 proposal)

This is the target schema Gemini would emit per scene. Still a proposal — Rob has final approval before any code moves in this direction.

### 3.1 Scene types

Two top-level scene types:

**`avatar`** — Bobby G speaks, chrome overlay burned on top
**`source_clip`** — third-party video plays full-frame (or PIP, future extension), chrome minimal/hidden

### 3.2 Per-scene fields

```yaml
scenes:
  - id: string                    # unique scene identifier (STORY1_INTRO, STORY2_SETUP, etc)
    type: avatar | source_clip    # required, drives assembly behavior
    storyIndex: integer           # 0-indexed story number this scene belongs to (0 for cold open/outro)

    # avatar-only fields
    spokenText: string            # the narration text (avatar scenes only)
    estimatedDurationSec: number  # Gemini's estimate based on word count × speak speed

    # source_clip-only fields
    clipUrl: string               # Brightcove HLS / Twitch CDN / ESPN / etc
    clipStartOffsetSec: number    # optional — trim N seconds from start
    clipMaxDurationSec: number    # hard duration cap (enforces Track A2 at the directive level)

    # chrome directives (apply to both scene types)
    chrome:
      flag:
        visible: boolean
        text: string              # e.g., "TRUMP HORMUZ BLOCKADE"
        source: string            # e.g., "Al Jazeera"
        urgencyBadge: string      # optional, e.g., "BREAKING"

      tvCard:
        visible: boolean
        imageUrl: string          # og:image from article scrape
        headline: string          # shown on card
        sourceName: string        # logo/text below image

      sidebar:
        visible: boolean
        activeIndex: integer      # which story card is highlighted
        cap: integer              # max cards shown (currently 5)

      ticker:
        visible: boolean          # default true, override rarely

      logo:
        visible: boolean          # default true, override rarely

      # Future extensions (NOT in v1):
      weatherStrip: ...
      breakingNewsBanner: ...
      calloutBox: ...
```

### 3.3 Top-level script shape

```yaml
scriptVersion: 1
contentType: news                 # news | nba | twitch
clientId: client_000_rob
brandConfig:
  primaryHex: "#22304b"
  accentHex: "#c7af4f"
  showName: "BECAUSE THE LIGHT WAS ON"
  episodeNumber: 32
estimatedTotalDurationSec: 480    # Gemini's episode-length estimate

# Pre-computed metadata for the sidebar (all stories at a glance)
storyList:
  - index: 0
    title: "Trump Iran Peace Deal"
    source: "Al Jazeera"
  - index: 1
    title: "Iran Naval Blockade"
    source: "Al Jazeera"
  - index: 2
    title: "Trump Pope Feud"
    source: "Al Jazeera"
  - index: 3
    title: "Lebanon in Flames"
    source: "Al Jazeera"

scenes:
  - id: COLD_OPEN
    type: avatar
    storyIndex: -1    # no specific story
    spokenText: "Hello everyone! You are tuning into..."
    estimatedDurationSec: 12
    chrome:
      flag: {visible: false}
      tvCard: {visible: false}
      sidebar: {visible: false}
      ticker: {visible: true}
      logo: {visible: true}

  - id: STORY1_INTRO
    type: avatar
    storyIndex: 0
    spokenText: "Trump says Iran wants peace deal but insists on no nukes..."
    estimatedDurationSec: 8
    chrome:
      flag:
        visible: true
        text: "TRUMP IRAN PEACE DEAL"
        source: "Al Jazeera"
      tvCard:
        visible: true
        imageUrl: "https://aljazeera.com/og_image_1.jpg"
        headline: "Trump says Iran wants peace deal but insists on no nukes"
        sourceName: "Al Jazeera"
      sidebar:
        visible: false        # mutual exclusion during INTRO
        activeIndex: 0
        cap: 5
      ticker: {visible: true}
      logo: {visible: true}

  - id: STORY1_SETUP
    type: avatar
    storyIndex: 0
    spokenText: "..."
    estimatedDurationSec: 6
    chrome:
      flag:
        visible: true
        text: "TRUMP IRAN PEACE DEAL"
        source: "Al Jazeera"
      tvCard: {visible: false}  # hidden after intro
      sidebar:
        visible: true          # sidebar returns during setup
        activeIndex: 0
        cap: 5
      ticker: {visible: true}
      logo: {visible: true}

  - id: STORY1_CLIP
    type: source_clip
    storyIndex: 0
    clipUrl: "https://manifest.prod.boltdns.net/..."
    clipMaxDurationSec: 25
    chrome:
      flag: {visible: false}
      tvCard: {visible: false}
      sidebar: {visible: false}
      ticker: {visible: true}
      logo: {visible: true}

  - id: STORY1_SUMMARY
    type: avatar
    storyIndex: 0
    spokenText: "..."
    estimatedDurationSec: 5
    chrome:
      flag: {visible: true, text: "TRUMP IRAN PEACE DEAL", source: "Al Jazeera"}
      tvCard: {visible: false}
      sidebar: {visible: true, activeIndex: 0, cap: 5}
      ticker: {visible: true}
      logo: {visible: true}

  - id: STORY1_REACTION
    type: avatar
    storyIndex: 0
    spokenText: "..."
    estimatedDurationSec: 4
    chrome: {...}

  - id: STORY2_INTRO
    type: avatar
    storyIndex: 1
    spokenText: "What are the pros and cons of Trump's Iranian naval blockade..."
    estimatedDurationSec: 7
    chrome:
      flag:
        visible: true
        text: "IRAN NAVAL BLOCKADE"       # flag text UPDATES for new story
        source: "Al Jazeera"
      tvCard:
        visible: true
        imageUrl: "https://aljazeera.com/og_image_2.jpg"
        headline: "What are the pros and cons of Trump's Iranian naval blockade"
        sourceName: "Al Jazeera"
      sidebar:
        visible: false
        activeIndex: 1                     # highlight advances
        cap: 5
      ticker: {visible: true}
      logo: {visible: true}

  # ... STORY2_SETUP, STORY2_CLIP, STORY2_SUMMARY, STORY2_REACTION ...
  # ... STORY3_*, STORY4_* ...

  - id: OUTRO
    type: avatar
    storyIndex: -1
    spokenText: "That does it for another edition..."
    estimatedDurationSec: 10
    chrome:
      flag: {visible: false}
      tvCard: {visible: false}
      sidebar: {visible: false}
      ticker: {visible: true}
      logo: {visible: true}
```

### 3.4 Validation rules

Before assembly begins, the script is validated against a schema (Zod or JSON Schema). Validation catches:

- Missing required fields per scene type
- `storyIndex` references a non-existent story in `storyList`
- `activeIndex` on sidebar > `storyList.length`
- `clipMaxDurationSec` on a source_clip scene exceeds policy (currently 25 for News)
- Chrome mutual exclusion violated (e.g., flag visible and sidebar visible during INTRO when they should be mutually exclusive)
- `estimatedTotalDurationSec` within target range (8-15 min for long-form)

If validation fails, hard-abort BEFORE any HeyGen spend. Same principle as Fix 25c's pre-Gate-0 hard gate.

---

## 4. What changes in the code

### 4.1 Gemini prompt (the biggest change)

Current News prompt at `server.js:6685-6737` writes scripts with `=== STORY#_HEADER ===` markers and plain text. The prompt instructs Gemini on scene structure, word counts, beat placement, locked intros, source attribution rules.

**Target:** the prompt instructs Gemini to emit JSON matching the schema above. Every scene has chrome directives. Gemini is responsible for picking flag text, TV card headlines, sidebar highlight indices based on the story content.

Example prompt addition:

```
OUTPUT FORMAT — STRICT:

Return a JSON object matching this schema:
  { scriptVersion, contentType, clientId, brandConfig, storyList, scenes: [...] }

Each scene must have a chrome object with these fields (see schema).
You are responsible for picking chrome content appropriate to each
scene — flag text should reflect the active story, tv card should show
the og:image for that story, sidebar activeIndex should advance as the
episode progresses through the story list.

RULES:
1. flag.text must be UPPERCASE, 2-4 words, punchy summary of the story
2. tvCard.headline is the full article headline, sentence case
3. sidebar.activeIndex starts at 0 for STORY1, 1 for STORY2, etc
4. source_clip scenes always have chrome.flag.visible=false,
   chrome.tvCard.visible=false, chrome.sidebar.visible=false
5. STORY#_INTRO scenes have chrome.sidebar.visible=false (mutual
   exclusion with flag+tv card)
6. STORY#_SETUP, SUMMARY, REACTION scenes have chrome.sidebar.visible=true
7. COLD_OPEN and OUTRO have all chrome elements hidden EXCEPT ticker+logo
```

Gemini becomes the source of truth for chrome, not a downstream consumer of it.

### 4.2 Assembly code (simplification)

Current assembly in `server.js` has ~200 lines of chrome state machine logic spanning `server.js:3876-3925` and related helpers. That code gets replaced by a ~20-line directive consumer:

```javascript
async function burnSceneChrome(scene, tsFile, asmId) {
  const chrome = scene.chrome;

  // If all chrome elements are hidden, skip the burn entirely
  const anyVisible = chrome.flag?.visible || chrome.tvCard?.visible ||
                     chrome.sidebar?.visible;
  if (!anyVisible && scene.type === 'source_clip') {
    return tsFile; // no chrome burn, return clip as-is
  }

  // Generate the chrome overlay PNG from the directive
  const overlayPng = await generateChromeOverlayFromDirective(chrome, {
    episodeNumber: script.brandConfig.episodeNumber,
    storyList: script.storyList,
    brandPrimary: script.brandConfig.primaryHex,
    brandAccent: script.brandConfig.accentHex
  });

  // Burn via FFmpeg overlay (same as today)
  return await burnOverlayOnTs(tsFile, overlayPng, scene.estimatedDurationSec);
}
```

**Lines of code deleted:** Fix 5/7 chrome state machine in `server.js:3876-3925` (~200 lines), the per-content-type branches that try to guess scene type from filename, the `isStoryIntro`/`isStoryBody` flag computation.

**Lines of code added:** the directive consumer above (~20 lines) + a generalized `generateChromeOverlayFromDirective(chrome, context)` helper that maps the directive schema to Puppeteer `page.evaluate()` calls.

**Net:** ~180 lines of code removed from assembly. Complexity moves upstream to Gemini's prompt.

### 4.3 Template (minor change)

`tools/clipzworld_newscast.html` already supports toggling elements via CSS classes set from Puppeteer's `page.evaluate()`. The existing mechanism stays — what changes is the DATA being toggled:

**Before (reactive):**
```javascript
// Assembly-time state machine decides what to toggle
await page.evaluate((showFlag, hideSidebar, flagText) => {
  if (showFlag) document.querySelector('.lower-third').classList.add('visible');
  if (hideSidebar) document.body.classList.add('sidebar-hidden');
  if (flagText) document.querySelector('.lt-headline').textContent = flagText;
}, computedShowFlag, computedHideSidebar, computedFlagText);
```

**After (proactive):**
```javascript
// Gemini's directives drive the toggle directly
const { flag, sidebar, tvCard } = scene.chrome;
await page.evaluate((directive) => {
  if (directive.flag.visible) {
    document.querySelector('.lower-third').classList.add('visible');
    document.querySelector('.lt-headline').textContent = directive.flag.text;
  }
  if (!directive.sidebar.visible) {
    document.body.classList.add('sidebar-hidden');
  }
  if (directive.tvCard.visible) {
    document.querySelector('.tv-card').classList.add('visible');
    document.querySelector('.tv-card img').src = directive.tvCard.imageUrl;
  }
}, { flag, sidebar, tvCard });
```

The template doesn't need new CSS classes. The existing ones work. What changes is the decision SOURCE — Gemini decides, template executes.

### 4.4 Gate 1 QA (new validation layer)

`claudeScriptQA()` at `server.js:1522-1728` currently validates scripts against text-based rules (scene count, clip count, source attribution ban, word count per scene). When scripts become JSON, Gate 1 gets three new checks:

1. **Schema validation** — does the JSON match the directive schema? (Zod validation)
2. **Chrome consistency** — does every scene have sensible chrome directives? (flag text matches story, activeIndex advances correctly, mutual exclusion rules obeyed)
3. **Cross-scene continuity** — does the sidebar activeIndex advance monotonically? Does the flag text update at STORY boundaries? Does chrome collapse to minimal during source_clip scenes?

These checks catch Gemini hallucinations BEFORE HeyGen burns tokens. Same pattern as Fix 25c upstream hard gate.

### 4.5 Storage

Current script is a string in the job card. Target script is a JSON object in the job card. Schema:

```javascript
// Before (current)
card.script = "=== INTRO ===\nHello everyone!\n\n=== STORY1_INTRO ===\n..."

// After (target)
card.script = {
  scriptVersion: 1,
  contentType: 'news',
  clientId: 'client_000_rob',
  brandConfig: {...},
  storyList: [...],
  scenes: [...],
  spokenText: "...derived from scenes for HeyGen submission..."
}
```

HeyGen still receives plain text spoken content (derived from `scenes[].spokenText`), but the full structured script lives in the job card for assembly to read.

---

## 5. Migration path

### 5.1 Phase A — Schema design (1 day, no code)

- Lock the directive schema v1 (Rob reviews, picks fields, approves)
- Write Zod / JSON Schema validator
- Write example script JSON for all 3 content types (News, NBA, Twitch) to stress-test the schema
- Validate that the schema expresses everything the current reactive state machine does (no regressions in chrome behavior)

### 5.2 Phase B — Dual-output Gemini prompt (2-3 days)

- Modify the News Gemini prompt to output BOTH the legacy plain-text format AND a new `chromeDirectives` JSON block per scene
- Assembly code stays reactive — the new JSON block is ignored initially
- Validate via diff: does Gemini's JSON match what the reactive state machine would compute for the same scenes?
- If they diverge, debug until Gemini produces directives that match the existing behavior byte-for-byte (or adjust what's considered "correct")

This is the safety net. Gemini learns to emit directives, the pipeline keeps working on the legacy path, we compare outputs.

### 5.3 Phase C — Switch assembly to consume directives (1 day)

- Once Phase B produces matching output consistently, flip a feature flag `USE_DIRECTIVE_CHROME = true`
- Assembly reads from `scene.chrome` instead of the state machine
- Legacy state machine code stays in place but dormant
- Run smoke test N with directives, smoke test N+1 with state machine, diff the output MP4s
- If matching, directive path wins

### 5.4 Phase D — Delete the state machine (1 day)

- Remove Fix 5/7 state machine code from `server.js:3876-3925`
- Remove the per-content-type string matching helpers
- Keep the feature flag for emergency rollback for 2-4 weeks
- After 4 weeks of clean runs on directive path, delete the flag

### 5.5 Phase E — Extend to NBA, Twitch (2-3 days each)

- Once News is on directives and stable, clone the Gemini prompt pattern to NBA and Twitch
- Each content type's directive schema is the SAME (one universal schema)
- Per-content-type brand configs override defaults
- Matches `SHARED_NEWSCAST_SET_MIGRATION.md` section 12 shared chrome target state

### 5.6 Total effort estimate

**Phase A-D (News only):** 5-7 days of focused work
**Phase E (NBA + Twitch):** 4-6 additional days

Total: **9-13 days of focused work** for full migration to proactive architecture. NOT a tonight job. Parked until Rob decides "it's time."

---

## 6. When to build this

Rob's criteria (inferred from the 2026-04-13 PM conversation):

**Build NOW if:**
- Multiple smoke tests in a row produce chrome sync/timing bugs that the reactive architecture can't fix surgically
- Every new content type migration (News → NBA → Twitch) requires custom state machine code, not just config swaps
- Debugging chrome issues consistently eats >2 hours per smoke test cycle

**WAIT if:**
- The reactive architecture is unblocked for the current smoke test (Track A fix from `CLINE_HANDOFF_NEWS_SMOKE_TEST_10_FIXES.md` is Tier 1 unblocker)
- News is close to locked and NBA/Twitch chrome migrations can ride on the existing state machine with brand config swaps
- Phase 2 hasn't started yet — Phase 2 is the natural home for this architecture rework

**Rob's gut 2026-04-13 PM:** *"you are going to build it this way when its time"* — which I read as "park it, build it when the pain of the reactive architecture outgrows the work to migrate."

My read: **build this at the Phase 1 → Phase 2 transition.** Not during Phase 1 smoke tests (too much in-flight risk). Not mid-Phase-2 (would disrupt the multi-tenant work). The transition moment is when News is locked, NBA is in progress, and the News chrome is about to be cloned to NBA — that's the best moment to migrate to directives BEFORE cloning, so you don't clone reactive state machine code into NBA just to delete it later.

---

## 7. Risks

### 7.1 Risk — Gemini hallucinates directives

Gemini 2.5 Flash has a known hallucination pattern (see `GATED_PIPELINE_ARCHITECTURE.md` section on AI Video Analysis Known Reliability Limits, and `scripts/audit_news_clips.js` retraction from 2026-04-13). If Gemini hallucinates chrome directives — say, invents a flag text that doesn't match the story — the assembly code executes the hallucination faithfully.

**Mitigation:**
- Gate 1 validates directive consistency against the story metadata (activeIndex matches storyIndex, flag text contains words from the article title)
- Claude Gate 1 QA reviews the JSON, not just the spoken text
- Zod schema validation catches missing/malformed fields
- Dual-output phase (B above) compares Gemini JSON to state machine output for several smoke tests before switching

**Residual risk:** Gemini could emit valid-schema directives that are subtly wrong (right format, wrong content). Mitigated by Gate 1 but not eliminated.

### 7.2 Risk — Schema evolution breaks old scripts

Once directives are in production, adding a new field is additive (safe — old scripts without the field get defaults). But renaming or removing a field is breaking. If `scriptVersion` is enforced, old scripts can keep running on old code paths while new scripts use new schemas.

**Mitigation:**
- Every script has `scriptVersion`
- Assembly code supports the latest 2 versions simultaneously
- Deprecation cycle is 1 month per schema version change

### 7.3 Risk — Gemini prompt becomes too long

The new prompt needs to explain the directive schema, the field semantics, and the rules for each scene type. Could bloat from the current ~3000 tokens to 5000+ tokens.

**Mitigation:**
- Keep the schema description concise
- Provide 1-2 example scenes in the prompt for Gemini to pattern-match
- Move detailed rules to a system prompt (cached) and keep user prompt short

**Residual risk:** longer prompts cost more per generation. Mitigated by Gemini caching on repeated prompts and the fact that the script gen is a one-off cost per episode.

### 7.4 Risk — Directive mistakes are invisible until Gate 3

With reactive state machine, chrome bugs often manifest as obvious visual errors (wrong element showing) that Rob catches in YouTube Studio review. With directives, chrome mistakes might be subtly wrong (slightly wrong flag text, slightly wrong sidebar highlight) and harder to notice.

**Mitigation:**
- Gate 3 adds chrome-specific checks: does flag text match story title? Does sidebar activeIndex match scene storyIndex?
- These are deterministic file-level / JSON-level checks (not Gemini-based — avoids the hallucination trap)

---

## 8. Alternatives considered

### 8.1 Alternative — fix reactive state machine more

Keep the reactive architecture but harden it: better string matching regexes, formal scene type enum instead of string inference, per-scene overrides stored in a side-channel (not in the script itself).

**Pros:** smaller change, no Gemini prompt rewrite, minimal risk of regression
**Cons:** still fragile, still hardcoded in assembly, still impossible to customize per-customer, still requires engineering for every new chrome element

**Rejected because:** the complexity accumulates forever. Every new content type, every new customer, every new chrome element adds another branch. Proactive architecture collapses complexity into the directive schema.

### 8.2 Alternative — full DSL with its own runtime

Instead of JSON directives, build a small domain-specific language (DSL) for chrome. Gemini emits DSL code, assembly has an interpreter.

**Pros:** more expressive, supports arbitrary logic
**Cons:** huge overbuild, new DSL to maintain, new parser/interpreter, new debugging surface
**Rejected because:** JSON is fine. The expressiveness we need fits cleanly in a data schema.

### 8.3 Alternative — client-side chrome rendering (browser-based player)

Skip FFmpeg burn entirely. Serve raw video + overlay directives as JSON to a browser-based video player that renders chrome client-side.

**Pros:** customers can customize chrome in real-time, no re-render needed
**Cons:** only works for in-app playback, not YouTube/TikTok/Instagram, requires custom video player, breaks the "publish to multiple platforms" model
**Rejected because:** CWN's whole premise is automated multi-platform publishing. Client-side rendering breaks that.

---

## 9. Open questions

These don't block this doc from being parked but should be resolved before Phase A of the migration starts:

**Q1. JSON vs YAML for directives.** I've shown YAML in examples for readability, but production would probably be JSON (natively supported by Gemini's response_mime_type, no parsing library needed). Rob's call when we start Phase A.

**Q2. Should directives allow references / variables?** e.g., `flag.text: "${story.title_uppercase}"` pulls from `storyList`. Simpler but adds templating complexity. Probably no — just have Gemini write the final text directly.

**Q3. How granular should per-story sidebar highlighting be?** `activeIndex: 0-4` or also support `partialProgress: 0.5` for "between story 1 and story 2"? Probably stick with integer activeIndex for v1.

**Q4. Should source_clip scenes have chrome directives at all, or is chrome always hidden during clips?** Per Rob's current spec, chrome IS always hidden during clips. So the directives on source_clip scenes could be omitted (default to all-hidden). But explicit is better than implicit — require every scene to declare chrome even if it's all false.

**Q5. Time-indexed directives within a single scene — in v1 or v2?** I proposed time-indexed as a future extension (section 2.1). Should v1 include them or is scene-level granularity enough?

My vote: **v1 = scene-level only**. Time-indexed is v2 when a real use case emerges.

---

## 10. What this doc does NOT cover

- **Current emergency fix for News smoke test #10** → `CLINE_HANDOFF_NEWS_SMOKE_TEST_10_FIXES.md` Track A
- **Upstream pre-validation** → `CLINE_HANDOFF_NEWS_SMOKE_TEST_10_FIXES.md` Track C
- **Monorepo / Phase 2 structure** → `PHASE_2_BUILD_SPEC.md`
- **Business strategy / ICP / pricing** → `BUSINESS_STRATEGY.md`
- **Shared chrome template across content types (palette + layout)** → `SHARED_NEWSCAST_SET_MIGRATION.md`

---

## 11. Next action

Rob reads this doc when he's in the right headspace. Possibly days or weeks from now. No urgency.

When Rob says "it's time," the migration begins at Phase A (schema design). Until then:

- Phase 1 smoke test loop continues on reactive architecture
- Track A fixes chrome bugs surgically as they surface
- Track C catches upstream problems before they reach Gate 3
- News locks, NBA starts, Twitch iterates
- At the transition point when chrome code starts needing major changes to support NBA or Twitch, reconsider whether proactive migration should happen first

**The goal of this doc is to make the migration a one-sprint project when the time comes**, not a multi-month redesign. Everything needed to execute is captured above. Schema, migration phases, risks, alternatives, open questions — all specified. When Rob says go, we start at Phase A.
