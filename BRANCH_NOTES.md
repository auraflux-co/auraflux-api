# Branch Notes — cline-b/publish-copy-rewrite

**Agent:** Cline-B (Claude Sonnet)
**Branch:** `cline-b/publish-copy-rewrite`
**Date opened:** 2026-04-15
**Status:** 🟡 READY — 1 task, lib/publish.js only

---

## CRITICAL — Shell rule

**Every grep/find/rg/ls must end with `|| true`. No exceptions.**

---

## Context

Rob uses ChatGPT instead of /generate-publish-copy because the output is too generic.
Root problems: script truncated to 600 chars, only 1 title option, no streamer URLs,
tags and hashtags conflated, no playlist description, no thumbnail text ideas, 1000 token limit.

The endpoint is in `lib/publish.js` NOT server.js (module split moved it).

---

## TASK — Rewrite handleGeneratePublishCopy in lib/publish.js

**Find the function:**
```bash
grep -n "handleGeneratePublishCopy\|scriptExcerpt\|max_tokens" lib/publish.js || true
```

**5 specific changes — all in lib/publish.js:**

### 1. Update destructure (~line 409) — add episodeNumber and chapters
```javascript
const { contentType, formType, script, date, streamers = [], items = [], platforms = ['youtube'], episodeNumber, chapters } = req.body;
```

### 2. Remove 600-char truncation (~line 415)
```javascript
// BEFORE:
const scriptExcerpt = script.substring(0, 600);
// AFTER:
const scriptExcerpt = script.length > 4000 ? script.substring(0, 4000) : script;
```

### 3. Add channelConfig block after the existing newsHeadlines/gameMatchups blocks
```javascript
const SHOW_NAMES = { twitch: 'Twitch Soup', nba: 'Other Side of the Pillow', news: 'Because the Light Was On' };
const channelConfig = {
  showName: SHOW_NAMES[contentType] || 'ClipzWorld News',
  host: 'Bobby G',
  handle: '@clipzworldnews',
  uploadFrequency: 'every other day',
  disclaimer: 'All content belongs to respective creators. Used for entertainment and highlight purposes.'
};
const epLabel = episodeNumber ? ` #${episodeNumber}` : '';
const chaptersBlock = chapters ? `⏱️ TIMESTAMPS\n${chapters}` : `⏱️ TIMESTAMPS\n[Add accurate timestamps after export]`;
```

### 4. Replace system prompt to ask for 5 titles, tags vs hashtags, playlist desc, thumbnail ideas
The new system prompt should instruct Claude to return JSON with:
- `youtube.titles` — array of 5 title options (not a single title)
- `youtube.description` — full description with streamer links for Twitch, story/game list for news/NBA, chaptersBlock verbatim, disclaimer
- `youtube.tags` — 15-25 lowercase keyword phrases, NO # symbol (backend algorithm)
- `youtube.hashtags` — 5-8 tags WITH # prefix (visible in description)
- `youtube.pinnedComment` — engagement question
- `youtube.playlistDescription` — series pitch
- `youtube.thumbnailTextIdeas` — 5 short punchy options
- `tiktok.caption` and `instagram.caption` unchanged

Pass scriptExcerpt, channelConfig, epLabel, chaptersBlock, and items data into the prompt context.

### 5. Update max_tokens and add backward-compat shim (~line 562)
```javascript
// Change:
max_tokens: 1000,
// To:
max_tokens: 2500,
```

After parsing the JSON response, add:
```javascript
// Backward-compat: populate youtube.title as titles[0] for old dashboard code
if (metadata.youtube?.titles?.length > 0) {
  metadata.youtube.title = metadata.youtube.titles[0];
}
```

**Commit:** `feat(publish-copy): 5 titles + full script + tags vs hashtags + playlist desc + thumbnail ideas`

---

## Log

| Time | Entry |
|------|-------|
| 2026-04-15 EOD | Branch opened. All changes in lib/publish.js. |
