# HeyGen Script Format & Scene Directions

**Last Updated**: 2026-04-07
**For**: CWN Production Video Generation
**HeyGen Integration**: Bobby G Avatar

---

## 📖 Overview

Claude generates the script → Gemini QA validates → HeyGen produces video

**Script Generation Flow**:
1. Claude AI generates script based on content type + clips
2. Gemini QA scores script (10-point checklist)
3. If score ≥90: Auto-proceed to HeyGen
4. If score 70-89: Manual review required
5. If score <70: Regenerate (max 3 retries)

---

## 🎬 Shot Titles by Content Type

### Twitch Long Form (8-12 min)
**Format**: 3 streamers × 3 clips each = 9 total clips

**Shot Structure**:
1. **INTRO** - Bobby G opens the video (15-20s)
2. **INTRO_{STREAMER_1}** - Introduce first streamer (20-25s)
3. **CLIP_1** - Setup → [CLIP PLAYS HERE] → Reaction (40-50s)
4. **CLIP_2** - Setup → [CLIP PLAYS HERE] → Reaction (40-50s)
5. **CLIP_3** - Setup → [CLIP PLAYS HERE] → Reaction (40-50s)
6. **INTRO_{STREAMER_2}** - Introduce second streamer (20-25s)
7. **CLIP_4** - Setup → [CLIP PLAYS HERE] → Reaction (40-50s)
8. **CLIP_5** - Setup → [CLIP PLAYS HERE] → Reaction (40-50s)
9. **CLIP_6** - Setup → [CLIP PLAYS HERE] → Reaction (40-50s)
10. **INTRO_{STREAMER_3}** - Introduce third streamer (20-25s)
11. **CLIP_7** - Setup → [CLIP PLAYS HERE] → Reaction (40-50s)
12. **CLIP_8** - Setup → [CLIP PLAYS HERE] → Reaction (40-50s)
13. **CLIP_9** - Setup → [CLIP PLAYS HERE] → Reaction (40-50s)
14. **OUTRO** - Bobby G closes with CTA (15-20s)

**Total Duration**: ~600-700 seconds (10-12 minutes)

---

### NBA Long Form (8-12 min)
**Format**: Full game coverage with highlights

**Shot Structure**:
1. **INTRO** - Bobby G opens with game preview (20-25s)
2. **PRE_GAME** - Teams, records, matchup analysis (30-40s)
3. **QUARTER_1** - Q1 highlights setup → [CLIP PLAYS HERE] → Reaction (60-80s)
4. **QUARTER_2** - Q2 highlights setup → [CLIP PLAYS HERE] → Reaction (60-80s)
5. **HALFTIME** - Halftime stats and analysis (30-40s)
6. **QUARTER_3** - Q3 highlights setup → [CLIP PLAYS HERE] → Reaction (60-80s)
7. **QUARTER_4** - Q4 highlights setup → [CLIP PLAYS HERE] → Reaction (60-80s)
8. **POST_GAME** - Final score, standout performances (40-50s)
9. **OUTRO** - Bobby G wraps up with CTA (15-20s)

**Total Duration**: ~600-700 seconds (10-12 minutes)

---

### News Long Form (8-12 min)
**Format**: In-depth story breakdown + reaction

**Shot Structure**:
1. **INTRO** - Bobby G introduces the story (20-25s)
2. **CONTEXT** - Background, why it matters (60-80s)
3. **BREAKDOWN_PART_1** - First key point → [CLIP PLAYS HERE] → Reaction (90-120s)
4. **BREAKDOWN_PART_2** - Second key point → [CLIP PLAYS HERE] → Reaction (90-120s)
5. **BREAKDOWN_PART_3** - Third key point → [CLIP PLAYS HERE] → Reaction (90-120s)
6. **ANALYSIS** - Bobby G's take, implications (60-80s)
7. **OUTRO** - Bobby G wraps with CTA (15-20s)

**Total Duration**: ~600-700 seconds (10-12 minutes)

---

### Short Form (All Content Types, 60s)
**Format**: Compressed single-clip format

**Shot Structure**:
1. **HOOK** - Attention-grabbing opener (5-8s)
2. **SETUP** - Quick context (10-15s)
3. **CLIP** - [CLIP PLAYS HERE] (20-30s)
4. **REACTION** - Bobby G reacts + CTA (10-15s)

**Total Duration**: ~60 seconds (TikTok/Insta/YouTube Shorts)

---

## 📝 Script Format Requirements

### Locked Elements (MUST INCLUDE)

**INTRO Line** (Exact Format):
```
What is up ClipzWorld, we got [CONTENT DESCRIPTION] today!
```

**OUTRO Line** (Exact Format):
```
Appreciate you! Subscribe for more [CONTENT TYPE] every [SCHEDULE]. Peace.
```

### Markers & Formatting

**Clip Markers**:
- Use `[beat]` before and after every `[CLIP PLAYS HERE]`
- Example:
  ```
  [beat]
  [CLIP PLAYS HERE]
  [beat]
  ```

**Streamer Intros** (Twitch only):
- Must be 2-3 sentences (2 minimum, 3 maximum)
- Include display name (not Twitch username)
- Include origin and one interesting fact
- Example:
  ```
  INTRO_xQc

  Let's kick it off with the one and only xQc. He's from Laval, Quebec and started his career as an Overwatch League pro before becoming one of the biggest variety streamers on Twitch. Known for his high-energy reactions and chaotic gameplay, he's the perfect streamer to start this compilation.
  ```

**Clip Setups**:
- Clip 1: 1 sentence (brief)
- Clips 2-3: 2 sentences each (more detail)
- Must accurately describe what happens in the clip
- Example:
  ```
  CLIP_1

  [beat]
  In this clip, xQc is playing GTA RP and gets into an absolutely ridiculous police chase that ends in the most unexpected way.
  [beat]
  [CLIP PLAYS HERE]
  [beat]
  ```

**Reactions**:
- Exactly 1 sentence per reaction
- Natural, conversational Bobby G voice
- Example:
  ```
  That was absolutely wild, chat was going CRAZY during that whole sequence!
  ```

---

## 🎯 HeyGen Scene Directions

### What to Send to HeyGen

**JSON Structure**:
```json
{
  "avatarId": "bobby_g_avatar_id",
  "scenes": [
    {
      "sceneTitle": "INTRO",
      "scriptText": "What is up ClipzWorld, we got...",
      "duration": 20,
      "avatarSettings": {
        "emotion": "energetic",
        "gesture": "welcoming"
      }
    },
    {
      "sceneTitle": "INTRO_xQc",
      "scriptText": "Let's kick it off with...",
      "duration": 25,
      "avatarSettings": {
        "emotion": "enthusiastic",
        "gesture": "presenting"
      }
    },
    {
      "sceneTitle": "CLIP_1_SETUP",
      "scriptText": "In this clip, xQc is...",
      "duration": 10,
      "avatarSettings": {
        "emotion": "excited",
        "gesture": "anticipation"
      }
    },
    {
      "sceneTitle": "CLIP_1",
      "type": "video_insert",
      "videoFile": "/path/to/clip_1.mp4",
      "duration": 30
    },
    {
      "sceneTitle": "CLIP_1_REACTION",
      "scriptText": "That was absolutely wild...",
      "duration": 8,
      "avatarSettings": {
        "emotion": "amazed",
        "gesture": "laughing"
      }
    }
  ],
  "backgroundMusic": "upbeat_gaming_track.mp3",
  "outputFormat": {
    "resolution": "1080p",
    "aspectRatio": "16:9"
  }
}
```

---

## 🎭 Avatar Emotions & Gestures

### Emotion Keywords (per scene type)

**INTRO**: `energetic`, `welcoming`, `excited`
**INTRO_{STREAMER}**: `enthusiastic`, `presenting`, `informative`
**CLIP_SETUP**: `excited`, `anticipation`, `storytelling`
**CLIP_REACTION**: `amazed`, `laughing`, `shocked`, `impressed`
**ANALYSIS**: `thoughtful`, `analytical`, `serious`
**OUTRO**: `friendly`, `appreciative`, `call-to-action`

### Gesture Keywords

**welcoming**: Arms slightly open, inviting
**presenting**: Hand gestures toward streamer/topic
**anticipation**: Leaning forward slightly
**laughing**: Natural laugh animation
**thoughtful**: Hand on chin or contemplative pose
**call-to-action**: Pointing gesture (for subscribe CTA)

---

## 🔍 Gemini QA Checklist (10 Points)

Scripts are auto-validated against these criteria:

1. **CLIP COUNT**: Exactly N [CLIP PLAYS HERE] markers (N = clips per content type)
2. **OUTRO**: Script ends with "Appreciate you!"
3. **DISPLAY NAMES**: Only approved display names used (no Twitch usernames)
4. **INTRO LENGTH**: Each streamer intro 2-3 sentences
5. **REACTION LENGTH**: Each reaction exactly 1 sentence
6. **SETUP LENGTH**: Clips 2-3 setups are 2 sentences each
7. **BEAT PLACEMENT**: [beat] before AND after every [CLIP PLAYS HERE]
8. **CLIP MATCH**: Setup accurately describes clip content (most important)
9. **LOCKED INTRO**: Video opens with correct locked intro line
10. **WORD COUNT**: Each streamer section ~80-100 words

**Scoring**:
- Each failed check: -10 points
- Final score: 100 - (failures × 10)
- Pass: ≥90
- Manual Review: 70-89
- Fail: <70

---

## 📊 Example Scripts

### Twitch Long Form Example

```
INTRO

What is up ClipzWorld, we got some INSANE Twitch moments today with xQc, Pokimane, and Kai Cenat!

INTRO_xQc

Let's kick it off with the one and only xQc. He's from Laval, Quebec and started his career as an Overwatch League pro before becoming one of the biggest variety streamers on Twitch. Known for his high-energy reactions and chaotic gameplay, he's the perfect streamer to start this compilation.

CLIP_1_SETUP

[beat]
In this clip, xQc is playing GTA RP and gets into an absolutely ridiculous police chase that ends in the most unexpected way.
[beat]

[CLIP PLAYS HERE]

CLIP_1_REACTION

[beat]
That was absolutely wild, chat was going CRAZY during that whole sequence!

CLIP_2_SETUP

[beat]
Next up, xQc is reacting to a viral TikTok and his response is priceless. Watch how quickly he goes from confused to completely losing it when he finally understands what's happening.
[beat]

[CLIP PLAYS HERE]

CLIP_2_REACTION

[beat]
Classic xQc energy right there, you can never predict how he's gonna react!

[... continues for all 9 clips ...]

OUTRO

Appreciate you! Subscribe for more Twitch compilations every week. Peace.
```

---

## 🚀 Production Workflow

1. **Script Generation** (Claude)
   - Reads clip analyses from Gemini
   - Generates script with proper markers
   - Follows shot structure for content type

2. **Script QA** (Gemini)
   - Validates against 10-point checklist
   - Returns score + detailed report
   - Flags critical failures

3. **HeyGen Submission**
   - Convert script to HeyGen JSON format
   - Split into scenes with durations
   - Add avatar settings per scene
   - Submit to HeyGen API

4. **Video Assembly** (HeyGen)
   - Renders Bobby G avatar with script
   - Inserts video clips at markers
   - Applies background music
   - Exports final video

5. **Post-Production** (Server)
   - Download video from HeyGen
   - Verify duration and quality
   - Add thumbnail burn (intro card)
   - Export for platform upload

---

## ⚠️ Common Script Failures

### Critical Failures (Auto-Reject)

**Wrong Clip Count**:
```
❌ Script has 8 [CLIP PLAYS HERE] but expected 9
```

**Missing Outro**:
```
❌ Script does not end with "Appreciate you!"
```

**Clip Mismatch**:
```
❌ CLIP_3 setup says "police chase" but Gemini saw "cooking stream"
```

### Manual Review (70-89 score)

**Long Intros**:
```
⚠️  INTRO_Pokimane is 4 sentences (should be 2-3)
```

**Multiple Reaction Sentences**:
```
⚠️  CLIP_5 reaction is 2 sentences (should be 1)
```

### Auto-Fix (No impact on score)

**Missing Beats**:
```
🔧 Auto-added [beat] markers around CLIP_7
```

---

## 🗣️ Pronunciation Guidance System

### Current Implementation (streamers.json)

**Phonetic Field**: `streamers.json:70`
```json
{
  "displayName": "Yonna",
  "twitchUsername": "yonnajay",
  "onAirName": "Yonna",
  "phonetic": "Yawn-uh",  // ← HeyGen pronunciation guide
  "origin": "Brevard",
  "fact": "Number one roaster"
}
```

**How It Works**:
1. Claude reads `streamers.json` before generating scripts
2. If `phonetic` field exists, Claude should use phonetic spelling in script
3. HeyGen avatar reads the script and pronounces based on written text
4. **Current Gap**: Claude doesn't automatically inject phonetic spellings into scripts

---

### Pronunciation Best Practices

**Names with Phonetic Guides**:
- Use phonetic spelling in parentheses on first mention
- Example: "Next up is Yonna (pronounced Yawn-uh)"

**Complex Words**:
- Break difficult words into syllables with hyphens
- Example: "unprecedented" → "un-preh-seh-den-ted"

**Numbers & Abbreviations**:
- Spell out how to say them
- ❌ "3-pointer" → ✅ "three-pointer"
- ❌ "NBA" → ✅ "N-B-A" (if needed) or "the NBA" (flows better)

**Team Names & Locations**:
- Lakers, Celtics, Mavericks (standard pronunciation, no changes needed)
- ⚠️ "Bucks" → Can sound like "bucks" (money) or "Buks" — use context

---

### HeyGen Iteration Loop (Pronunciation QA)

**Current Workflow** (server.js:1077-1370):

```
1. Claude generates script → Gate 1 (Gemini script QA) → score ≥90 = proceed
2. Script sent to HeyGen → Avatar segments rendered
3. Gate 2 (Gemini segment QA) → Checks lip sync, audio, avatar visibility
4. If Gate 2 fails (score <65): Re-render HeyGen segments (max 3 retries)
5. If passes: Assembly continues
```

**Problem**: Gate 2 detects lip sync issues but doesn't feed pronunciation feedback to Claude

---

### Proposed Enhancement: Pronunciation Iteration Loop

**New Gate 2A: Pronunciation & Clarity Check**

After HeyGen renders segments, Gemini checks:
1. ✅ **Pronunciation Accuracy**: Names, terms, locations pronounced correctly?
2. ✅ **Speech Clarity**: Any garbled words, stutters, or glitches?
3. ✅ **Natural Flow**: Does speech sound robotic or have awkward pauses?
4. ✅ **Beat Placement**: Are `[beat]` pauses respected by HeyGen?

**If pronunciation issues detected**:
1. Gemini generates feedback: "Bobby G mispronounced 'Yonna' as 'Yo-na' instead of 'Yawn-uh'"
2. Feedback sent to Claude with HeyGen MCP context
3. Claude revises script with phonetic spelling adjustments
4. Revised script → HeyGen re-renders ONLY affected segments
5. Gate 2A re-checks pronunciation
6. Max 3 iterations before manual review required

**HeyGen MCP Integration** (MISSING - NEEDS IMPLEMENTATION):
- Currently NO HeyGen MCP server exists in codebase
- Need HeyGen MCP to:
  - Send scripts to HeyGen API
  - Monitor rendering progress
  - Retrieve segment URLs when complete
  - Re-render specific segments with updated scripts

---

### Pronunciation Checklist (Gate 2A)

**Gemini Prompt for Pronunciation QA**:
```
You are reviewing HeyGen avatar segments for pronunciation accuracy.

Watch these segments and check:
1. NAMES: Are streamer names pronounced correctly? (Check against phonetic field)
2. TERMS: Gaming/NBA/news terms pronounced clearly?
3. FLOW: Any awkward pauses, stutters, or robotic speech?
4. BEATS: Are `[beat]` markers causing noticeable pauses?
5. GLITCHES: Any mid-word freezes or audio dropouts?

For each issue, provide:
- Timestamp in segment
- What was said vs. what should be said
- Phonetic suggestion for correction
```

**Scoring**:
- **100 pts**: Perfect pronunciation, no issues
- **-15 pts per mispronounced name**
- **-10 pts per unclear term**
- **-5 pts per awkward pause (non-beat)**
- **Pass threshold**: ≥85 pts
- **Hard fail**: <70 pts OR critical name butchered

---

## 📝 Notes

- **HeyGen API**: Currently manual integration, will automate when API keys provided
- **HeyGen MCP**: NOT YET IMPLEMENTED — critical for pronunciation iteration loop
- **Scene Durations**: Estimated based on word count (2.5 words/second speaking rate)
- **Avatar Customization**: Can adjust emotions/gestures per scene for better delivery
- **Background Music**: Optional, can be added in post-production
- **Multi-Language**: Currently English only, will support Spanish/French later
- **Phonetic System**: Exists in streamers.json but NOT automatically used by Claude in script generation
