# AIDER OVERNIGHT TASK: Universal Content Architecture Audit + Refactor Plan

**Agent:** Aider
**Type:** Audit + planning (no production code changes)
**Priority:** Medium — foundational for platform scale

---

## Objective

The codebase is being built for a content-universal platform. The first customer is the owner (Twitch/NBA/News), but the system must work for any content type via inputs — not via hardcoded branches per content type.

Today the code has 25+ structural violations where `if (contentType === 'twitch')` or `if (contentType === 'nba')` branches encode content-specific assumptions into generic pipeline logic. This blocks adding new content types without touching core files.

**Aider's job tonight:** Audit every violation, categorize it, and produce a refactor plan. Do NOT change production code. Output a report and a migration spec.

---

## Known Violations (from prior audit)

### HIGH severity — blocks new content types

| File | Lines | Issue |
|------|-------|-------|
| `lib/script_gen.js` | 1123-1400 | Three separate data normalization branches per type |
| `lib/script_gen.js` | 2042-2053 | Scene count formulas hardcoded per type |
| `lib/qa.js` | 438 | News-only JSON validation path vs text regex for others |
| `lib/qa.js` | 491-509 | 2D array (Twitch) vs flat array (NBA/News) hardcoded |
| `lib/qa.js` | 523-603 | Three separate QA checklists as ternary chains |
| `lib/assembly.js` | 2488-2903 | Three separate label parsing blocks per type |
| `lib/assembly.js` | ~label routing | STORY/GAME/streamer scene name parsing per type |

### MEDIUM severity — duplication/maintenance burden

| File | Lines | Issue |
|------|-------|-------|
| `lib/script_gen.js` | 580-591 | Token limits hardcoded per type |
| `lib/script_gen.js` | 638-750 | Voice guides only for Twitch, others get fallback |
| `lib/assembly.js` | 1152 | Al Jazeera re-scrape baked into segment processing |
| `lib/assembly.js` | 1592-1737 | 150+ lines Twitch-only chrome overlay |
| `lib/assembly.js` | 2136-2142 | Crop size + watermark mask per type |
| `lib/assembly.js` | 2161-2182 | Silence detection + 25s cap only for News |
| `lib/assembly.js` | 2207-2276 | NBA voiceover mixing block |
| `lib/publish.js` | 283, 299, 485 | Platform metadata branching + duplicate branch bug |
| `server.js` | 478 | Scene name assumptions in card routing |
| `server.js` | 4782 | Twitch-only intro card generation |

### LOW severity

| File | Issue |
|------|-------|
| `cwn_production.html` | Hardcoded nav buttons per type |
| `cwn_production.html` | Hardcoded CSS class names per type |
| `server.js` | Enum validation hardcodes type names in error message |

---

## What Aider Should Produce

### 1. Verify and extend the audit
- Confirm each violation above exists at the stated lines (lines may have shifted)
- Find any additional violations not listed
- Note if any listed violations are already fixed

### 2. Propose the CONFIG strategy

The fix pattern is: replace `if (contentType === 'X')` branches with `CONFIG.CONTENT_TYPES[contentType].setting`.

For each HIGH severity item, propose the exact CONFIG structure. Example:

```javascript
// Instead of:
if (type === 'twitch') expectedScenes = 1 + streamers * 7 + 1;
else if (type === 'nba') expectedScenes = 1 + games * 3 + 1;

// Use:
CONFIG.SCENE_STRUCTURE = {
  twitch: { intro: 1, perItem: 7, outro: 1 },
  nba:    { intro: 1, perItem: 3, outro: 1 },
  news:   { intro: 1, perItem: 4, outro: 1 }
};
// Then: const s = CONFIG.SCENE_STRUCTURE[type]; expectedScenes = s.intro + items.length * s.perItem + s.outro;
```

### 3. Identify the universal item shape

Both Twitch and News call `callFullScriptServer(type, items, ...)`. The items array shape differs per type. Propose a normalized item schema that works for all types:

```javascript
{
  id:          string,   // clipId, gameId, storyUrl
  title:       string,
  description: string,
  videoUrl:    string,   // primary clip URL
  thumbnailUrl:string,
  duration:    number,   // seconds
  metadata:    object    // type-specific extras (streamer name, teams, etc.)
}
```

Verify this shape works for Twitch clips, NBA games, and News stories. Note any gaps.

### 4. Migration order

Sequence the refactor so each step is independently deployable without breaking the running pipeline. Propose phases:

- Phase 1: Centralize CONFIG (lowest risk, no logic changes)
- Phase 2: Normalize item shapes at entry points
- Phase 3: Replace QA checklists with config-driven rules
- Phase 4: Replace assembly branching with strategy functions
- Phase 5: Frontend universal generate flow

---

## Output Format

Write findings to: `docs/architecture/UNIVERSAL_CONTENT_ARCHITECTURE.md`

Structure:
1. Audit results (verified violations with current line numbers)
2. New violations found
3. Proposed CONFIG structures for HIGH items
4. Universal item shape proposal
5. Migration phases with file + function targets

Do not modify any production files. Read-only audit + spec writing only.
