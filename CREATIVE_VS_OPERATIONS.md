# CWN: Creative vs Operations Breakdown

**Created**: 2026-04-09  
**Purpose**: Clarify what needs creative alignment (Rob + Claude discussion) vs what is pure technical automation  
**Status**: For Rob to review with Claude before any new builds begin

---

## The Core Distinction

> **Creative** = decisions about HOW the show looks, feels, and sounds — requires Rob's vision + Claude's judgment  
> **Operations** = the automated machinery that executes those creative decisions — built by Cline/Aider

**Nothing in Operations should be built until the Creative decisions are locked.**  
Building the wrong layout, wrong brand rules, or wrong QA criteria wastes weeks.

---

## 🎨 CREATIVE — Decisions Rob + Claude Must Align On First

These are NOT technical questions. They are show design questions.

### 1. Short-Form Visual Layout (9:16)
**The question**: What does the split-screen actually look like?

Current documented spec (from `Creative Requirements and Direction.txt`):
- Top 50%: Source clip (1080×960)
- Bottom 50%: Bobby G avatar (1080×960)
- Logo: 80px top-right

**What Claude needs to decide with Rob**:
- Is 50/50 the right split, or should Bobby G be smaller (e.g., 40% bottom)?
- Does the clip always go on top, or does it depend on content type?
- What happens during Bobby G's intro/outro (no clip) — does he go full screen?
- Is there a "burn-in zone" at the split seam for text/graphics?
- TikTok safe zones: does the bottom-right UI (like/share buttons) cover Bobby G's face?

**Why this matters before building**: If the split ratio is wrong, the entire short-form assembly needs to be rebuilt.

---

### 2. Brand Visual Rules (The "Gold Ring" Standard)
**The question**: What are the exact brand rules for every visual element?

Current documented spec:
- Gold border: `#c7af4f`, 5px
- Shadow: 50% opacity
- Logo: 85% opacity, top-right
- Background: Dark Slate `#1a1a1a`

**What Claude needs to decide with Rob**:
- Is the gold border applied to ALL overlays (NBA cards, news cards, intro cards) or only some?
- Does the gold border apply to thumbnails too, or just in-video overlays?
- What's the exact shadow spec (blur radius, offset, color)?
- Is there a "no-go zone" where overlays can never appear (avatar face, ticker)?

**Why this matters before building**: Gate 3 QA will check for these rules. If the rules aren't locked, QA will flag false failures.

---

### 3. NBA Intro Cards — Visual Design
**The question**: What does the NBA game card actually look like?

Current documented spec:
- Size: 640×360 (TV shape)
- Position: Right of Bobby G at `overlay=W-640-40:H/2-180`
- Timing: Display at each `GAME#_[TEAMS]_INTRO` scene

**What Claude needs to decide with Rob**:
- What's on the card? Just team logos + score? Or team colors, player stats, game summary?
- Does the card have the gold border treatment?
- How long does it stay on screen? (3.5s like Twitch intro cards, or longer?)
- Does it fade in/out or hard cut?
- Is it generated from `nba_thumbnail_generator.html` or a new template?

---

### 4. News Intro Cards — Visual Design
**The question**: What does the news story card look like?

Current documented spec:
- Source: Open Graph image scraped from article URL
- Size: 640×360
- Position: Same as NBA cards

**What Claude needs to decide with Rob**:
- What if the article has no Open Graph image? Fallback design?
- Does the news card show the headline text burned in, or just the image?
- Source attribution (e.g., "CNN", "BBC") — displayed on card?
- Same gold border treatment as NBA?

---

### 5. Thumbnail Strategy
**The question**: What makes a CWN thumbnail "exceed expectations"?

Current documented spec (from Creative Requirements):
- Gemini identifies the "Visual Hook" frame
- 3 thumbnail options generated, Rob picks winner
- Episode number + date burned in
- Streamer profile image for Twitch

**What Claude needs to decide with Rob**:
- Is the 3-option "thumbnail battle" the right workflow, or is 1 auto-generated thumbnail enough for now?
- For NBA: team logos or player faces?
- For News: article image or custom graphic?
- Is Nano Banana Pro (AI image gen) in scope, or just FFmpeg/Canvas?
- What's the "clickability" standard? (Gemini audits it — but what criteria?)

---

### 6. Gate 3 Visual Retention Rules
**The question**: What does "good pacing" look like for CWN?

Current documented spec (from Creative Requirements):
- Every 7 seconds: must have a visual change (cut, zoom, or image burn)
- -10 points per "Static Zone"

**What Claude needs to decide with Rob**:
- Is the 7-second rule right for CWN's style? (Jon Stewart + Norm MacDonald = slower, deadpan — might be fine to hold longer)
- What counts as a "visual change"? Just cuts, or also Bobby G's gestures?
- Should static zones auto-trigger a burn-in, or just flag for Rob?
- Is this Gate 3 extension in scope for Phase 2, or later?

---

### 7. Bobby G's Creative Voice — Script Quality Standard
**The question**: What does a 90+ Gate 1 script actually sound like?

Current documented spec:
- Jon Stewart + Norm MacDonald + Space Ghost blend
- Flat delivery, no "incredible/amazing/crazy/wild"
- Short sentences, never explain the joke
- [beat] pauses for timing

**What Claude needs to decide with Rob**:
- Is the current style guide in `cwn_style_guides.json` accurate to what Rob wants?
- Are there specific scripts Rob considers "gold standard" that Gemini should learn from?
- What's the NBA voice? Same as Twitch, or more sports-anchor energy?
- What's the News voice? Deadpan journalist, or same Bobby G energy?

---

## ⚙️ OPERATIONS — Pure Technical Automation (Build After Creative Is Locked)

These are implementation tasks. No creative decisions needed — just execute the spec.

| Task | Depends On | Owner | When |
|------|-----------|-------|------|
| Short-form FFmpeg split-screen | Creative #1 locked (layout spec) | Aider | After layout decision |
| NBA intro card generator | Creative #3 locked (card design) | Aider | After card design |
| News Open Graph scraper | Creative #4 locked (card design) | Aider | After card design |
| Gold border FFmpeg filter | Creative #2 locked (brand rules) | Cline | After brand rules |
| Gate 3 visual retention check | Creative #6 locked (pacing rules) | Cline | After pacing rules |
| NBA intro prompt fix | No creative decision needed | Cline | Now |
| Human approval checkpoint | No creative decision needed | Cline | Now |
| Gate 6 auto-publish | No creative decision needed | Cline | Now |
| Upload-Post status polling | No creative decision needed | Cline | Now |

---

## 📋 What Rob Should Discuss With Claude

Bring these questions to Claude in order of priority:

### Priority 1 (Blocks Phase 2 testing)
1. **Short-form layout**: 50/50 split? Bobby G full-screen during intro/outro?
2. **NBA intro card**: What's on it? How long? Gold border?
3. **Gate 1 score 85→90**: Is 85 acceptable for production, or must we hit 90?

### Priority 2 (Quality standard)
4. **Brand rules**: Gold border on all overlays? Exact shadow spec?
5. **Thumbnail strategy**: 3-option battle or 1 auto? What makes it "clickable"?
6. **Style guide accuracy**: Does `cwn_style_guides.json` match Rob's vision?

### Priority 3 (Future)
7. **Visual retention**: Is the 7-second rule right for CWN's deadpan style?
8. **News card**: Headline text burned in? Source attribution?
9. **Nano Banana Pro**: In scope or out?

---

## 🚫 What NOT to Build Until Creative Is Locked

Do NOT start these until Rob + Claude have aligned on the creative spec:

- ❌ Short-form split-screen assembly (layout not finalized)
- ❌ NBA intro card generator (card design not finalized)
- ❌ News intro card scraper (card design not finalized)
- ❌ Gate 3 visual retention rules (pacing standard not finalized)
- ❌ Thumbnail battle system (strategy not finalized)
- ❌ Nano Banana Pro integration (scope not confirmed)

---

## ✅ What CAN Be Built Now (No Creative Decision Needed)

These are pure operations — no creative alignment required:

1. **NBA intro prompt fix** — enforce "Other Side of the Pillow" intro line (Cline, 30 min)
2. **Human approval checkpoint** — dashboard "Approve & Upload" button after Gate 3 (Cline, 1 hr)
3. **Gate 6 auto-publish** — trigger `/publish` after Rob approves (Cline, 1 hr)
4. **Upload-Post status polling** — frontend confirms upload success (Cline, 30 min)

---

## 📝 Summary for Claude

When Rob brings this to Claude, the key framing is:

> "We have the operational pipeline working (script → HeyGen → assembly → Gate 3). Before we build the creative layer (split-screen, intro cards, thumbnails, visual QA), we need to lock the creative spec. What should each of these look like, and what are the brand rules that Gate 3 should enforce?"

Claude's job in that conversation:
1. Review `Creative Requirements and Direction.txt` — is this still the vision?
2. Propose specific answers to the 9 creative questions above
3. Output an updated `VISUAL_DESIGN_SPEC.md` with locked decisions
4. Only then hand off to Cline/Aider to build

**The output of that Claude conversation should be a locked spec document — not more code.**
