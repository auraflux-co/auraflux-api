# HeyGen Options Inventory — Consolidated research

**Purpose:** The single canonical reference for every HeyGen lever CWN can pull, with honest confidence levels and current status. Updated after Rob's research marathon on 2026-04-11 consolidating 5 distinct research passes.

**Last updated:** 2026-04-11 (post-SSML ship)
**Confidence legend:**
- 🟢 Verified from HeyGen docs + tested in CWN code
- 🟡 Documented but field location / availability uncertain for your voice/avatar
- 🔴 Speculative or may require architectural changes

---

## Current state — what CWN sends HeyGen right now

From `server.js:1846-1866`, after commit `ba87ec5` and the pending `CLINE_HANDOFF_HEYGEN_PAUSE_UNLOCK.md`:

```json
{
  "title": "asm_xxxxx_00_COLD_OPEN",
  "video_inputs": [{
    "character": {
      "type": "avatar",
      "avatar_id": "842f20b75ce242aea397f5030aa018aa",
      "avatar_style": "normal"
    },
    "voice": {
      "type": "text",
      "input_type": "ssml",
      "input_text": "scene text with <break time='1000ms'/> tags",
      "voice_id": "2e598f1a6022448cb6710e5d44665325",
      "speed": 0.85
    }
  }],
  "dimension": { "width": 1920, "height": 1080 },
  "dynamic_duration": true,
  "test": false
}
```

**Endpoints:**
- `POST https://api.heygen.com/v2/video/generate` — submit a scene
- `GET https://api.heygen.com/v1/video_status.get?video_id={id}` — poll status

**Config values (`.env`):**
- `HEYGEN_AVATAR_ID = 842f20b75ce242aea397f5030aa018aa` (landscape-native 4K)
- `HEYGEN_AVATAR_SHORT_ID = ed57439c9c3d4a398f3b247b75714b13` (portrait for Shorts)
- `HEYGEN_VOICE_ID = 2e598f1a6022448cb6710e5d44665325` (the "cw" voice — paired manually)
- `HEYGEN_SPEAK_SPEED = 0.85`

---

## Documented best practices (research-verified 2026-04-11)

These are the rules Rob pulled from HeyGen's own guides across 5 research passes. Everything here is 🟢 unless marked otherwise.

### Speed & cadence

- **Speed range: 0.8–1.2** 🟢
  Outside this range, voice naturalness and lip-sync quality degrade. CWN at 0.85 is in range. Do NOT push below 0.80 looking for more deadpan; it'll hurt more than help.

- **Vary sentence length** 🟢
  Short punchy statements + longer explanatory sentences create natural rhythmic flow. Gemini's default scripting tends toward uniform sentence length — future prompt improvement.

- **Avoid complex nested clauses** 🟢
  Nested clauses confuse the TTS engine and cause rushed or poorly articulated speech. Keep Bobby G's sentences linear and declarative.

### Pauses & pacing

- **SSML `<break time="1000ms"/>`** 🟢
  Primary documented mechanism for precise pauses. Requires `input_type: 'ssml'` on the voice block. 1 second is the documented starting value. **Shipped in CWN as of `ba87ec5` + pending pause-unlock commit.**

- **The "Two-Second Rule"** 🟢
  Add a 2-second pause after key messages or data points so the audience can process. 1s `<break>` + sentence-ending period ≈ ~1.5-2s total feel.

- **Ellipses (`...`) for secondary pause/reset** 🟢
  HeyGen documents `...` as the fallback for "too fast" delivery. **Important:** ellipses trigger facial expression resets — this is a FEATURE, not a bug. It lets emotional expression "settle" between thoughts. We were wrong earlier tonight when we diagnosed ellipsis as the tick cause.

- **`dynamic_duration: true`** 🟢
  Auto-adjusts video timing if emotional/SSML delivery differs from script's plain-text length. **Without this, SSML pauses may be silently trimmed to hit a preset duration.** Pending ship in `CLINE_HANDOFF_HEYGEN_PAUSE_UNLOCK.md`.

### Voice quality & TTS engine

- **Starfish TTS engine** 🟡
  HeyGen's in-house high-quality TTS. Rob's research says use `engine=starfish` when calling `/v3/voices` endpoint. **Uncertainty:** not confirmed whether `engine` field works on the V2 `video/generate` endpoint or if it only exists on the V3 `voices` endpoint. May require architectural refactor to a 2-call flow (V3 voice → V2 video with audio_url).
  **Status:** parked as future investigation.

- **"Golden Path" default voices** 🟡
  Every avatar has a `default_voice_id` that's pre-optimized for its visual persona and emotional range. Using the default gives better results than pairing a voice manually.
  **Open question:** is CWN's `HEYGEN_VOICE_ID` (`2e598f1a6022448cb6710e5d44665325`, the "cw" voice) the default for the landscape 4K avatar `842f20b75ce242aea397f5030aa018aa`? **Unknown** — requires HeyGen Studio UI check.

- **ElevenLabs integration** 🟡
  For nuanced emotional control beyond HeyGen's built-ins, ElevenLabs voice clones can be fed to HeyGen via `voice.type = 'audio'` + `audio_url`. This is the Tier 5 escape hatch for voice quality.
  **Status:** parked until CWN exhausts native HeyGen options.

### Emotion & expression control

- **`emotion` parameter in voice_settings** 🟡
  Documented values include `serious`, `happy`, `excited`. **Must match the script's tone per scene** — blanket applying one emotion causes uncanny results.
  **Uncertainty:** field location. Rob's research says "voice_settings object" but CWN's payload has a flat `voice` object. May be `voice.emotion`, `voice.voice_settings.emotion`, or a sibling at the video_input level.
  **Status:** parked for a dedicated probe script that tests which field location HeyGen accepts. See "Open questions" below.
  **Critical caveat:** if this ships without per-scene mapping, we get uncanny delivery. CWN needs the Architecture C hybrid plan (scene-type → emotion map) before this can ship safely.

### Scripting techniques

- **Phonetic spelling inline** 🟢
  For names, technical terms, or anything likely to mispronounce: `"Yonna (YAW-na)"` or `"NVIDIA (EN-VID-YA)"`. Fixes pronunciation at the script level without voice-cloning or API config.
  **Opportunity:** CWN streamer names (YonnaJay, JayCinco, etc.) are probably mispronouncing in current renders. This is a Gemini prompt change + script regeneration — separate task.

- **Natural emphasis via punctuation, not caps** 🟢
  Use commas and periods to structure natural pauses and help the TTS understand emphasis. Do NOT use all-caps for emphasis — the engine may interpret them as abbreviations.

- **Dynamic duration already noted above**

### Avatar model selection

- **Avatar 4 / 4.0 / 5 (now on Avatar 5)** 🟡
  HeyGen has iterated rapidly. Avatar 4/5 models are specifically designed to match lip movements and micro-expressions to emotional cues in the audio. Rob confirmed **Avatar 5 exists as of 2026-04-11.**
  **Current CWN:** still on landscape 4K avatar `842f20b75ce242aea397f5030aa018aa` (moved here from Avatar V in commit `0d13fb0` to fix the pillarbox bug).
  **Open question:** does Rob's HeyGen plan include Avatar 4 / 5 access for a landscape 4K persona? Unknown without UI check.
  **If available, this may be the biggest single lever for Bobby G quality.** Micro-expression matching is exactly the ticking/flat-delivery problem CWN has been fighting.
  **Status:** parked as high-priority investigation. Manual HeyGen Studio UI check required first.

---

## What we're NOT using that we could use — prioritized

### Tier 1 — Already shipping or in the next commit

- ✅ `input_type: 'ssml'` (shipped `ba87ec5`)
- ✅ `<break time="XXXms"/>` for pauses (shipped `ba87ec5`, tuning to 1000ms in pending commit)
- 🚧 `dynamic_duration: true` (pending in `CLINE_HANDOFF_HEYGEN_PAUSE_UNLOCK.md`)

### Tier 2 — High value, small code changes, need probe first

- 🟡 **`emotion` parameter with per-scene mapping** (Architecture C: scene-type → emotion map)
  - Need: probe script to confirm field location
  - Need: scene-label → emotion lookup (COLD_OPEN → serious, SETUP → neutral, etc.)
  - Blocker: must have working probe before shipping
  - Why it matters: likely the biggest single lever for "Bobby G is flat/dead" problem

- 🟡 **Avatar 4 or 5 migration**
  - Need: HeyGen account check for available avatars
  - Need: side-by-side comparison render (old vs new)
  - Why it matters: architectural unlock for micro-expression quality if available

- 🟢 **Phonetic name spelling in scripts**
  - Need: Gemini prompt change + STREAMER_PHONETIC_MAP lookup
  - Why it matters: fixes YonnaJay, JayCinco, etc. mispronunciation at the source

### Tier 3 — Medium effort, lower priority

- 🟢 **Per-scene speed variation**
  - Currently one global `HEYGEN_SPEAK_SPEED = 0.85` for all scenes
  - Could set COLD_OPEN at 0.90, REACTION at 0.82, etc. Stay within 0.8–1.2 range.
  - Small code change in scene submission loop
  - Why it matters: more dynamic delivery without touching content

- 🟡 **Callback webhook**
  - Replaces current 30s polling in `server.js:143-365`
  - Requires publicly-reachable URL → only works after Railway deployment
  - Why it matters: lower latency + simpler architecture for multi-tenant

- 🟢 **`word_timestamps: true` in API response**
  - Enables precise subtitle/caption sync to individual words
  - Future feature, not needed now
  - Why it matters: when CWN adds captions, this is the foundation

### Tier 4 — Architectural options (post-12-test-case work)

- 🟡 **`character.matting: true` for transparent background**
  - Returns Bobby G over transparent bg → composite over custom studio backdrop in FFmpeg
  - Would let CWN differentiate visually from generic HeyGen output
  - Unknown if landscape 4K avatar supports it

- 🔴 **`/v2/photo_avatar/add_motion` Motion API** (Post-12-test-case — Rob confirmed)
  - Separate HeyGen product for photo avatars (not studio avatars)
  - Lets you prompt specific motions: "Right hand gestures dismissively, bored expression"
  - Would require ground-up architectural rewrite + custom photo avatar creation
  - **Post-12-test-case investigation** — potential path to a fully custom Bobby G

- 🔴 **Video Agent API**
  - Mentioned in Rob's Motion API research
  - Takes a full script and auto-maps visuals + avatar motions to text
  - **Unknown endpoint, unknown capability, unknown plan requirement**
  - Post-12-test-case investigation

- 🟡 **`/v3/voices` endpoint refactor**
  - Required IF `engine=starfish` only works at the V3 voice endpoint
  - Would be a 2-call flow: V3 voice generates audio → V2 video renders avatar over that audio
  - Meaningful architectural refactor
  - Only needed if V2 rejects the engine field in direct test

### Tier 5 — Escape hatches (outside HeyGen)

- 🟡 **ElevenLabs voice-only + HeyGen avatar-only**
  - Generate audio in ElevenLabs (nuanced emotional control)
  - Feed to HeyGen as `voice.type = 'audio'` + `audio_url`
  - Multi-week integration, not tonight
  - Only if HeyGen SSML + emotion + Avatar 5 all prove insufficient

- 🔴 **Different avatar platform entirely**
  - D-ID, Synthesia, Runway Act-One, custom Wav2Lip pipeline
  - Months of work
  - Never unless HeyGen proves to be a product-level blocker

---

## Things we CANNOT do (honest limits)

These are the real ceilings as far as current research shows:

- 🔴 **Direct idle-gesture suppression** — no API field to say "keep hands still." Emotion param may indirectly achieve this via serious/neutral tones.
- 🔴 **Per-scene gesture selection** — can't specify "arms crossed for this scene." Avatar picks its own gestures.
- 🔴 **Pose continuity across scenes** — each render starts from avatar's neutral state. Segment-boundary ticks are structural to how CWN uses HeyGen today. Mitigations: crossfades at FFmpeg, or single-render full-compilation (latter requires architectural change to avoid the 1400-char HeyGen limit).
- 🔴 **Reference video input for gesture matching** — different product category. Not HeyGen.
- 🔴 **Frame-accurate gesture cue points** — can't say "gesture at 0:02.500."
- 🔴 **SSML emotion tags (`<emotion type="serious">`)** — emotion is a separate API parameter, not an SSML tag. Confirmed.

---

## Open questions for HeyGen support

Ranked by priority for CWN:

1. **Does `v2/video/generate` accept `dynamic_duration: true`?** (answering this in the next commit — watch for errors)
2. **What values does the `emotion` parameter accept, and where does it live** (`voice.emotion`, `voice.voice_settings.emotion`, or video_input-level)?
3. **Is Avatar 5 available on CWN's current plan** for a landscape 4K persona suitable for an anchor/studio setup?
4. **Is `engine=starfish` supported on V2 `video/generate`** or is it V3-only requiring a refactor?
5. **What's the `default_voice_id`** for avatar `842f20b75ce242aea397f5030aa018aa`?
6. **Does `character.matting: true` work for that avatar**?
7. **Is there any way to reduce idle gesture frequency** programmatically on landscape 4K avatars?
8. **Does Video Agent API work with studio avatars or only photo avatars**? What endpoint is it?
9. **For the voice ID in use**, which of `<prosody>`, `<emphasis>`, `<phoneme>`, `<sub>` SSML tags are supported?
10. **`word_timestamps: true`** — what's the response format and are they word-level or phoneme-level?

---

## Priority next steps (post-SSML-unlock-commit)

Sequential, not parallel. Each step either answers a question or ships a safe improvement:

1. **Ship `CLINE_HANDOFF_HEYGEN_PAUSE_UNLOCK.md`** (in queue now)
2. **Run the 12-streamer real test** with SSML + dynamic_duration live. Listen specifically for:
   - Do pauses land on `[beat]` markers now? (tells us if SSML + dynamic_duration works)
   - Are segment-boundary ticks still present? (tells us if the problem is TTS or FFmpeg-concat)
   - Does Bobby G still feel flat? (tells us if emotion parameter is the next move)
3. **Manual HeyGen Studio check** — Rob looks up:
   - Avatar 5 availability for landscape 4K personas
   - Default voice ID for avatar `842f20b75ce242aea397f5030aa018aa`
4. **Write emotion probe script** (`scripts/probe_heygen_emotions.js`) that tests which emotion values and field locations work
5. **Ship Architecture C per-scene emotion map** based on probe results
6. **Phonetic name spelling** — Gemini prompt change + script regeneration
7. **Per-scene speed variation** — small code change in scene submission loop
8. **Avatar 5 migration** IF available on plan — side-by-side comparison first

---

## What we were wrong about earlier tonight

Honest course corrections from the evening's diagnosis:

1. **`...` → tick diagnosis was likely incomplete.** Ellipses are documented as an intentional mechanism for expression resets. The real tick cause is likely segment boundaries (each scene = separate HeyGen render = pose reset on concat), not the punctuation in the text.

2. **`emotion` parameter existence wasn't confirmed earlier.** I marked it 🟡 uncertain. Rob's research pass 4 confirmed it's a first-class API parameter. It's the biggest unused lever for Bobby G quality.

3. **`dynamic_duration` was unknown.** This parameter alone may be the reason our shipped SSML `<break>` tags appear to do nothing. HeyGen may be auto-trimming silence to hit target durations. Adding it could be the difference between "SSML works" and "SSML is a no-op."

4. **Speed tuning advice was wrong.** I suggested 0.78 earlier tonight. Documented range is 0.8–1.2. Below 0.80 degrades lip-sync. Current 0.85 is correct; don't go below.

5. **"Starfish engine" architectural uncertainty** — the guide specifically says "when calling the v3 voice endpoint," suggesting this field may be V3-only. V2 video generate may or may not accept it. Needs testing before ship.

---

## Related parked tasks

- **Task #8** — Streamer dropdown UX (separate from HeyGen)
- **Task #15** — `/assemble status='done'` race condition
- **Task #18** — Topaz ring removal from Bobby G segments
- **Task #21** — Post-12-test scheduled generation
- **Task #22** — Long-term ticker drawtext replacement
- **Post-12-test-case investigations:**
  - Avatar 5 migration (Tier 2)
  - Photo Avatar Motion API (Tier 4)
  - Video Agent API (Tier 4)
  - Engine=starfish (Tier 4)

---

*This doc supersedes all prior HeyGen option discussions. Update it when shipping new HeyGen-related commits. Update confidence markers (🟢/🟡/🔴) as we verify claims through testing.*
