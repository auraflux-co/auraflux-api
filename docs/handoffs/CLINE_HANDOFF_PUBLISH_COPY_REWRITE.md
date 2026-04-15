# CLINE_HANDOFF_PUBLISH_COPY_REWRITE.md
→ Agent: Cline-A

**Author:** Claude Code, 2026-04-14  
**Size:** M — server.js only, Tier 1  
**Spec:** Read `PUBLISH_COPY_SPEC.md` before starting. That doc is the canonical quality reference.  
**Canonical output example:** The ChatGPT Twitch Soup #1 description in `PUBLISH_COPY_SPEC.md`.  
**1 commit.**

---

## What's Wrong Today

`/generate-publish-copy` at `server.js:8761`:

1. Truncates script to 600 chars (`server.js:8776` — `script.substring(0, 600)`) — not enough context
2. Generates 1 title — should be 5 options
3. Never loads `data/streamers.json` — so Twitch URLs are never in the description
4. Conflates YouTube hashtags (description display `#Tag`) with YouTube tags (backend keyword field, no `#`) — two separate things
5. No playlist description generated
6. No thumbnail text ideas generated
7. No show identity line, no host credit, no disclaimer, no upload frequency
8. No episode number passed in or used
9. Chapters string (`buildYouTubeChapters()` output) not passed to the prompt — Claude guesses timestamps instead of using real ones
10. `channelConfig` not wired — show name hardcoded nowhere, just omitted

---

## New Inputs Required

### 1. Update the endpoint destructure at `server.js:8771`

**Current:**
```javascript
const { contentType, formType, script, date, streamers = [], platforms = ['youtube'] } = req.body;
```

**Target:**
```javascript
const { contentType, formType, script, date, streamers = [], platforms = ['youtube'], episodeNumber, chapters } = req.body;
```

### 2. Load streamer roster at top of endpoint (after destructure)

Add immediately after the destructure line:

```javascript
  // Load streamer roster from data/streamers.json for Twitch URL generation
  let streamerRoster = [];
  try {
    const rosterData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/streamers.json'), 'utf8'));
    streamerRoster = (rosterData.roster || []).filter(s =>
      streamers.some(name => name.toLowerCase() === (s.displayName || s.onAirName || '').toLowerCase() ||
                             name.toLowerCase() === (s.twitchUsername || '').toLowerCase())
    );
  } catch(e) {
    console.warn('[publish-copy] Could not load streamers.json:', e.message);
  }
```

### 3. Build CWN channel config (hardcoded for now)

Add immediately after the streamerRoster block:

```javascript
  // CWN channel config — hardcoded until AuraFlux customer profiles exist
  // See PLATFORM_ARCHITECTURE.md for the customer-configurable version
  const SHOW_NAMES = { twitch: 'Twitch Soup', nba: 'Other Side of the Pillow', news: 'Because the Light Was On' };
  const channelConfig = {
    showName:        SHOW_NAMES[contentType] || 'ClipzWorld News',
    channelName:     'ClipzWorld News',
    handle:          '@clipznashite',
    host:            'Bobby G',
    uploadFrequency: 'every other day',
    niche:           contentType === 'twitch' ? 'Twitch clips & gaming' : contentType === 'nba' ? 'NBA highlights & reaction' : 'world news reaction',
    tone:            'funny, deadpan, unfiltered — Jon Stewart + Norm MacDonald energy',
    disclaimer:      'All content belongs to respective creators. Used for entertainment and highlight purposes.',
    userType:        'curator'
  };
```

### 4. Remove the 600-char truncation

**Current (`server.js:8776`):**
```javascript
  const scriptExcerpt = script.substring(0, 600);
```

**Target:**
```javascript
  // Use full script — Claude needs full context for accurate hook extraction and timestamps
  const scriptExcerpt = script.length > 4000 ? script.substring(0, 4000) : script;
```

---

## New Prompt Structure

Replace the entire `prompts` object (`server.js:8782–8931`) and `systemPrompt` (`server.js:8933–8944`) with the following.

**Current block starts at:** `const prompts = {` (line 8782)  
**Current block ends at:** the closing `};` of the `prompts` object (line 8931), then `const systemPrompt = ...` through line 8944.

**Replace everything from `const prompts = {` through the closing backtick of systemPrompt with:**

```javascript
  // Build streamer credits block for Twitch descriptions
  const streamerCredits = streamerRoster.length > 0
    ? streamerRoster.map(s => `${s.displayName || s.onAirName}\nhttps://www.twitch.tv/${s.twitchUsername}`).join('\n')
    : streamers.map(name => name).join('\n');

  // Build episode label
  const epLabel = episodeNumber ? ` #${episodeNumber}` : '';

  // Use pre-built chapters if passed in, otherwise note they need timestamps
  const chaptersBlock = chapters
    ? `⏱️ TIMESTAMPS\n${chapters}`
    : `⏱️ TIMESTAMPS\n[Add accurate timestamps after export]`;

  const contentDescriptors = {
    twitch: { noun: 'Twitch clips compilation', adjective: 'funniest', hookVerb: 'streamer moment', tags: 'twitch clips, funny twitch clips, twitch highlights, twitch fails, streamer fails, viral twitch clips, gaming funny moments, twitch compilation, best twitch clips 2026, twitch trending, livestream fails, twitch reaction' },
    nba:    { noun: 'NBA highlights reaction', adjective: 'biggest', hookVerb: 'game moment', tags: 'nba highlights, nba reaction, nba clips, basketball highlights, nba today, nba game recap, nba funny moments, best nba plays 2026, nba scores' },
    news:   { noun: 'world news reaction', adjective: 'most important', hookVerb: 'news story', tags: 'world news, news reaction, breaking news, daily news, news today, world news 2026, news highlights, news commentary' }
  };
  const cd = contentDescriptors[contentType] || contentDescriptors.twitch;

  const systemPrompt = `You are an expert YouTube SEO copywriter for ${channelConfig.channelName} (${channelConfig.handle}), hosted by ${channelConfig.host}.

SHOW: "${channelConfig.showName}${epLabel}" — ${channelConfig.niche}
TONE: ${channelConfig.tone}
UPLOAD FREQUENCY: ${channelConfig.uploadFrequency}
DATE: ${date}
EPISODE: ${episodeNumber ? `#${episodeNumber}` : 'unnumbered'}
CONTENT TYPE: ${contentType} ${isShort ? 'Short' : 'long-form episode'}

FULL SCRIPT (use this for hook extraction and content understanding):
${scriptExcerpt}

${contentType === 'twitch' && streamerCredits ? `FEATURED STREAMERS WITH LINKS (include ALL of these in the description exactly as formatted):
${streamerCredits}` : ''}

${contentType === 'nba' ? `GAMES COVERED: ${streamers.join(', ') || 'NBA games'}` : ''}
${contentType === 'news' ? `STORIES COVERED: ${streamers.join(', ') || 'World news stories'}` : ''}

PRE-BUILT TIMESTAMPS (embed these verbatim in the description — do NOT make up timestamps):
${chaptersBlock}

YOUR TASK: Generate a complete YouTube publish package. Output ONLY valid JSON with this exact structure:

{
  "hookMoment": "The single most compelling/funniest/surprising moment from the script in 8-12 words",
  "youtube": {
    "titles": [
      "Option 1: [HOOK MOMENT in CAPS emotion verb] 😂 | ${channelConfig.showName}${epLabel}",
      "Option 2: Funniest [content descriptor] 😂 | ${channelConfig.channelName}",
      "Option 3: Curiosity/intrigue hook starting with 'You Won't Believe...' or 'This [streamer/player/story]...'",
      "Option 4: Keyword-first SEO title starting with content type keywords",
      "Option 5: ${channelConfig.showName}${epLabel} | ${channelConfig.channelName} 🎮"
    ],
    "description": "FULL description following this EXACT structure with these EXACT sections in order:\\n\\nWelcome to ${channelConfig.showName} by ${channelConfig.channelName} [emoji] — [one-line show pitch matching tone]\\n\\nIn today's episode, [hook moment] [emoji] plus [N] more [adjective] moments!\\n\\n[chaptersBlock verbatim]\\n\\n[For Twitch: 🎮 Featured Streamers (Support Them! 💜)\\n${streamerCredits || '[streamer list]'}]\\n[For NBA: 🏀 Tonight's Games\\n[game summaries]]\\n[For News: 📰 Stories Covered\\n[story list]]\\n\\n[emoji] What You'll See:\\n[4 bullet points from actual script content]\\n\\n🚀 Subscribe for [frequency] content\\n${channelConfig.ctaSubscribe || 'Subscribe & turn on notifications 🔔'}\\n\\n📅 New videos ${channelConfig.uploadFrequency}!\\n\\n🎤 Hosted by: ${channelConfig.host}\\n\\n${channelConfig.userType === 'curator' ? '📢 Disclaimer: ' + channelConfig.disclaimer : ''}\\n\\n🔥 Hashtags: [5-8 description hashtags]",
    "tags": ["15-25 lowercase keyword phrases no hash symbol — specific streamer/team/story names first then broad terms like: ${cd.tags}"],
    "hashtags": ["#DisplayHashtag format", "5-8 tags", "for description display only"],
    "pinnedComment": "Engagement question referencing something specific from the episode",
    "playlistDescription": "Welcome to ${channelConfig.showName} by ${channelConfig.channelName} [emoji] — [series pitch]. This playlist features: [4 bullet points]. [Broad appeal line]. 🔥 Updated [frequency] with the best [content type] content!",
    "thumbnailTextIdeas": ["SHORT PUNCHY TEXT 😂", "4-6 words max", "emotion-driven", "referencing hook moment", "5 options total"]
  },
  "tiktok": {
    "caption": "90-150 char hook with 4-6 hashtags mixed in naturally, emojis, ends with micro-CTA"
  },
  "instagram": {
    "caption": "Hook in first 125 chars then full description with line breaks then 10-15 hashtags at end"
  }
}

RULES:
- titles: exactly 5 options, each under 100 chars, each with 1 emoji, each referencing something SPECIFIC from the script
- description: must include ALL sections listed above in order — do not skip any
- tags: lowercase, no # symbol, 15-25 items, comma-separated in array
- hashtags: # prefix, display format, 5-8 items, these go IN the description
- tags and hashtags are DIFFERENT — tags are YouTube backend algorithm keywords, hashtags are visible in description
- thumbnailTextIdeas: exactly 5 options, 4-6 words max each, all caps, emotion-driven
- Output ONLY valid JSON, no markdown fences, no explanation outside the JSON`;
```

---

## Update the Claude API Call

The model reference at `server.js:~8960` may say `claude-sonnet-4-20250514`. Update to current model and increase max_tokens:

**Current:**
```javascript
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
```

**Target:**
```javascript
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
```

2500 tokens needed — the full description with all sections is longer than the old 1000-token output.

---

## Update the Response Shape

The response parser at `server.js:~8976` extracts `metadata` from the JSON. The shape has changed — `youtube.title` is now `youtube.titles[]`. Update the response forwarding so the dashboard gets both:

Find the `res.json(metadata)` or equivalent response send near the end of the endpoint. Before sending, add backward-compat shim:

```javascript
    // Backward-compat: dashboard may read metadata.youtube.title (singular)
    // Add it as the first title option so old code doesn't break
    if (metadata.youtube && Array.isArray(metadata.youtube.titles) && metadata.youtube.titles.length > 0) {
      metadata.youtube.title = metadata.youtube.titles[0];
    }
```

---

## Update the Gate 6 Auto-Publish Call

At `server.js:5225` the auto-publish path calls `/generate-publish-copy`. It needs to pass the new fields:

**Current:**
```javascript
              const publishCopyResp = await axios.post(
                `http://localhost:${process.env.PORT || 3000}/generate-publish-copy`,
                {
                  contentType: contentType || 'twitch',
                  formType: (contentType && contentType.includes('-short')) ? 'short' : 'compilation',
                  script: fullScript || assemblyJobs[asmId].fullScript || '',
                  date: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
                  streamers: req.body.streamers || [],
                  platforms: (process.env.AUTO_PUBLISH_PLATFORMS || 'youtube').split(',').map(p => p.trim())
                },
```

**Target:**
```javascript
              const publishCopyResp = await axios.post(
                `http://localhost:${process.env.PORT || 3000}/generate-publish-copy`,
                {
                  contentType: contentType || 'twitch',
                  formType: (contentType && contentType.includes('-short')) ? 'short' : 'compilation',
                  script: fullScript || assemblyJobs[asmId].fullScript || '',
                  date: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
                  streamers: req.body.streamers || [],
                  platforms: (process.env.AUTO_PUBLISH_PLATFORMS || 'youtube').split(',').map(p => p.trim()),
                  episodeNumber: req.body.episodeNumber || null,
                  chapters: chapterText || null
                },
```

---

## Verification

```bash
node -c server.js

# Test endpoint directly with a minimal payload
curl -s -X POST http://localhost:3000/generate-publish-copy \
  -H "Content-Type: application/json" \
  -d '{
    "contentType": "twitch",
    "formType": "compilation",
    "script": "Bobby G here. Jason got completely humbled today talking about his fighting experience. [beat] Hasan had thoughts. [beat] Adapt showed up. [beat] Good episode.",
    "date": "Tuesday, April 14, 2026",
    "streamers": ["Jason", "Hasan", "Adapt"],
    "episodeNumber": 1,
    "platforms": ["youtube"]
  }' | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const j=JSON.parse(d); console.log('titles:', j.youtube?.titles?.length, 'titles'); console.log('title[0]:', j.youtube?.titles?.[0]); console.log('tags count:', j.youtube?.tags?.length); console.log('thumbnailTextIdeas:', j.youtube?.thumbnailTextIdeas?.length); console.log('playlistDescription length:', j.youtube?.playlistDescription?.length);"
```

Expected output:
```
titles: 5 titles
title[0]: [something specific about fighting experience]
tags count: 15+ 
thumbnailTextIdeas: 5
playlistDescription length: 200+
```

---

## Commit Message

```
feat(publish-copy): rewrite /generate-publish-copy for SEO-quality output

Previous output was too short, had 1 generic title, no streamer URLs,
conflated tags with hashtags, and had no playlist description or thumbnail
text ideas. Canonical reference: ChatGPT Twitch Soup #1 session (PUBLISH_COPY_SPEC.md).

Changes:
- Full script passed (was truncated to 600 chars)
- data/streamers.json loaded — Twitch URLs included in description
- channelConfig object: show name per content type, host, handle, disclaimer
- 5 title options (was 1) — hook moment, keyword-first, curiosity, SEO, brand
- YouTube tags (backend keywords) separated from hashtags (description display)
- Playlist description added
- Thumbnail text ideas added (5 options)
- Pre-built chapters string passed through verbatim — no timestamp guessing
- episodeNumber passed in and used in titles + show name
- Backward-compat: youtube.title still populated as titles[0]
- max_tokens: 1000 → 2500 to fit full description
- Gate 6 auto-publish call updated to pass episodeNumber + chapters

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## Ship Order

```
node -c server.js (verify clean start)
→ make all changes
→ node -c server.js
→ curl test above
→ git add server.js STATUS.md && git commit
→ push
```
