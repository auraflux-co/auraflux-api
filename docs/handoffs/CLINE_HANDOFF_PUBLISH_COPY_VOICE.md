# CLINE HANDOFF: Publish Copy — Inject CWN Brand Voice into All 3 Content Type Prompts

**→ Agent: Cline-C**
**Priority:** HIGH — Rob currently uses ChatGPT for publish copy instead of `/generate-publish-copy` because the output sounds generic. This fix makes the endpoint worth using.
**Size:** S (1 file, ~60 lines changed, `lib/publish.js`)
**Status:** READY — no dependencies

---

## Background — Read This First

`/generate-publish-copy` generates YouTube titles, descriptions, hashtags, TikTok captions, and
Instagram captions for each finished video. It supports 3 content types × 2 form types = 6 combinations:

| Content Type | Form | Show Name | Bobby G sign-off |
|---|---|---|---|
| `news` | long-form | BECAUSE THE LIGHT WAS ON | "I'm Bobby G. See you tomorrow." |
| `nba` | long-form | OTHER SIDE OF THE PILLOW | "I'm Bobby G. See you tomorrow." |
| `twitch` | long-form | TALK SOUP | "I'm Bobby G. See you tomorrow." |
| `news-short` | short-form | — | "Subscribe. Appreciate you." |
| `nba-short` | short-form | — | "Subscribe. Appreciate you." |
| `twitch-short` | short-form | — | "Subscribe. Appreciate you." |

**Why the output is generic today:** The prompts ask Claude to write platform metadata but give
no show identity, no voice rules, and no CWN-specific language. Claude defaults to generic
YouTube channel copy. The fix is injecting the show name, Bobby G persona, and platform-specific
CWN language into every prompt.

**Bobby G voice rules (apply to all descriptions and captions):**
- Flat, dry delivery — no "incredible", "amazing", "insane", "wild", "crazy"
- Short declarative sentences — state the fact, done
- Never explain the joke — let the clip speak
- Always reference the correct show name for the content type
- YouTube description ends with: "I'm Bobby G. See you tomorrow. — ClipzWorld News"
- Short-form captions end with: "Subscribe. Appreciate you."
- Channel handle: `@clipzworldnews` (not `@clipznashite` — that handle in the current code is wrong)

---

## File to Change

**`lib/publish.js` only.** Do not touch `server.js`, `lib/qa.js`, `lib/assembly.js`, or any other file.

**Step 0 — Create your branch:**
```bash
git checkout main && git pull && git checkout -b cline-c/publish-copy-voice
```

**Find the prompts object:**
```bash
grep -n "const prompts\|nba:\|news:\|twitch:\|Generate publish metadata" lib/publish.js || true
```
Expected: around line 420, a `const prompts = { nba: ..., news: ..., twitch: ... }` object
inside `handleGeneratePublishCopy()`.

---

## Change 1 — Fix wrong channel handle in system prompt

**Find (~line 526):**
```javascript
const systemPrompt = `You generate multi-platform publish metadata for ClipzWorld News (@clipznashite).
```

**Replace with:**
```javascript
const systemPrompt = `You generate multi-platform publish metadata for ClipzWorld News (@clipzworldnews).
```

---

## Change 2 — Replace all three content type prompts

Find the entire `const prompts = { ... }` block (from `const prompts = {` through the closing `};`
around line 523). Replace it entirely with:

```javascript
  // Per-show voice identity injected into every prompt.
  // Bobby G voice rules: flat/dry delivery, short sentences, never explain the joke,
  // always use correct show name, correct sign-off per form type.
  const showName = { nba: 'OTHER SIDE OF THE PILLOW', news: 'BECAUSE THE LIGHT WAS ON', twitch: 'TALK SOUP' }[contentType] || 'BECAUSE THE LIGHT WAS ON';
  const signOff  = isShort ? 'Subscribe. Appreciate you.' : "I'm Bobby G. See you tomorrow. — ClipzWorld News";
  const voiceRules = `
VOICE RULES — ClipzWorld News / Bobby G:
- Show name for this video: "${showName}" on ClipzWorld News
- Host: Bobby G — dry, flat delivery. Sounds like Jon Stewart crossed with Norm MacDonald.
- Never use: "incredible", "amazing", "insane", "wild", "crazy", "epic", "unbelievable"
- Short declarative sentences. State the fact. Move on.
- Never explain the joke. Let the content speak.
- YouTube descriptions end with exactly: "${signOff}"
- TikTok/Instagram captions end with exactly: "${isShort ? 'Subscribe. Appreciate you.' : "Bobby G. @clipzworldnews"}"
- Channel: @clipzworldnews (not @clipznashite)`;

  const prompts = {
    nba: `Generate publish metadata for "${showName}" — a ClipzWorld News NBA highlights ${isShort ? 'Short' : 'compilation'}.
${voiceRules}

Date: ${date}
Script excerpt (Bobby G's actual words — use the tone and specific games/players mentioned):
${scriptExcerpt}...

Generate metadata for: ${platforms.join(', ')}

${needsYouTube ? `
**YOUTUBE:**
- Title: ${isShort ? '50-80' : '60-100'} chars. Lead with the most compelling matchup or moment from the script. Include at least one team name. No generic phrases like "Best Moments" or "Highlights Compilation".
- Description: ${isShort ? '80-120 words' : '150-250 words'}. Open with the games covered. Specific scores/moments from the script if available. One line per game. End with exactly: "${signOff}"
- Hashtags: ${isShort ? '10-15' : '5-8'} tags. Always include: #NBA, #OtherSideOfThePillow, #ClipzWorldNews. Add team-specific tags from the script.
- Pinned Comment: One dry, specific question about a moment from the script. Not "which was your favorite?" — something more specific like "was that foul even close?"
` : ''}
${needsTikTok ? `
**TIKTOK:**
- Caption: 90-150 chars. Lead with the most absurd/surprising moment from the script. Include #NBA and #ClipzWorldNews. End with: "Subscribe. Appreciate you."
- Tone: dry and deadpan, not hype
` : ''}
${needsInstagram ? `
**INSTAGRAM:**
- Caption: Open with a dry one-liner from the script (or inspired by it). Max 2200 chars. Line breaks between thoughts.
- End with: "Bobby G. @clipzworldnews"
- 10-15 hashtags on the last line: #NBA #OtherSideOfThePillow #ClipzWorldNews #Reels #Explore + team tags
` : ''}

Output as JSON:
{
  ${needsYouTube ? '"youtube": { "title": "...", "description": "...", "hashtags": [...], "pinnedComment": "..." },' : ''}
  ${needsTikTok ? '"tiktok": { "caption": "..." },' : ''}
  ${needsInstagram ? '"instagram": { "caption": "..." }' : ''}
}`,

    news: `Generate publish metadata for "${showName}" — a ClipzWorld News world news ${isShort ? 'Short' : 'compilation'}.
${voiceRules}

Date: ${date}
Script excerpt (Bobby G's actual words — use the tone and specific stories mentioned):
${scriptExcerpt}...

Generate metadata for: ${platforms.join(', ')}

${needsYouTube ? `
**YOUTUBE:**
- Title: ${isShort ? '50-80' : '60-100'} chars. Lead with the most urgent story from the script. Specific — name the country, leader, or event. No generic "Today's Top News" phrases.
- Description: ${isShort ? '80-120 words' : '150-250 words'}. One sentence per story covered. Specific details from the script. End with exactly: "${signOff}"
- Hashtags: ${isShort ? '10-15' : '5-8'} tags. Always include: #News, #BecauseTheLightWasOn, #ClipzWorldNews. Add topic-specific tags from the stories covered.
- Pinned Comment: One dry question about the most divisive story in the script. Specific to what Bobby G said.
` : ''}
${needsTikTok ? `
**TIKTOK:**
- Caption: 90-150 chars. Open with the most urgent story in one dry sentence. Include #News and #ClipzWorldNews. End with: "Subscribe. Appreciate you."
- Tone: news anchor, not alarmist
` : ''}
${needsInstagram ? `
**INSTAGRAM:**
- Caption: Open with a specific headline from the script. One story per paragraph. Max 2200 chars.
- End with: "Bobby G. @clipzworldnews"
- 10-15 hashtags on the last line: #News #WorldNews #BecauseTheLightWasOn #ClipzWorldNews #Reels + topic tags
` : ''}

Output as JSON:
{
  ${needsYouTube ? '"youtube": { "title": "...", "description": "...", "hashtags": [...], "pinnedComment": "..." },' : ''}
  ${needsTikTok ? '"tiktok": { "caption": "..." },' : ''}
  ${needsInstagram ? '"instagram": { "caption": "..." }' : ''}
}`,

    twitch: `Generate publish metadata for "${showName}" — a ClipzWorld News Twitch clips ${isShort ? 'Short' : 'compilation'}.
${voiceRules}

Date: ${date}
Streamers featured: ${streamers.join(', ') || 'Multiple streamers'}
Script excerpt (Bobby G's actual words — use the tone and specific moments mentioned):
${scriptExcerpt}...

Generate metadata for: ${platforms.join(', ')}

${needsYouTube ? `
**YOUTUBE:**
- Title: ${isShort ? '50-80' : '60-100'} chars. Lead with the funniest or most surprising moment. Use display names (Jason, Hasan, Ron, Jay Cinco — NOT Twitch usernames). No generic "Best Clips" phrases.
- Description: ${isShort ? '80-120 words' : '150-250 words'}. One sentence per streamer with what happened. Include Twitch links if streamer usernames are known from context. End with exactly: "${signOff}"
- Hashtags: ${isShort ? '10-15' : '5-8'} tags. Always include: #Twitch, #TalkSoup, #ClipzWorldNews. Add streamer-specific tags.
- Pinned Comment: One dry question about the most absurd moment. Specific to what Bobby G said about a specific clip.
` : ''}
${needsTikTok ? `
**TIKTOK:**
- Caption: 90-150 chars. Lead with the most absurd clip moment in one dry sentence. Use streamer display names. Include #Twitch and #ClipzWorldNews. End with: "Subscribe. Appreciate you."
- Tone: dry commentary, not gaming hype
` : ''}
${needsInstagram ? `
**INSTAGRAM:**
- Caption: Open with a dry one-liner about the funniest clip. One streamer per paragraph. Max 2200 chars.
- End with: "Bobby G. @clipzworldnews"
- 10-15 hashtags on the last line: #Twitch #TalkSoup #ClipzWorldNews #Reels + streamer tags
` : ''}

Output as JSON:
{
  ${needsYouTube ? '"youtube": { "title": "...", "description": "...", "hashtags": [...], "pinnedComment": "..." },' : ''}
  ${needsTikTok ? '"tiktok": { "caption": "..." },' : ''}
  ${needsInstagram ? '"instagram": { "caption": "..." }' : ''}
}`
  };
```

---

## Change 3 — Update system prompt to reference correct show name

**Find (~line 526, right after the prompts object closing `};`):**
```javascript
  const systemPrompt = `You generate multi-platform publish metadata for ClipzWorld News (@clipzworldnews).

${prompts[contentType] || prompts.twitch}

STRICT RULES:
- YouTube titles: max 100 chars (hard limit)
- TikTok captions: optimal 90-150 chars for engagement (max 2200)
- Instagram captions: hook in first 125 chars (gets truncated)
- All platforms: include "ClipzWorld News" or "@clipznashite" mention
- Hashtags: platform-appropriate (#Shorts for YouTube, #FYP for TikTok, #Reels for Instagram)
- Output ONLY valid JSON, no markdown code blocks, no explanation
- Use double quotes for all JSON strings`;
```

**Replace with:**
```javascript
  const systemPrompt = `You generate multi-platform publish metadata for ClipzWorld News (@clipzworldnews).
Show: "${showName}". Host: Bobby G.

${prompts[contentType] || prompts.twitch}

STRICT RULES:
- YouTube titles: max 100 chars (hard limit)
- TikTok captions: optimal 90-150 chars for engagement (max 2200)
- Instagram captions: hook in first 125 chars (gets truncated)
- All platforms: use @clipzworldnews (not @clipznashite)
- Hashtags: platform-appropriate (#Shorts for YouTube Shorts, #FYP for TikTok, #Reels for Instagram)
- Output ONLY valid JSON, no markdown code blocks, no explanation
- Use double quotes for all JSON strings
- Apply Bobby G voice rules above — no hype words, dry tone, specific details from the script`;
```

---

## Files to Change

| File | What Changes |
|------|-------------|
| `lib/publish.js` | Fix `@clipznashite` → `@clipzworldnews`. Replace `const prompts` object with voice-injected version. Update system prompt. |

**No other files.** Do not touch `server.js`, `lib/qa.js`, `lib/assembly.js`, `cwn_production.html`.

---

## Verification

```bash
node -c lib/publish.js && echo "syntax OK"
```

Confirm wrong handle is gone:
```bash
grep -n "clipznashite" lib/publish.js || true
```
Expected: zero matches.

Confirm voice rules are present:
```bash
grep -n "showName\|voiceRules\|Bobby G\|TALK SOUP\|OTHER SIDE\|BECAUSE THE LIGHT" lib/publish.js || true
```
Expected: multiple matches across all three content type prompts.

---

## Pre-Commit Checklist

- [ ] You are on branch `cline-c/publish-copy-voice` — confirm with `git branch`
- [ ] `node -c lib/publish.js && echo "OK"` passes
- [ ] `grep -n "clipznashite" lib/publish.js || true` returns zero matches
- [ ] `STATUS.md → 🤖 Last Agent Action` updated
- [ ] No `.env`, `output/`, `tmp/`, `data/jobs.json` staged
- [ ] Commit message: `feat(publish): inject CWN brand voice into all 3 content type publish copy prompts`
- [ ] Tell Rob the branch is ready — do not merge to main yourself
