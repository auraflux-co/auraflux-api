# CLINE HANDOFF: Sidebar Card Content — NBA Matchup + Twitch Streamer Fact

**→ Agent: Cline-C (HTML/chrome) + addendum to Cline-A (assembly data)**
**Priority:** HIGH — sidebar cards are the intro card replacement. They must show the right content per content type.
**Size:** M (3 files, tightly coupled — do not split)
**Status:** READY — no external dependencies

---

## What Each Sidebar Card Should Show

The right-side sidebar has one card per story/game/streamer. Cards light up (active state) when Bobby G is on that segment.

| Content Type | Card top line (`.story-item-cat`) | Card main line (`.story-item-text`) | Card sub line (`.story-item-fact`) |
|---|---|---|---|
| `news` | `▶ ON AIR` (active) / `WORLD NEWS` (inactive) | News headline (e.g. "Gaza ceasefire talks collapse") | — (no fact line for news) |
| `nba` | `▶ ON AIR` (active) / `NBA GAME` (inactive) | Matchup (e.g. "Lakers vs Celtics") | — (no fact line for nba) |
| `twitch` | `▶ ON AIR` (active) / `ON STREAM` (inactive) | Streamer display name (e.g. "Jay Cinco") | Streamer fun fact (e.g. "Retired his jersey") |

News is already correct. NBA and Twitch need fixes:
- **NBA**: `story.title` must be the matchup string — "Lakers vs Celtics", not "Game 1" or a raw scene label
- **Twitch**: needs a third line for the fun fact from `streamers.json`. The fact field exists on every streamer entry (`s.fact`). Currently not passed or rendered.

---

## Part A — `tools/clipzworld_newscast.html` (Cline-C)

**Step 0 — Create your branch:**
```bash
git checkout main && git pull && git checkout -b cline-c/sidebar-card-content
```

### A1 — Add `.story-item-fact` CSS

**Find** the `.story-item-text` rule (~line 301):
```css
.story-item-text {
  font-size: 18px;
  font-weight: 600;
  color: #ffffff;
  line-height: 1.35;
}
```

**Add this block immediately after it:**
```css
.story-item-fact {
  font-size: 12px;
  font-weight: 400;
  color: rgba(255,255,255,0.55);
  line-height: 1.3;
  margin-top: 4px;
  font-style: italic;
}
.story-item.active .story-item-fact {
  color: rgba(255,255,255,0.75);
}
```

### A2 — Update story card renderer in `page.evaluate()` (`lib/chrome_overlay.js`)

**Find** the story list builder in `lib/chrome_overlay.js` (~line 443). It currently renders:
```javascript
storyItem.innerHTML = `
  <div class="story-item-cat">${idx === activeIndex ? '▶ ON AIR' : story.category || 'WORLD'}</div>
  <div class="story-item-text">${story.title || story.text || ''}</div>
`;
```

**Replace with:**
```javascript
storyItem.innerHTML = `
  <div class="story-item-cat">${idx === activeIndex ? '▶ ON AIR' : story.category || 'WORLD'}</div>
  <div class="story-item-text">${story.title || story.text || ''}</div>
  ${story.fact ? `<div class="story-item-fact">${story.fact}</div>` : ''}
`;
```

The `story.fact` field is only populated for Twitch content type. For News and NBA it will be
`undefined`, so the fact div won't render. One template, three content types.

---

## Part B — `lib/assembly.js` (Cline-A — add to existing `cline-a/chrome-skins-parts-2-3` branch)

These changes are in the `allStories` builders that feed the sidebar. They are part of the
chrome migration work already in progress on `cline-a/chrome-skins-parts-2-3`.

### B1 — Twitch `allStories` — add `fact` field

In the Part 3 replacement code (Twitch chrome block), the `allStories` builder currently maps:
```javascript
const allStories = streamerRoster.length > 0
  ? streamerRoster.map((s, idx) => ({
      title:    s.displayName || s.name || `Streamer ${idx + 1}`,
      category: 'ON STREAM',
      storyId:  `streamer_${idx}`
    }))
  : [{ title: 'STREAMER', category: 'ON STREAM', storyId: 'streamer_0' }];
```

**Add `fact` to every entry:**
```javascript
const allStories = streamerRoster.length > 0
  ? streamerRoster.map((s, idx) => ({
      title:    s.displayName || s.name || `Streamer ${idx + 1}`,
      category: 'ON STREAM',
      storyId:  `streamer_${idx}`,
      fact:     s.fact || ''
    }))
  : [{ title: 'STREAMER', category: 'ON STREAM', storyId: 'streamer_0', fact: '' }];
```

`s.fact` is the fun fact string from `data/streamers.json` (e.g. `"Retired his jersey"` for Jay Cinco).

### B2 — NBA `allStories` — ensure matchup string is used

In the Part 2 replacement code (NBA chrome block), the `allStories` builder currently maps:
```javascript
const allStories = allNbaIntros.length > 0
  ? allNbaIntros.map((introSeg, idx) => ({
      title:    introSeg.cardData?.title || introSeg.cardData?.matchup || `Game ${idx + 1}`,
      category: 'NBA GAME',
      storyId:  `game_${idx}`
    }))
  : [{ title: cardData.title || cardData.matchup || 'NBA Highlights', category: 'NBA GAME', storyId: 'game_0' }];
```

The priority order `title || matchup || fallback` is correct. But `cardData.title` for NBA is
sometimes a raw ESPN title like "Los Angeles Lakers vs Boston Celtics — Game Recap". Truncate
it to the core matchup if it's too long:

```javascript
const allStories = allNbaIntros.length > 0
  ? allNbaIntros.map((introSeg, idx) => {
      const raw = introSeg.cardData?.matchup || introSeg.cardData?.title || `Game ${idx + 1}`;
      // Truncate long ESPN titles to just the matchup (before " — " or after 40 chars)
      const matchup = raw.split(/\s+[—–-]\s+/)[0].trim().slice(0, 40);
      return { title: matchup, category: 'NBA GAME', storyId: `game_${idx}` };
    })
  : [{ title: cardData.matchup || cardData.title || 'NBA Highlights', category: 'NBA GAME', storyId: 'game_0' }];
```

`matchup` field is preferred over `title` because it's already clean (e.g. "Lakers vs Celtics").
`title` is used as fallback but truncated at `—` to strip ESPN's " — Game Recap" suffix.

---

## Files to Change

| File | Agent | Change |
|------|-------|--------|
| `tools/clipzworld_newscast.html` | Cline-C | Add `.story-item-fact` CSS (A1) |
| `lib/chrome_overlay.js` | Cline-C | Add `story.fact` div to card renderer (A2) |
| `lib/assembly.js` | Cline-A | Add `fact` field to Twitch allStories; fix NBA matchup truncation (B1, B2) |

**Cline-C branch:** `cline-c/sidebar-card-content`
**Cline-A:** add B1 + B2 to existing `cline-a/chrome-skins-parts-2-3` branch — these are small additions to the allStories builders already being written in that handoff.

**Do not touch:** `server.js`, `lib/qa.js`, `lib/publish.js`, `data/streamers.json`

---

## Streamer fact reference (from `data/streamers.json`)

```
Jason       | Dep Gai guy
Hasan       | Hank Pecker bestie
Adapt       | Never faked a trickshot
Ron         | At least he's Stable
Lacy        | Married to Drew
Marlon      | Fooled the Internet
Cinna       | Rosi's Contract Extended.....Again
Yonna       | Number one roaster
Jay Cinco   | Retired his jersey
Maya        | The Gen Z Jane Goodall
Emily       | Engaged to Maya
Rage        | A lot of motion for no knees
```

These come from `s.fact` on each roster entry — no hardcoding needed, the data is already there.

---

## Verification

**Cline-C:**
```bash
node -c lib/chrome_overlay.js && echo "chrome_overlay OK"
grep -n "story-item-fact\|story\.fact" tools/clipzworld_newscast.html lib/chrome_overlay.js || true
```
Expected: `.story-item-fact` CSS in the HTML, `story.fact` conditional in chrome_overlay.js.

**Cline-A:**
```bash
node -c lib/assembly.js && echo "assembly OK"
grep -n "s\.fact\|matchup.*split\|split.*matchup" lib/assembly.js || true
```
Expected: `s.fact` in Twitch allStories map, matchup truncation in NBA allStories map.

**Visual check:** Run a Twitch assembly. Each sidebar card should show:
- Line 1 (gold/red): `ON STREAM` or `▶ ON AIR`
- Line 2 (white bold): streamer display name
- Line 3 (dim italic): fun fact

Run an NBA assembly. Each sidebar card should show:
- Line 1: `NBA GAME` or `▶ ON AIR`
- Line 2: matchup like "Lakers vs Celtics" — not "GAME1_LAKERS_VS_CELTICS_INTRO"

---

## Pre-Commit Checklist (Cline-C)

- [ ] On branch `cline-c/sidebar-card-content` — confirm with `git branch`
- [ ] `node -c lib/chrome_overlay.js && echo "OK"` passes
- [ ] `.story-item-fact` CSS exists in `tools/clipzworld_newscast.html`
- [ ] `story.fact` conditional renders in `lib/chrome_overlay.js` card HTML
- [ ] `STATUS.md → 🤖 Last Agent Action` updated
- [ ] No `.env`, `output/`, `tmp/`, `data/jobs.json` staged
- [ ] Commit: `feat(chrome): add streamer fact line to sidebar cards + NBA matchup truncation`
- [ ] Tell Rob the branch is ready — do not merge to main yourself

## Pre-Commit Checklist (Cline-A — add to chrome-skins branch)

- [ ] `node -c lib/assembly.js && echo "OK"` passes
- [ ] `s.fact` present in Twitch allStories map in assembly.js
- [ ] NBA allStories uses `matchup` field first, truncates at ` — ` separator
- [ ] These changes committed on `cline-a/chrome-skins-parts-2-3` alongside the main chrome migration
