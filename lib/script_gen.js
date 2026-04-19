'use strict';
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { CONFIG } = require('./config');
const { logError } = require('./error_logger');
const logger = require('./logger');
const { StageTimer, initJobMetrics, addStageMetrics, finalizeJobMetrics } = require('./metrics');
const { callClaudeAPI, uploadToGeminiFiles, waitForGeminiFile, deleteGeminiFile, claudeScriptQA, claudeScriptFix, parseScriptIntoScenes, autoAction } = require('./qa');
const { validateScript: validateChromeScript, directiveToOverlayParams } = require('./chromeDirectives');
const { writeDirectiveForJob, loadDirectiveForJob, extractSpokenTextFromDirective } = require('./directives');
const { downloadFile } = require('./downloader');
const TwitchClient = require('./clients/twitch_client');
const cheerio = require('cheerio');
const { getHeyGenConfig } = require('./configLoader');

// Gemini file size limit (34MB) — mirrors CONFIG.GEMINI.MAX_FILE_SIZE
const GEMINI_FILE_LIMIT = CONFIG.GEMINI.MAX_FILE_SIZE;

// Feature flag — mirrors server.js (process.env.USE_DIRECTIVE_CHROME !== 'false')
const USE_DIRECTIVE_CHROME = process.env.USE_DIRECTIVE_CHROME !== 'false';

// Strip markdown code fences from Gemini JSON output (e.g. ```json ... ```)
function stripCodeFences(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
}

const twitchClient = new TwitchClient(); // reads TWITCH_CLIENT_ID + TWITCH_TOKEN from process.env

async function resolveTwitchClipMp4(slug, preferQuality) {
  return twitchClient.resolveClipMp4(slug, preferQuality);
}

function extractTwitchSlug(urlOrSlug) {
  return twitchClient.extractSlug(urlOrSlug);
}

const TMP_DIR = path.join(__dirname, '..', 'tmp');

const GEMINI_MODEL  = 'gemini-2.5-flash';
const GEMINI_APIKEY = process.env.GEMINI_API_KEY;

// ── System prompts per content type ──────────────────────────────────────────
// Moved here from server.js during module split — script_gen.js is the only consumer
const FULL_SCRIPT_SYSTEM = {

nba: `You write scripts for "Other Side of the Pillow" — a ClipzWorld News NBA highlights show.

HOST PERSONA: The Rhythmic Enthusiast.
VOCAL SETTING: Cool, melodic, percussive. Use the Stuart Scott flow.
Short bursts. Named. Specific. Then the flat landing. Not full sentences explaining what happened — a series of facts that build without connective tissue. Warmth comes from specificity, not adjectives. The slang is earned, not performed.

STRICT RULES:
- Never say "incredible", "amazing", "crazy", "wild", "absolutely", "definitely"
- Never write broadcast cliché ("He rises and hits the shot", "both teams battled", "demonstrates his scoring prowess")
- Never invent plays or stats not in the video analysis
- Zero hot takes, zero "who is better" debates
- [beat] = natural pause in delivery, use freely
- [CLIP PLAYS HERE] = structural marker, not spoken
- Write every single line — no brackets, no placeholders

HEYGEN PRONUNCIATION:
The avatar reads EVERYTHING aloud. No parenthetical pronunciation guides — they get spoken.
- Common NBA names (LeBron, Curry, Durant, Luka, Giannis) HeyGen handles fine — leave them
- Only respell if genuinely unusual AND you are certain HeyGen will mispronounce it
- Spell out numbers: "thirty-two points" NOT "32 points"
- "NBA" and "MVP" are fine as-is

SCRIPT FORMAT — Plain text only. No JSON, no XML. Use EXACTLY the === SCENE HEADERS === from the user prompt. One scene per header. Do not combine. Do not skip.
Target: 120-150 words of SPOKEN TEXT per game segment (90 seconds of delivery).

COLD OPEN — ALWAYS use this EXACT wording, no variation:
"Hello everyone! You are tuning into The Other Side of the Pillow brought to you by ClipzWorld News. Where we appreciate all of yesterday's games in the association. I am your host Bobby G. Let's get to it."

OUTRO — ALWAYS use this EXACT wording, no variation:
"That's all the time we have before the light bill is due. I'm Bobby G for ClipzWorld News. Keep your clips short and your takes shorter. Goodnight and good luck."

DELIVERY NOTE — OUTRO: Last line lands flat. No warmup, no runway. Just state it and stop.

NBA VOICEOVER STRUCTURE — IMPORTANT:
The avatar speaks WHILE the clip plays. Write commentary assuming it plays as audio OVER the highlight — not before or after. Present tense. Immediate.`,

news: `You write scripts for "Because the Light Was On" — a ClipzWorld News world news show.

HOST PERSONA: The Literal Satirist.
VOCAL SETTING: Dry, mid-tempo, monotone with long pauses.
Present facts. Make one observation. Move on. The host is not alarmed. Not your friend. A newsreader who has been doing this too long. The comedy comes from the gap between what happened and how calmly it is reported.

STRICT RULES:
- Each story: setup (1-2 sentences, headline + context) → [beat] → [CLIP PLAYS HERE] → [beat] → reaction (1 flat sentence, stated plainly, done)
- Never say "shocking", "alarming", "incredible", "wild", "you won't believe this"
- Never explain why the observation is significant — state it and stop
- Never editorialize with emotion
- [beat] = pause. Use it. Long pauses are part of the delivery.
- [CLIP PLAYS HERE] = structural marker, not spoken
- Write every single line — no brackets, no placeholders

HEYGEN PRONUNCIATION:
The avatar reads EVERYTHING aloud. No parenthetical pronunciation guides — they get spoken.
- Common names (Iran, Qatar, Beijing, Ukraine, Zelenskyy) HeyGen handles fine — leave them
- Only respell if genuinely obscure AND you are certain HeyGen will mispronounce it
- Spell out numbers: "twenty-three" NOT "23"
- "UN" → "U-N" or "the UN"

SCRIPT FORMAT — Plain text only. No JSON, no XML. Use EXACTLY the === SCENE HEADERS === from the user prompt. One scene per header. Do not combine. Do not skip.
Target: 80-120 words of SPOKEN TEXT per story.

COLD OPEN — ALWAYS use this EXACT wording, no variation:
"Hello everyone! You are tuning into Because the Light Was On brought to you by ClipzWorld News. Where we bring you the most impactful news stories of the day, our way, the CWN way. I am your host Bobby G. Let's get to it."

OUTRO — ALWAYS use this EXACT wording, no variation:
"That's all the time we have before the light bill is due. I'm Bobby G for ClipzWorld News. Keep your clips short and your takes shorter. Goodnight and good luck."

DELIVERY NOTE — OUTRO: Flat. No warmth. No runway. State it and stop.

NEWS STORY STRUCTURE:
[Setup — 1-2 sentences. Headline + one fact. What happened, stated plainly.]
[beat]
[CLIP PLAYS HERE]
[beat]
[ONE observation. Flat. Could be a non-sequitur. Do not explain it.]
[beat]
Source: [Source name]. Link in description.`,

twitch: `You write scripts for "Twitch Soup" — a ClipzWorld News Twitch clip reaction show.

HOST PERSONA: The Internet's Reluctant Janitor.
VOCAL SETTING: Fast, slightly annoyed, high-frequency.
The host has seen everything on this platform and is no longer impressed. He is reporting from the digital dumpster fire. He does not enjoy it. He is here because it is his job. The clip is the joke — he just witnesses it and says one flat thing.

STRICT RULES:
- Intro the streamer briefly (2-3 sentences max), then [CLIP PLAYS HERE]
- After the clip: ONE sentence. Flat. Could be a non-sequitur. Do not explain what just happened.
- Then: "Follow [streamer]. Link in description."
- Never say "that was incredible", "oh my god", or anything that hypes or explains the clip
- Never summarize what the viewer just watched
- Write every single line — no brackets, no placeholders
- Use the visual analysis to know what the clip is — do not narrate it

HEYGEN PRONUNCIATION:
The avatar reads EVERYTHING aloud. No parenthetical pronunciation guides — they get spoken.
- Streamer names: if streamers.json has a phonetic field, write that directly on first mention
- Numbers: spell out → "fifty thousand viewers" NOT "50k viewers"
- Commas create natural pauses in speech

⚠️ SCENE STRUCTURE — CRITICAL:
The user prompt provides a NUMBERED LIST of === SCENE HEADERS ===.
Output EXACTLY that many scenes with EXACTLY those headers.
- ONE scene per header — do NOT combine
- Do NOT skip any headers
- Do NOT create your own headers
- Count: 1 INTRO + (streamers × 7 scenes) + 1 OUTRO = total
- Each streamer: 1 INTRO scene + 3 SETUP scenes + 3 REACTION scenes = 7 scenes

SCRIPT FORMAT — Plain text only. No JSON, no XML.

INTRO SCENE — Use this EXACT text for the === INTRO === scene:
"Welcome to Twitch Soup. I'm your host Bobby G, and for the next few minutes, I'll be your guide through the world of livestreaming. Let's get into it."

OUTRO SCENE — Use this EXACT text for the === OUTRO === scene:
"That's all the time we have before the light bill is due. I'm Bobby G for ClipzWorld News. Keep your clips short and your takes shorter. Goodnight and good luck."

Target: 80-100 words of SPOKEN TEXT per streamer (45 seconds before and after clip).

DELIVERY NOTE — BEFORE CLIPS: INTRO segments must end with a complete sentence followed by [beat]. Avatar needs a clean stop before the clip rolls.

DELIVERY NOTE — REACTIONS + FOLLOW LINE: Always put [beat] between the reaction sentence and "Follow [name]." Two separate beats — reaction lands, then the follow ask.
"There is no home anymore. Just ash.
[beat]
Follow Jason. Link in description."`,

// ── SHORTS / REELS (portrait 9:16, single subject, ~45 seconds total) ───────
'nba-short': `You write short-form scripts for ClipzWorld News — Other Side of the Pillow (NBA).

FORMAT: 9:16 split-screen. Bobby G speaks a hook first (2-3 seconds), then the clip plays, then Bobby G delivers one reaction line. Total under 60 seconds.

YOUR OUTPUT HAS THREE PARTS:

1. HOOK (1 sentence Bobby G says BEFORE the clip — sets up why you're about to see this):
- Stuart Scott cadence. Player name. What's at stake. One flat setup. Done.
- Must make the viewer want to watch the clip. No spoilers.
- Example: "Curry. Fourth quarter. Down three."

2. REACTION (1 sentence Bobby G says AFTER the clip ends):
- Flat. Specific. Lands deadpan. No hype, no exclamation, no explaining what they just saw.
- Example: "He made that look easy. It was not easy."

3. CAPTION (max 3 words — "The Vibe" style):
- Standalone text overlay. Electric blue. Slanted. Rhythmic. Confident.
- Reads instantly. The cold fact or the vibe check. No punctuation needed.
- Good examples: "ICE IN VEINS" / "COLD BLOODED" / "DOWN BY FIVE" / "HE DID THAT"
- Bad examples: "Wow!" / "Amazing play!" / "Watch this!" / "Subscribe for more!" (too long, too hype)
- Think: what 3 words would a sportscaster tattoo on their wrist? That's the caption.

NO OUTRO. No "Subscribe." No "Appreciate you." No sign-off. The caption IS the ending.

OUTPUT FORMAT — use exactly this structure:
=== NBA SHORT ===
HOOK: [1 sentence before clip]
[CLIP PLAYS HERE]
REACTION: [1 sentence after clip ends]
CAPTION: [max 3 words, uppercase, vibe-check style]`,

'news-short': `You write short-form scripts for ClipzWorld News — Because the Light Was On (News).

FORMAT: 9:16 split-screen. Bobby G speaks a hook first (2-3 seconds), then the clip plays with full audio, then Bobby G delivers one reaction line. Total under 60 seconds.

YOUR OUTPUT HAS THREE PARTS:

1. HOOK (1 sentence Bobby G says BEFORE the clip — sets up the story):
- The Literal Satirist. State what happened plainly. Make the viewer need to see the clip.
- No alarm, no hype. Dry. Flat.
- Example: "A mayor cut the ribbon on a library that does not exist yet."

2. REACTION (1 sentence Bobby G says AFTER the clip ends):
- One flat observation. The absurd implication. Do not explain it. Done.
- Example: "He described the scissors as empowering."

3. CAPTION (max 6 words — "Deadpan Headline" style):
- Standalone text overlay. Yellow background, black serif text. Breaking news chyron format.
- Title Case. Formal tone. BUT the caption must be slightly wrong — understated, absurd, or one beat off from the actual story.
- NOT a real headline. A real headline is boring. This should make someone stop scrolling because something is subtly off.
- Good examples: "Drones Confirmed. Someone Is Pleased." / "War Update: Still Happening." / "Alligator Released Without Charges." / "Library Not Yet Built."
- Bad examples: "Norway, Ukraine Announce Drone Deal." (too real, too wire-copy) / "Watch this!" / "Unbelievable!" (vague/hype)
- The formula: state the obvious fact in the most formal, slightly wrong way possible. Norm MacDonald writing for CNN.

NO OUTRO. No "Subscribe." No "Appreciate you." No sign-off. The caption IS the ending.

OUTPUT FORMAT — use exactly this structure:
=== NEWS SHORT ===
HOOK: [1 sentence before clip]
[CLIP PLAYS HERE]
REACTION: [1 sentence after clip]
CAPTION: [max 6 words, Title Case, headline style]`,

'twitch-short': `You write short-form scripts for ClipzWorld News — Twitch Soup.

FORMAT: 9:16 split-screen. Bobby G speaks a hook first (2-3 seconds), then the clip plays with full audio, then Bobby G delivers one reaction line. Total under 60 seconds.

YOUR OUTPUT HAS THREE PARTS:

1. HOOK (1 sentence Bobby G says BEFORE the clip — sets up the streamer):
- The Internet's Reluctant Janitor. Streamer name. One flat fact about them. That's it.
- Makes the viewer curious without explaining the clip.
- Example: "This is Jason. He streams for eight hours a day."

2. REACTION (1 sentence Bobby G says AFTER the clip ends):
- Flat. Non-sequitur is fine. Do not explain what just happened. Do not hype it.
- Example: "There is no home anymore. Just ash."

3. CAPTION (max 4 words — "Viewer's Internal Thought" style):
- Standalone text overlay. Twitch purple background. Bold Impact font. All caps. Emoji allowed.
- Internet speak. Sarcastic. The viewer's reaction in 4 words or fewer.
- Good examples: "WHO LET HIM COOK 💀" / "UNINSTALLING NOW" / "CHAT WAS RIGHT" / "L + RATIO"
- Bad examples: "This is interesting." / "What a play!" / "Subscribe for more!" (too formal, too hype, CTA)
- Should feel like the top comment on the clip. That's it. That's the job.

NO OUTRO. No "Subscribe." No "Appreciate you." No sign-off. The caption IS the ending.

OUTPUT FORMAT — use exactly this structure:
=== TWITCH SHORT ===
HOOK: [1 sentence before clip]
[CLIP PLAYS HERE]
REACTION: [1 sentence after clip]
CAPTION: [max 4 words, all caps, internet speak, emoji ok]`

};

// ── Browser-like headers to bypass WAF detection ─────────────────────────
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Ch-Ua': '"Chromium";v="132", "Google Chrome";v="132", "Not?A_Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"'
};

const STREAMER_DISPLAY_NAMES = {
  'jasontheween':    'Jason',
  'hasanabi':        'Hasan',
  'adapt':           'Adapt',
  'stableronaldo':   'Ron',
  'lacy':            'Lacy',
  'marlon':          'Marlon',
  'cinna':           'Cinna',
  'yonnajay':        'Yonna',
  'jaycinco':        'Jay Cinco',
  'maya':            'Maya',
  'extraemily':      'ExtraEmily',
  'yourragegaming':  'Rage'
};

function getDisplayName(twitchUsername) {
  if (!twitchUsername) return twitchUsername;
  return STREAMER_DISPLAY_NAMES[twitchUsername.toLowerCase()] || twitchUsername;
}

// ─── FUNCTIONS EXTRACTED FROM server.js ───────────────────────────────────
// sendScriptToHeyGen       (was ~1924)
// geminiScriptGeneration   (was ~2064)
// getVoiceGuide            (was ~5344)
// scrapeArticleVideo       (was ~5787)
// scrapeArticleOgImage     (was ~5863)
// geminiAnalyzeClip        (was ~5889)
// geminiAnalyzeThumbnail   (was ~6050)
// prioritizeNewsStories    (was ~7842)
// handleGenerateFullScript (handler body from app.post /generate-full-script)

async function sendScriptToHeyGen(script, opts = {}) {
  const {
    contentType = 'twitch',
    format = 'landscape', // 'landscape' for long form, 'portrait' for short form
    jobId = 'unknown'
  } = opts;

  // Load HeyGen credentials from environment
  const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
  const HEYGEN_VOICE_ID = process.env.HEYGEN_VOICE_ID || '2e598f1a6022448cb6710e5d44665325';

  if (!HEYGEN_API_KEY) {
    throw new Error('HEYGEN_API_KEY not set in environment');
  }

  // Select avatar and speak speed from config (replaces per-format env-var branching)
  const heygenCfg = (() => {
    try { return getHeyGenConfig(contentType); }
    catch (e) {
      // Fallback for unknown content type — use format param as before
      return {
        avatarId: format === 'portrait'
          ? (process.env.HEYGEN_AVATAR_SHORT_ID || 'b3da9bba7b234526a0527c7970ea728e')
          : (process.env.HEYGEN_AVATAR_ID       || '842f20b75ce242aea397f5030aa018aa'),
        speakSpeed: parseFloat(process.env.HEYGEN_SPEAK_SPEED || '0.85')
      };
    }
  })();
  const avatarId = heygenCfg.avatarId || (format === 'portrait'
    ? (process.env.HEYGEN_AVATAR_SHORT_ID || 'b3da9bba7b234526a0527c7970ea728e')
    : (process.env.HEYGEN_AVATAR_ID       || '842f20b75ce242aea397f5030aa018aa'));
  const HEYGEN_SPEAK_SPEED = heygenCfg.speakSpeed || parseFloat(process.env.HEYGEN_SPEAK_SPEED || '0.85');

  // Template IDs (pre-baked avatar+background — lower render cost)
  const HEYGEN_TEMPLATE_LANDSCAPE = process.env.HEYGEN_TEMPLATE_LANDSCAPE || 'a917e52ebb164cc8ab3da97936361829';
  const HEYGEN_TEMPLATE_PORTRAIT  = process.env.HEYGEN_TEMPLATE_PORTRAIT  || 'ae51839648a84ce891bd83e0a44798db';
  const templateId = format === 'portrait' ? HEYGEN_TEMPLATE_PORTRAIT : HEYGEN_TEMPLATE_LANDSCAPE;

  // Parse script into scenes
  const scenes = parseScriptIntoScenes(script);

  console.log(`[heygen] Submitting ${scenes.length} scenes to HeyGen as individual videos (${contentType}, ${format}, avatar: ${avatarId.slice(0,8)}...)`);

  if (scenes.length === 0) {
    throw new Error('No scenes found in script. Script must have === SCENE_NAME === markers.');
  }

  console.log(`[heygen] Scene breakdown:`);
  scenes.forEach((scene, idx) => {
    console.log(`  ${idx + 1}. ${scene.name} - ${scene.text.substring(0, 50)}... (${scene.text.length} chars)`);
  });

  // Submit each scene as a separate video generation request
  const videoJobs = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];

    // Skip source_clip scenes — they are video clips, not avatar renders.
    // Bobby G does NOT speak in source_clip scenes — the clip plays instead.
    // Submitting them to HeyGen causes assembly sync issues (avatar nulled during voiceover).
    if (scene.type === 'source_clip') {
      console.log(`[heygen] ⏭  Skipping source_clip scene: ${scene.name}`);
      continue;
    }

    // Build single-scene video request
    // title is set to scene name so we can match videos back by title when refreshing IDs
    const sharedTitle = `${jobId}_${String(i).padStart(2,'0')}_${scene.name}`;
    const sharedVoice = {
      type: 'text',
      input_type: 'ssml',       // ← enables <break> tags and other SSML in input_text
      input_text: scene.text,
      voice_id: HEYGEN_VOICE_ID,
      speed: HEYGEN_SPEAK_SPEED
    };
    const sharedDimension = {
      width: format === 'portrait' ? 720 : 1280,
      height: format === 'portrait' ? 1280 : 720
    };

    // Template body — uses pre-baked avatar+background (lower cost)
    const templateBody = {
      title: sharedTitle,
      video_inputs: [{
        character: {
          type: 'template',
          template_id: templateId
        },
        voice: sharedVoice
      }],
      dimension: sharedDimension,
      dynamic_duration: true,
      test: false
    };

    // Full-gen body — fallback if template call fails or templateId missing
    const fullGenBody = {
      title: sharedTitle,
      video_inputs: [{
        character: {
          type: 'avatar',
          avatar_id: avatarId,
          avatar_style: 'normal'
        },
        voice: sharedVoice
      }],
      dimension: sharedDimension,
      dynamic_duration: true,
      test: false
    };

    try {
      console.log(`[heygen] Submitting scene ${i + 1}/${scenes.length}: ${scene.name}...`);

      // Template path: v2/template/{id}/generate — avatar+bg pre-baked, voice passed per-call.
      // Falls back to full-gen if template call fails.
      let response;
      if (templateId) {
        try {
          response = await axios.post(
            `https://api.heygen.com/v2/template/${templateId}/generate`,
            {
              title: sharedTitle,
              variables: {},
              video_inputs: [{ character: { type: 'template', template_id: templateId }, voice: sharedVoice }],
              dynamic_duration: true
            },
            { headers: { 'X-Api-Key': HEYGEN_API_KEY, 'Content-Type': 'application/json' }, timeout: 30000 }
          );
          console.log(`[heygen]   template render: ${templateId.slice(0,8)}...`);
        } catch (tmplErr) {
          console.warn(`[heygen]   template failed (${tmplErr.message}) — falling back to full-gen`);
          response = await axios.post(
            'https://api.heygen.com/v2/video/generate',
            fullGenBody,
            { headers: { 'X-Api-Key': HEYGEN_API_KEY, 'Content-Type': 'application/json' }, timeout: 30000 }
          );
        }
      } else {
        response = await axios.post(
          'https://api.heygen.com/v2/video/generate',
          fullGenBody,
          { headers: { 'X-Api-Key': HEYGEN_API_KEY, 'Content-Type': 'application/json' }, timeout: 30000 }
        );
      }

      const { video_id, status } = response.data.data || {};

      if (!video_id) {
        throw new Error(`HeyGen API did not return video_id for scene ${scene.name}: ${JSON.stringify(response.data)}`);
      }

      console.log(`[heygen] ✅ Scene ${i + 1}/${scenes.length} (${scene.name}): video_id=${video_id}, status=${status}`);

      videoJobs.push({
        sceneName: scene.name,
        sceneIndex: i,
        video_id,
        status,
        textLength: scene.text.length
      });

      // Add 2-second delay between requests to avoid rate limiting
      if (i < scenes.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

    } catch(e) {
      const errData = e.response?.data;
      console.error(`[heygen] API Error for scene ${scene.name}:`, e.message, errData || '');
      throw new Error(`HeyGen API failed for scene ${scene.name}: ${e.message}${errData ? ` - ${JSON.stringify(errData)}` : ''}`);
    }
  }

  console.log(`[heygen] ✅ All ${scenes.length} scenes submitted successfully`);
  console.log(`[heygen] Video IDs: ${videoJobs.map(j => j.video_id).join(', ')}`);

  // Store script text with scene mapping for Gate 2 re-rendering
  const sceneTextMap = {};
  scenes.forEach((scene, idx) => {
    sceneTextMap[scene.name] = {
      text: scene.text,
      index: idx,
      videoId: videoJobs[idx]?.video_id
    };
  });

  return {
    videoJobs,  // Array of {sceneName, sceneIndex, video_id, status, textLength}
    avatarId,
    voiceId: HEYGEN_VOICE_ID,
    speakSpeed: HEYGEN_SPEAK_SPEED,
    sceneCount: scenes.length,
    scenes: scenes.map(s => s.name),
    sceneTextMap,  // Full script text mapped by scene name for Gate 2 re-rendering
    fullScript: script  // Complete original script for reference
  };
}


async function geminiScriptGeneration(userPrompt, systemPrompt, opts = {}) {
  const { previousScript = null, feedbackMsg = '', contentType = 'twitch' } = opts;

  if (!GEMINI_APIKEY) throw new Error('GEMINI_APIKEY not configured');

  // Load style guide for this content type
  const STYLE_GUIDE_PATH = path.join(__dirname, '..', 'data', 'cwn_style_guides.json');
  let styleGuide = '';
  try {
    const styleGuides = JSON.parse(fs.readFileSync(STYLE_GUIDE_PATH, 'utf8'));
    // Check exact content type first (e.g. 'news-short'), fall back to base type ('news')
    const baseType = contentType.replace('-short', '');
    styleGuide = styleGuides[contentType] || styleGuides[baseType] || '';
    if (styleGuide) {
      console.log(`[geminiScriptGeneration] Loaded ${contentType} style guide (${styleGuide.length} chars)`);
    }
  } catch(e) {
    console.warn(`[geminiScriptGeneration] Could not load style guide: ${e.message}`);
  }

  // Combine system + user prompts + style guide for Gemini (doesn't have separate system param)
  let fullPrompt = `SYSTEM INSTRUCTIONS:
${systemPrompt}`;

  // Inject style guide if available
  if (styleGuide) {
    fullPrompt += `

STYLE GUIDE (follow this writing style and tone):
${styleGuide}`;
  }

  fullPrompt += `

USER TASK:
${userPrompt}`;

  // If retrying with feedback, append it
  if (previousScript && feedbackMsg) {
    fullPrompt += `

PREVIOUS ATTEMPT (HAD ISSUES):
${previousScript}

FEEDBACK FROM QA REVIEWER:
${feedbackMsg}

Please generate a COMPLETE REVISED script that fixes all the issues listed above.`;
  }

  // Scale maxOutputTokens based on content type to prevent truncation
  // Twitch Full (10 streamers × 3 clips = 72 scenes) needs ~20k tokens
  // NBA/News Full (10 items × 4 scenes = 42 scenes) needs ~12k tokens
  // Shorts need ~2k tokens
  // Gemini 2.5 Flash supports up to 65,536 output tokens
  const isShort = contentType.includes('-short');
  const isTwitch = contentType === 'twitch' || contentType === 'twitch-short';
  let maxOutputTokens;
  if (isShort) {
    maxOutputTokens = 4000; // short-form: 5 scenes ~200 words, raised from 2000 to prevent truncation before OUTRO
  } else if (isTwitch) {
    // Twitch: 1 + N*(1 + clips*2) + 1 scenes — scales fast
    // 10 streamers × 3 clips = 72 scenes → need ~20k tokens
    maxOutputTokens = 32000;
  } else {
    // NBA/News: 1 + N*4 + 1 scenes
    // 10 items = 42 scenes → need ~12k tokens
    maxOutputTokens = 16000;
  }

  try {
    const genResp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
      {
        contents: [{ parts: [{ text: fullPrompt }] }],
        generationConfig: {
          maxOutputTokens,
          temperature: 0.7,  // Slightly creative but controlled
          topP: 0.95,
          topK: 40
        }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
    );

    const candidate = genResp.data?.candidates?.[0];
    const finishReason = candidate?.finishReason;

    // Detect silent truncation — if Gemini hit token limit mid-output, the script will be incomplete
    if (finishReason === 'MAX_TOKENS') {
      console.error(`[geminiScriptGeneration] ⚠️ Gemini output TRUNCATED (finishReason=MAX_TOKENS, maxOutputTokens=${maxOutputTokens})`);
      throw new Error(`Gemini output truncated at token limit (${maxOutputTokens} tokens) — script is incomplete`);
    }

    let script = (candidate?.content?.parts || [])
      .map(p => p.text||'')
      .join('')
      .trim();

    if (!script || script.length < 100) {
      throw new Error('Gemini returned empty or too-short script');
    }

    // ── JSON output guard ────────────────────────────────────────────────────
    // Gemini sometimes outputs a JSON schema instead of the required
    // === SCENE HEADER === plain-text format. Detect and convert automatically.
    const looksLikeJson = script.startsWith('{') || script.startsWith('```json') || script.startsWith('```\n{');
    if (looksLikeJson) {
      console.warn('[geminiScriptGeneration] ⚠️ Gemini returned JSON — auto-converting to === HEADER === format');
      try {
        const raw = script.replace(/^```json\s*/i, '').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
        const parsed = JSON.parse(raw);
        const scenes = parsed.scenes || [];
        if (!scenes.length) throw new Error('JSON had no scenes array');
        const isNewsType = contentType === 'news' || contentType === 'news-short';
        const lines = [];
        let clipCounter = 0;
        for (const scene of scenes) {
          if (scene.type === 'source_clip') {
            // For News: rename generic scene_NN → STORY{N}_CLIP so QA regex matches
            let sceneId = scene.id;
            if (isNewsType) {
              clipCounter++;
              sceneId = `STORY${clipCounter}_CLIP`;
            }
            lines.push(`=== ${sceneId} ===`);
            lines.push('type: source_clip');
            lines.push('spokenText:');
          } else {
            lines.push(`=== ${scene.id} ===`);
            lines.push('type: avatar');
            lines.push(`spokenText: ${(scene.spokenText || '').trim()}`);
          }
          lines.push('');
        }
        script = lines.join('\n').trim();
        console.log(`[geminiScriptGeneration] ✅ JSON→plain-text conversion: ${scenes.length} scenes → ${script.length} chars`);
      } catch (jsonErr) {
        console.error(`[geminiScriptGeneration] JSON conversion failed: ${jsonErr.message} — using raw output`);
      }
    }

    console.log(`[geminiScriptGeneration] ✅ Script complete (finishReason=${finishReason}, length=${script.length} chars)`);
    return { script, tokenUsage: { input: 0, output: 0 } }; // Gemini doesn't expose token counts easily
  } catch(e) {
    console.error('[geminiScriptGeneration] API call failed:', e.message);
    throw new Error(`Gemini script generation failed: ${e.message}`);
  }
}


// ── Per-type, per-tone voice guide fragments ─────────────────────────────────
// Moved here from server.js during module split — getVoiceGuide() is the only consumer
const CWN_VOICE_GUIDES = {
  twitch: {
    deadpan: `You write scripts for ClipzWorld News (@clipznashite).
TONE: Norm MacDonald deadpan. Flat. Clinical. The clip is funnier than anything you could add.
- DO NOT explain the clip. Witness it. One observation after. Could be unrelated.
- NEVER say "incredible", "amazing", "crazy", "wild". Just say what happened.
- [beat] = pause. Use liberally.
OUTPUT FORMAT:
=== [STREAMER NAME] ===
ClipzWorld News. [Streamer name].
[beat]
[CLIP PLAYS HERE]
[beat]
[ONE flat observation. End the sentence. Do not explain it.]
Follow [streamer]. Link in description.`,

    warm: `You write scripts for ClipzWorld News (@clipznashite).
TONE: NBA Inside Stuff warmth applied to streamers. You genuinely like these people.
- Specificity is the warmth. Name the game they were playing. Name the moment.
- After the clip: one sentence that shows you paid attention. No hype words.
- [beat] = pause.
OUTPUT FORMAT:
=== [STREAMER NAME] ===
[Streamer name] was playing [game/context]. Here is what happened.
[beat]
[CLIP PLAYS HERE]
[beat]
[ONE warm but flat observation. Specific detail. End the sentence.]
Follow [streamer]. Link in description.`,

    chaotic: `You write scripts for ClipzWorld News (@clipznashite).
TONE: Space Ghost Coast to Coast. Confident non-sequiturs. Self-contradiction is fine.
- The intro can be completely unrelated to the streamer or clip. That is the bit.
- After the clip: say something that makes no sense but with total confidence.
- [beat] = pause. Use for comedic timing.
OUTPUT FORMAT:
=== [STREAMER NAME] ===
[Completely unrelated opening statement. Delivered with confidence.]
[beat]
[Streamer name].
[beat]
[CLIP PLAYS HERE]
[beat]
[Non-sequitur reaction. Confident. Wrong. Perfect.]
Follow [streamer]. Link in description.`
  },

  nba: {
    deadpan: `You write scripts for ClipzWorld News (@clipznashite).
TONE: Norm MacDonald flat delivery. State facts. One observation. Done.
- matchup → score → one stat → one flat observation.
- Zero debate, zero hot takes. Just what happened.
- NEVER say "incredible" or "amazing".
- [beat] = pause.
OUTPUT FORMAT:
=== GAME [N]: [AWAY] @ [HOME] ===
[Away] versus [Home]. Final. [score].
[beat]
[Top performer]. [X] points.
[beat]
[ONE flat observation. End the sentence.]
[beat]
[CLIP PLAYS HERE]`,

    warm: `You write scripts for ClipzWorld News (@clipznashite).
TONE: NBA Inside Stuff. You love the game. Warmth comes from specificity, not adjectives.
- Honor the play before explaining it. Name the player. Name what they did.
- The observation should make you want to rewatch the clip.
- [beat] = pause.
OUTPUT FORMAT:
=== GAME [N]: [AWAY] @ [HOME] ===
[Away] versus [Home]. [Score]. [Top performer] had [stat].
[beat]
[Warm setup about the player or play. Specific. No superlatives.]
[beat]
[CLIP PLAYS HERE]
[beat]
[ONE warm observation about what just happened. Honor the moment.]`,

    chaotic: `You write scripts for ClipzWorld News (@clipznashite).
TONE: Color commentary that has gone off the rails. Technically accurate, socially unhinged.
- State the play correctly. Then say something no color commentator would ever say.
- The observation is technically true but the framing is completely wrong.
- [beat] = pause.
OUTPUT FORMAT:
=== GAME [N]: [AWAY] @ [HOME] ===
[Away] versus [Home]. [Score].
[beat]
[Technically correct setup delivered like breaking news.]
[beat]
[CLIP PLAYS HERE]
[beat]
[Accurate observation. Completely wrong framing. Delivered with authority.]`
  },

  news: {
    deadpan: `You write scripts for ClipzWorld News (@clipznashite).
TONE: Norm MacDonald flat delivery. No warmth. The world is absurd. State it.
- Headline exactly as it happened. No adjectives.
- ONE observation that makes it MORE alarming, not less. Never explain it.
- [beat] = pause.
OUTPUT FORMAT:
=== STORY [N] ===
[Headline. Flat. Exactly as it happened.]
[beat]
[One sentence context if needed.]
[beat]
[ONE observation. Flat. Most absurd implication. Do not explain it.]
That story via [source].`,

    warm: `You write scripts for ClipzWorld News (@clipznashite).
TONE: Jon Stewart Daily Show. You care about this. One moment of controlled disbelief.
- State the headline. Then find the ONE thing that should concern everyone but doesn't.
- The observation lands harder if it sounds reasonable at first.
- [beat] = pause.
OUTPUT FORMAT:
=== STORY [N] ===
[Headline. Matter of fact.]
[beat]
[One sentence of context that sets up the observation.]
[beat]
[ONE observation. Sounds reasonable. Is actually devastating. Do not explain it.]
[beat]
That story via [source].`,

    chaotic: `You write scripts for ClipzWorld News (@clipznashite).
TONE: Local news anchor who has fully given up. Accurate reporting. Zero affect. Wrong emphasis.
- Report the headline correctly. Emphasize the wrong detail with complete confidence.
- The non-important part of the story gets treated as the main story.
- [beat] = pause.
OUTPUT FORMAT:
=== STORY [N] ===
[Headline. Correct. Delivered flatly.]
[beat]
[Zero-context pivot to the least important detail in the story.]
[beat]
[Treat that detail like it is the real story. Delivered with authority.]
That story via [source].`
  }
};

function getVoiceGuide(type, tone) {
  const guides = CWN_VOICE_GUIDES[type] || CWN_VOICE_GUIDES.twitch;
  if (typeof guides === 'string') return guides; // legacy
  return guides[tone] || guides.deadpan;
}


async function scrapeArticleVideo(articleUrl) {
  if (!articleUrl) return null;
  const YTDLP_PATH = '/opt/homebrew/bin/yt-dlp';
  try {
    // Step 1: Fetch article HTML and extract JSON-LD VideoObject embedUrl
    const resp = await axios.get(articleUrl, {
      timeout: 12000,
      maxRedirects: 5,
      headers: BROWSER_HEADERS
    });
    const html = resp.data || '';

    // Extract all JSON-LD blocks and find VideoObject
    const ldBlocks = [];
    const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = ldRe.exec(html)) !== null) ldBlocks.push(m[1]);

    let embedUrl = null;
    for (const block of ldBlocks) {
      try {
        const ld = JSON.parse(block.trim());
        if (ld && ld['@type'] === 'VideoObject') {
          const raw = ld.embedUrl || '';
          if (raw && raw.includes('brightcove') && raw.includes('videoId=')) {
            embedUrl = raw;
            break;
          }
          // YouTube embed fallback
          if (raw && raw.includes('youtube.com/embed/')) {
            const ytId = raw.split('/embed/')[1].split('?')[0];
            if (ytId) { embedUrl = `https://www.youtube.com/watch?v=${ytId}`; break; }
          }
        }
      } catch (_) {}
    }

    if (!embedUrl) {
      console.log(`[news-scrape-video] ℹ️  No VideoObject/embedUrl: ${articleUrl.slice(0, 60)}`);
      return null;
    }

    // Step 2: Run yt-dlp on the embed URL to get the HLS manifest URL
    const { execFile } = require('child_process');
    const ytResult = await new Promise((resolve) => {
      const proc = execFile(YTDLP_PATH,
        ['--skip-download', '--dump-json', '--no-warnings', embedUrl],
        { timeout: 15000, maxBuffer: 5 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err || !stdout) { resolve(null); return; }
          try {
            const d = JSON.parse(stdout);
            // Filter out live streams
            if (d.is_live || !d.duration || d.duration === 0) { resolve(null); return; }
            // Filter out live stream URLs by domain
            const url = d.url || '';
            if (url.includes('thehlive.com') || url.includes('/live')) { resolve(null); return; }
            resolve({ url, duration: d.duration || 0 });
          } catch (_) { resolve(null); }
        }
      );
    });

    if (!ytResult) {
      console.warn(`[news-scrape-video] ⚠️  yt-dlp failed for embed: ${embedUrl.slice(0, 80)}`);
      return null;
    }

    console.log(`[news-scrape-video] ✅ ${articleUrl.slice(0, 55)}... → ${ytResult.url.slice(0, 70)} (${ytResult.duration.toFixed(1)}s)`);
    return ytResult.url;
  } catch (e) {
    console.warn(`[news-scrape-video] ⚠️  Scrape failed for ${articleUrl.slice(0, 60)}...: ${e.message}`);
    return null;
  }
}


async function scrapeArticleOgImage(articleUrl) {
  if (!articleUrl) return null;
  try {
    const resp = await axios.get(articleUrl, {
      timeout: 10000,
      maxRedirects: 5,
        headers: BROWSER_HEADERS
    });
    const $ = cheerio.load(resp.data);
    // Try og:image first, fall back to twitter:image variants
    const imgUrl = $('meta[property="og:image"]').attr('content')
               || $('meta[name="twitter:image"]').attr('content')
               || $('meta[name="twitter:image:src"]').attr('content')
               || null;
    if (imgUrl) {
      console.log(`[og-scrape] ✅ ${articleUrl.slice(0, 60)}... → ${imgUrl.slice(0, 80)}`);
    } else {
      console.warn(`[og-scrape] ⚠️  No og:image found: ${articleUrl.slice(0, 60)}...`);
    }
    return imgUrl;
  } catch (e) {
    console.warn(`[og-scrape] ⚠️  Scrape failed for ${articleUrl.slice(0, 60)}...: ${e.message}`);
    return null;
  }
}


async function geminiAnalyzeClip(videoUrl, thumbnailUrl, contentType, metadata) {
  if (!GEMINI_APIKEY) return '';

  const videoPrompts = {
    twitch: `This is a Twitch clip by streamer "${metadata.streamer || 'unknown'}". Game/category: ${metadata.game || 'unknown'}. Clip title: "${metadata.title || ''}".
Analyze the FULL video with audio:
1. What is visually happening — describe the specific key moment
2. What does the streamer say verbally — quote any notable lines exactly
3. What emotion or reaction is visible
4. What makes this clip notable or shareable
Be specific, factual, 4-6 sentences. No hype language.`,

    nba: `This is an NBA game highlight: ${metadata.away || '?'} vs ${metadata.home || '?'}. Score: ${metadata.awayScore||'?'}-${metadata.homeScore||'?'}.
Analyze the FULL video with audio:
1. What specific play or sequence is shown
2. Which players are involved and what do they do
3. What do the announcers say about it
4. What is the game situation and significance
Be factual, 4-5 sentences.`,

    news: `This is a news video. Headline: "${metadata.title || '?'}"
Analyze the FULL video with audio:
1. Who is speaking and what key points do they make — quote directly if possible
2. What is shown visually
3. What is the core information being communicated
Be factual, 3-4 sentences.`
  };

  const thumbPrompts = {
    twitch: `Twitch clip thumbnail. Streamer: ${metadata.streamer||'?'}. Game: ${metadata.game||'?'}. Title: "${metadata.title||'?'}". Describe: what's visible, what the streamer reacts to, the specific moment shown. 2-3 sentences, factual.`,
    nba: `NBA highlight thumbnail. ${metadata.away||'?'} vs ${metadata.home||'?'}. Describe: what play is shown, players visible, game energy. 2-3 sentences, factual.`,
    news: `News thumbnail. Headline: "${metadata.title||'?'}". Describe: people/places visible, visual context for the story. 2-3 sentences, factual.`
  };

  // ── Try full video analysis first ────────────────────────────────
  const mp4Url = videoUrl || (contentType === 'twitch' ? twitchThumbToMp4(thumbnailUrl) : '');

  if (mp4Url) {
    // If videoUrl is a local file path (pre-downloaded by scraper), use it directly — skip download
    const isLocalFile = mp4Url && mp4Url.startsWith('/') && fs.existsSync(mp4Url);
    const tmpPath = isLocalFile ? mp4Url : path.join(TMP_DIR, `gemini_vid_${Date.now()}_${Math.random().toString(36).slice(2,7)}.mp4`);
    let geminiFile = null;
    try {
      if (isLocalFile) {
        // Pre-downloaded local file — skip all download logic, go straight to Gemini upload
        const localSize = fs.statSync(tmpPath).size;
        console.log(`[gemini-video] Using pre-downloaded local file: ${tmpPath} (${(localSize/1024/1024).toFixed(1)}MB)`);
      } else {
      // For Twitch: use yt-dlp (handles browser fingerprinting that blocks axios)
      // For ESPN/News: use axios (direct public MP4 links work fine)
      const isTwitch = contentType === 'twitch';
      const pageUrl  = metadata && metadata.pageUrl; // Twitch clip page URL if available

      if (isTwitch) {
        const isSignedCdn = mp4Url && mp4Url.includes('sig=');
        const ytDlpTarget = isSignedCdn ? mp4Url : (pageUrl || mp4Url);

        if (isSignedCdn) {
          // Signed CDN URL — download directly with axios + browser headers + Range request
          // Range: bytes=0-33554431 = first 32MB, well under Gemini's 34MB limit
          // Most video CDNs support Range requests (returns 206 Partial Content)
          const MAX_BYTES = GEMINI_FILE_LIMIT - (2 * 1024 * 1024); // 32MB to be safe
          console.log(`[gemini-video] CDN download (max ${(MAX_BYTES/1024/1024).toFixed(0)}MB): ${ytDlpTarget.slice(0, 80)}...`);
          const vidResp = await axios.get(ytDlpTarget, {
            responseType: 'arraybuffer',
            timeout: 60000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Referer': 'https://www.twitch.tv/',
              'Origin': 'https://www.twitch.tv',
              'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8',
              'Accept-Encoding': 'identity',
              'Connection': 'keep-alive',
              'Range': `bytes=0-${MAX_BYTES - 1}`
            }
          });
          const size = vidResp.data.byteLength;
          if (size < 1000) throw new Error(`CDN download returned ${size} bytes — blocked or empty`);
          // Accept 200 (full) or 206 (partial) — cap at GEMINI_FILE_LIMIT either way
          const finalBuf = Buffer.from(vidResp.data).slice(0, GEMINI_FILE_LIMIT);
          fs.writeFileSync(tmpPath, finalBuf);
          console.log(`[gemini-video] CDN ✓ ${(finalBuf.length/1024/1024).toFixed(1)}MB (${vidResp.status === 206 ? 'partial' : 'full'}) — uploading to Gemini...`);
        } else {
          // Page URL fallback — use yt-dlp (no max-filesize to avoid silent skips)
          console.log(`[gemini-video] yt-dlp (page-url): ${ytDlpTarget.slice(0, 80)}...`);
          await new Promise((res, rej) => {
            const { execFile } = require('child_process');
            const args = [
              '--quiet', '--no-warnings',
              '-f', 'best[ext=mp4]/best',
              '-o', tmpPath,
              '--no-playlist',
              '--no-part',
              ytDlpTarget
            ];
            execFile('yt-dlp', args, { timeout: 90000 }, (err, stdout, stderr) => {
              if (err) rej(new Error(`yt-dlp: ${stderr || err.message}`));
              else res();
            });
          });
          if (!fs.existsSync(tmpPath)) throw new Error('yt-dlp produced no output file');
          const size = fs.statSync(tmpPath).size;
          if (size < 1000) throw new Error(`yt-dlp output too small: ${size} bytes`);
          if (size > GEMINI_FILE_LIMIT) {
            // Trim to 34MB if too large
            const buf = fs.readFileSync(tmpPath).slice(0, GEMINI_FILE_LIMIT);
            fs.writeFileSync(tmpPath, buf);
          }
          console.log(`[gemini-video] yt-dlp ✓ ${(fs.statSync(tmpPath).size/1024/1024).toFixed(1)}MB — uploading to Gemini...`);
        }
      } else {
        // News/NBA: HLS or MP4 — route through universal downloader (yt-dlp → FFmpeg fallback)
        // This handles auth profiles (ESPN cookies, Akamai referer, etc.) from video_sources.json
        const { downloadVideoForAnalysis } = require('./downloader');
        console.log(`[gemini-video] HLS→MP4 via downloader (max 90s): ${mp4Url.slice(0, 80)}...`);
        await downloadVideoForAnalysis(mp4Url, tmpPath, { maxSecs: 90 });
        const size = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
        if (size < 1000) throw new Error(`FFmpeg HLS output too small: ${size} bytes`);
        console.log(`[gemini-video] HLS→MP4 ✓ ${(size/1024/1024).toFixed(1)}MB — uploading to Gemini...`);
      }
      } // end else (not isLocalFile)

      geminiFile = await uploadToGeminiFiles(tmpPath);
      geminiFile  = await waitForGeminiFile(geminiFile);

      const genResp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
        {
          contents: [{ parts: [
            { text: videoPrompts[contentType] || videoPrompts.twitch },
            { file_data: { mime_type: 'video/mp4', file_uri: geminiFile.uri } }
          ]}],
          generationConfig: { maxOutputTokens: 2000, temperature: 0.2 }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );

      const analysis = (genResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim();
      console.log(`[gemini-video] ✓ Video analysis complete (${analysis.length} chars)`);
      return analysis;

    } catch(e) {
      // Gate 0 is the guard — no thumbnail fallback. Return empty so Gate 0 hard-fails cleanly.
      console.error(`[gemini-video] Video analysis failed (no fallback): ${e.message}`, e.stack?.split('\n')[1]?.trim() || '');
      return '';
    } finally {
      if (!isLocalFile && fs.existsSync(tmpPath)) { try { fs.unlinkSync(tmpPath); } catch(e) {} }
      if (geminiFile) await deleteGeminiFile(geminiFile.name);
    }
  }

  // No video URL provided — return empty so Gate 0 catches it
  return '';
}


async function geminiAnalyzeThumbnail(thumbnailUrl, contentType, metadata) {
  return geminiAnalyzeClip('', thumbnailUrl, contentType, metadata);
}


function prioritizeNewsStories(stories) {
  const HIGH_PRIORITY_KEYWORDS = [
    'trump', 'iran', 'war', 'breaking', 'crisis', 'election',
    'attack', 'killed', 'dead', 'explosion', 'nuclear', 'sanctions',
    'ceasefire', 'invasion', 'protest', 'arrest', 'indicted', 'verdict'
  ];

  const scored = stories.map(story => {
    const text = ((story.title || '') + ' ' + (story.desc || '')).toLowerCase();
    let score = 0;
    for (const kw of HIGH_PRIORITY_KEYWORDS) {
      if (text.includes(kw)) score += 10;
    }
    return { story, score };
  });

  // Stable sort: higher score first, preserve original order for ties
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.story);
}


async function handleGenerateFullScript(req, res, saveJobCard, startHeyGenPoller, ajVideoPool = []) {
  const { type, items, date } = req.body;
  if (!GEMINI_APIKEY) return res.status(400).json({ error: 'GEMINI_API_KEY not set in .env' });

  const dateStr = date || new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  console.log(`[generate-full-script] type:${type} items:${items.length} date:${dateStr}`);

  // Initialize metrics tracking
  const jobId = `script_${type}_${Date.now()}`;
  initJobMetrics(jobId);
  const scriptGenTimer = new StageTimer(jobId, 'Script Generation');

  try {
    // ── Step 1: Source data fetching — delegated to per-content-type modules ──
    // Phase 3 universal architecture: each content type has a source module that
    // resolves, downloads, and analyzes its source materials, then returns a
    // normalized { analyses, orderedClipUrls, clipReportDataForQA } shape.
    // Fallback: if the module cannot be loaded, fall through to the original
    // inline logic below (marked PHASE3_INLINE_FALLBACK).
    console.log('[generate-full-script] Running Gemini analysis...');

    let analyses = [];
    let orderedClipUrls = []; // populated by source module — returned alongside script
    let clipReportDataForQA = null; // populated by twitch module, passed to claudeScriptQA

    let _sourceModuleLoaded = false;
    try {
      const { getContentTypeConfig } = require('./configLoader');
      const cfg = getContentTypeConfig(type);
      if (cfg && cfg.source && cfg.source.module) {
        const sourceModule = require(path.join(__dirname, cfg.source.module));
        const baseType = type.replace('-short', ''); // nba-short → nba, used for module selection
        const sourceResult = await sourceModule.fetchData({
          items,
          type,
          jobId,
          ajVideoPool,
          geminiAnalyzeClip,
          scrapeArticleOgImage,
          scrapeArticleVideo,
          prioritizeNewsStories,
          matchStoryToAjVideo
        }, cfg);

        // News Gate 0 failure — source module can't issue the HTTP response directly
        // because it doesn't have access to `res`. Handle it here.
        if (sourceResult.gate0Fail && sourceResult.gate0Data) {
          const { errorMsg, expectedClipCount, actualClipCount, missingStories } = sourceResult.gate0Data;
          console.error(`[news-clip-gate] ${errorMsg}`);
          return res.status(400).json({
            ok: false,
            error: errorMsg,
            errorCode: 'NEWS_CLIP_GATE_FAIL',
            expectedClipCount,
            actualClipCount,
            missingStories
          });
        }

        analyses            = sourceResult.analyses;
        orderedClipUrls     = sourceResult.orderedClipUrls;
        clipReportDataForQA = sourceResult.clipReportDataForQA;
        _sourceModuleLoaded = true;
        console.log(`[generate-full-script] ✅ Source module loaded: ${cfg.source.module}`);
      }
    } catch (sourceModuleErr) {
      console.warn(`[generate-full-script] ⚠️  Source module load failed (${sourceModuleErr.message}) — falling back to inline logic`);
    }

    // PHASE3_INLINE_FALLBACK — original inline source fetching logic.
    // Only runs if the source module above failed to load or threw.
    // Phase 4 target: remove this block once source modules are proven stable.
    if (!_sourceModuleLoaded && (type === 'twitch' || type === 'twitch-short')) {
      const allClips = [];
      items.forEach(item => {
        const clips = item.clips && item.clips.length ? item.clips : [{ thumbnailUrl: item.thumbnailUrl||'', title: item.title||'', game: item.game||'', url: item.url||'' }];
        clips.forEach(clip => allClips.push({
          pageUrl:               clip.url || '',
          mp4UrlDash:            clip.mp4Url || '',
          thumbnailUrl:          clip.thumbnailUrl || '',
          streamer:              item.streamer,
          title:                 clip.title || '',
          game:                  clip.game || '',
          isBackup:              clip.isBackup || false,
          targetClipsPerStreamer: item.targetClipsPerStreamer || 2
        }));
      });

      // Step 1: Resolve GQL MP4 URLs server-side in batches to avoid Twitch CDN rate limits
      // Batch 1: first 50%, then wait 3s, then Batch 2: remaining 50%
      // Apply display names to items before script generation
      items.forEach(function(item) {
        const twitch_name = (item.streamer || '').toLowerCase().replace(/\s+/g,'');
        item.displayName = STREAMER_DISPLAY_NAMES[twitch_name] || item.streamer;
      });
      console.log(`[generate-full-script] Resolving GQL MP4 URLs for ${allClips.length} clips (batched)...`);

      async function resolveClip(clip) {
        if (clip.mp4UrlDash && clip.mp4UrlDash.includes('sig=')) {
          clip.videoUrl = clip.mp4UrlDash;
          return;
        }
        const slug = extractTwitchSlug(clip.pageUrl);
        if (!slug) { clip.videoUrl = twitchThumbToMp4(clip.thumbnailUrl); return; }
        try {
          // Resolve two quality levels in parallel:
          // videoUrl = 720p for Gemini (under 34MB limit)
          // assemblyUrl = 1080p for FFmpeg assembly (best quality)
          const [resultLow, resultHigh] = await Promise.all([
            resolveTwitchClipMp4(slug, 'low'),
            resolveTwitchClipMp4(slug, 'high')
          ]);
          clip.videoUrl    = resultLow.mp4Url;
          clip.assemblyUrl = resultHigh.mp4Url;
          console.log(`[gql] ✓ ${clip.streamer}: Gemini=${resultLow.quality} Assembly=${resultHigh.quality}`);
        } catch(e) {
          console.warn(`[gql] ✗ ${clip.streamer}: ${e.message}`);
          clip.videoUrl = twitchThumbToMp4(clip.thumbnailUrl);
        }
      }

      // Resolve clips per streamer — use backups if primary clips fail GQL
      // Group by streamer, resolve in order, keep first targetClipsPerStreamer successes
      const resolvedByStreamer = {};
      const analysisClips = []; // final clips to analyze with Gemini

      // Get unique streamers in order
      const streamerOrder = [];
      allClips.forEach(c => { if (!resolvedByStreamer[c.streamer]) { resolvedByStreamer[c.streamer] = []; streamerOrder.push(c.streamer); } });

      // Batch resolve all clips (including backups), 2 waves with 3s pause
      const mid = Math.ceil(allClips.length / 2);
      console.log(`[gql] Batch 1: ${mid} clips...`);
      await Promise.all(allClips.slice(0, mid).map(resolveClip));
      if (allClips.length > mid) {
        console.log(`[gql] Waiting 3s before batch 2 (${allClips.length - mid} clips)...`);
        await new Promise(r => setTimeout(r, 3000));
        console.log(`[gql] Batch 2: ${allClips.length - mid} clips...`);
        await Promise.all(allClips.slice(mid).map(resolveClip));
      }

      // For each streamer, pick the first targetClipsPerStreamer clips that resolved OK
      // Fall back to backup clips if primary clips expired/were deleted
      let totalResolved = 0;
      streamerOrder.forEach(streamer => {
        const streamerClips = allClips.filter(c => c.streamer === streamer);
        const target = streamerClips[0] && streamerClips[0].targetClipsPerStreamer
          ? streamerClips[0].targetClipsPerStreamer
          : Math.ceil(streamerClips.length / 2);

        const good = streamerClips.filter(c => c.videoUrl && c.videoUrl.includes('sig='));
        const bad  = streamerClips.filter(c => !c.videoUrl || !c.videoUrl.includes('sig='));

        const picked = good.slice(0, target);
        if (picked.length < target && bad.length) {
          // Not enough good clips — fill with thumbnail-fallback clips
          bad.slice(0, target - picked.length).forEach(c => picked.push(c));
        }

        if (good.length < target) {
          console.log(`[gql] ${streamer}: ${good.length}/${target} resolved — ${target - good.length} expired/deleted, using backups`);
        }

        picked.forEach(c => analysisClips.push(c));
        totalResolved += good.slice(0, target).length;
      });

      console.log(`[generate-full-script] GQL resolved ${totalResolved}/${analysisClips.length} final clips with signed URLs. Analyzing with Gemini...`);

      // Build orderedClipUrls here while analysisClips is in scope
      // CRITICAL: url = assemblyUrl (high-quality CDN, may expire)
      //           pageUrl = permanent Twitch page URL → always re-resolve at assembly time
      //           geminiUrl = exact URL Gemini watched → used for QA verification
      orderedClipUrls = analysisClips.map(c => ({
        url:         c.assemblyUrl || c.videoUrl || c.mp4UrlDash || c.url || '',
        pageUrl:     c.pageUrl || c.url || '',
        geminiUrl:   c.videoUrl || '',  // exact URL Gemini watched — for QA mismatch detection
        streamer:    c.streamer || '',
        displayName: c.displayName || c.streamer || '',
        title:       c.title || '',
        isBackup:    c.isBackup || false
      }));
      console.log(`[generate-full-script] Built orderedClipUrls: ${orderedClipUrls.length} clips`);

      // ── Early download: cache clips for streamers with known CDN expiry issues ──
      // Maya's clips expire within ~1 hour. Pre-download them now so assembly
      // always has a valid local copy regardless of how long HeyGen takes.
      const HIGH_EXPIRY_STREAMERS = ['maya', 'extraemily'];
      const earlyDownloadDir = path.join(TMP_DIR, 'early_clips');
      if (!fs.existsSync(earlyDownloadDir)) fs.mkdirSync(earlyDownloadDir, { recursive: true });

      const earlyClips = orderedClipUrls.filter(c =>
        HIGH_EXPIRY_STREAMERS.includes((c.streamer || '').toLowerCase()) && c.url
      );

      if (earlyClips.length > 0) {
        console.log(`[generate-full-script] 📥 Early-downloading ${earlyClips.length} high-expiry clips (Maya/Emily)...`);
        for (const clip of earlyClips) {
          const slug = extractTwitchSlug(clip.pageUrl) || extractTwitchSlug(clip.url) || '';
          const fname = `early_${slug || Date.now()}_${clip.streamer}.mp4`;
          const dest = path.join(earlyDownloadDir, fname);
          if (fs.existsSync(dest)) { clip.localCache = dest; continue; }
          try {
            // Always use fresh GQL token for early download
            let dlUrl = clip.url;
            if (slug) {
              const fresh = await resolveTwitchClipMp4(slug, 'high');
              dlUrl = fresh.mp4Url;
            }
            await downloadFile(dlUrl, dest);
            const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
            if (size > 10000) {
              clip.localCache = dest;
              console.log(`[early-dl] ✅ Cached: ${fname} (${(size/1024/1024).toFixed(1)}MB)`);
            } else {
              console.warn(`[early-dl] ⚠️  Too small after download: ${fname}`);
              try { fs.unlinkSync(dest); } catch(e) {}
            }
          } catch(e) {
            console.warn(`[early-dl] ⚠️  Failed to early-download ${clip.streamer} clip: ${e.message}`);
          }
        }
      }

      // Replace allClips with the curated analysisClips for Gemini
      allClips.length = 0;
      analysisClips.forEach(c => allClips.push(c));

      // Step 2: Gemini watches each clip — batched to avoid CDN rate limiting
      // Split into 3 waves: first third, 5s pause, second third, 5s pause, final third
      const WAVE_SIZE = Math.ceil(allClips.length / 3);
      const waves = [
        allClips.slice(0, WAVE_SIZE),
        allClips.slice(WAVE_SIZE, WAVE_SIZE * 2),
        allClips.slice(WAVE_SIZE * 2)
      ].filter(w => w.length > 0);

      const flatAnalyses = [];
      for (let wi = 0; wi < waves.length; wi++) {
        if (wi > 0) {
          console.log(`[gemini] Wave ${wi+1}: waiting 5s before next batch of ${waves[wi].length} clips...`);
          await new Promise(r => setTimeout(r, 5000));
        }
        console.log(`[gemini] Wave ${wi+1}/${waves.length}: analyzing ${waves[wi].length} clips...`);
        const waveResults = await Promise.all(
          waves[wi].map(c => geminiAnalyzeClip(c.videoUrl, c.thumbnailUrl, 'twitch', {
            streamer: c.streamer, title: c.title, game: c.game, pageUrl: c.pageUrl
          }).then(analysis => {
            // Tag thumbnail-only analyses so Fix #6 can filter them out.
            // A clip is "video-analyzed" only if it had a signed CDN URL (sig=).
            const isVideoAnalyzed = !!(c.videoUrl && c.videoUrl.includes('sig='));
            return { analysis, isVideoAnalyzed };
          }))
        );
        flatAnalyses.push(...waveResults);
      }

      // Build analyses indexed by streamer name (not array position) to avoid order mismatch.
      // flatAnalyses is in streamerOrder sequence; items may be in a different order.
      // Keying by streamer name ensures Jason's analyses always go to Jason's item, etc.
      // Fix #6: flatAnalyses now contains {analysis, isVideoAnalyzed} objects — extract text + track video flag.
      const analysesByStreamer = {};
      const videoAnalyzedByStreamer = {}; // tracks how many clips had real video (sig=) per streamer
      let flatIdx = 0;
      streamerOrder.forEach(streamer => {
        const streamerClips = allClips.filter(c => c.streamer === streamer);
        const target = (streamerClips[0] && streamerClips[0].targetClipsPerStreamer)
          ? streamerClips[0].targetClipsPerStreamer
          : Math.ceil(streamerClips.length / 2);
        const count = Math.min(target, streamerClips.length);
        const slice = flatAnalyses.slice(flatIdx, flatIdx + count);
        // Extract plain text analyses (backward-compatible with both string and {analysis,isVideoAnalyzed} formats)
        analysesByStreamer[streamer] = slice.map(a => (a && typeof a === 'object') ? a.analysis : a);
        // Count how many clips had real video analysis (not thumbnail fallback)
        videoAnalyzedByStreamer[streamer] = slice.filter(a => (a && typeof a === 'object') ? a.isVideoAnalyzed : (a && a.length > 50)).length;
        flatIdx += count;
      });
      // Build clipsByStreamer map from analysisClips (the clips that were ACTUALLY analyzed)
      // analysisClips is in streamerOrder, so we must iterate streamerOrder to slice correctly.
      const clipsByStreamer = {};
      let clipIdx = 0;
      streamerOrder.forEach(streamer => {
        const streamerClips = allClips.filter(c => c.streamer === streamer);
        const target = (streamerClips[0] && streamerClips[0].targetClipsPerStreamer)
          ? streamerClips[0].targetClipsPerStreamer
          : Math.ceil(streamerClips.length / 2);
        const count = Math.min(target, streamerClips.length);
        clipsByStreamer[streamer] = analysisClips.slice(clipIdx, clipIdx + count);
        clipIdx += count;
      });

      // Update items[].clips to match the clips that were actually analyzed
      items.forEach(item => {
        const analyzedClips = clipsByStreamer[item.streamer] || [];
        item.clips = analyzedClips.map(c => ({
          url:          c.pageUrl,
          mp4Url:       c.videoUrl,
          assemblyUrl:  c.assemblyUrl,
          thumbnailUrl: c.thumbnailUrl,
          title:        c.title,
          game:         c.game,
          streamer:     c.streamer,
          isBackup:     c.isBackup || false
        }));
      });

      console.log('[clip-mapping] Updated items[].clips to match analysisClips order');
      items.forEach(item => {
        console.log(`  ${item.streamer}: ${item.clips.length} clips - ${item.clips.map(c => (c.title||'').slice(0,30)).join(', ')}`);
      });
      console.log('[clip-mapping] streamerOrder:', streamerOrder);
      console.log('[clip-mapping] items order:', items.map(i => i.streamer));

      // Capture clip report data for Gate 1 why-doc (pass or fail)
      // Snapshot allClips and analysisClips now — they may be mutated later
      clipReportDataForQA = {
        items,
        allClips: [...analysisClips], // allClips was replaced with analysisClips above
        streamerOrder: [...streamerOrder],
        analysisClips: [...analysisClips]
      };

      // Map analyses by streamer name (c918cad fix preserved)
      analyses = items.map(item => analysesByStreamer[item.streamer] || []);

      const geminiHits = flatAnalyses.filter(a => a && a.length > 50).length;
      console.log(`[generate-full-script] Gemini analyzed ${geminiHits}/${allClips.length} clips (${allClips.length - geminiHits} failed — Gate 0 will block if below threshold)`);

      // Fix #6: Filter out streamers with fewer than 2 real video clips (sig= URL).
      // Hard floor of 2 clips for long-form only — Bobby G's 7-scene block needs at least
      // 2 clips for setup/reaction variety. Short-form needs exactly 1 clip, so skip this guard.
      // Thumbnail fallback analyses are also >50 chars, so the old length check was broken —
      // it let streamers with 0 real clips through, causing Gemini to hallucinate content.
      if (type === 'twitch') {
        const MIN_CLIPS_PER_STREAMER = 2;
        const itemsBefore = items.length;
        const filteredPairs = items
          .map((item, i) => ({ item, analysis: analyses[i] }))
          .filter(({ item }) => (videoAnalyzedByStreamer[item.streamer] || 0) >= MIN_CLIPS_PER_STREAMER);
        if (filteredPairs.length < itemsBefore) {
          const dropped = items
            .filter(item => !filteredPairs.find(p => p.item.streamer === item.streamer))
            .map(item => `${item.streamer}(${videoAnalyzedByStreamer[item.streamer] || 0} clips)`);
          console.warn(`[generate-full-script] ⚠️  Dropping ${itemsBefore - filteredPairs.length} streamers with <2 real clips: ${dropped.join(', ')}`);
          items.splice(0, items.length, ...filteredPairs.map(p => p.item));
          analyses = filteredPairs.map(p => p.analysis);
        }
        console.log(`[generate-full-script] Streamers with ≥2 clips: ${items.length}/${itemsBefore} — ${items.map(i => i.streamer).join(', ')}`);
      } else {
        // twitch-short: 1 clip per streamer is correct
        console.log(`[generate-full-script] twitch-short: ${items.length} streamer(s), 1 clip each — skipping ≥2 clip guard`);
      }

    } else if (!_sourceModuleLoaded && (type === 'nba' || type === 'nba-short')) {
      // NBA: use stored ESPN highlight clip URLs for full video analysis
      // Gate 0: Drop games with no clipUrl, proceed with valid games only (count varies by day)
      const beforeDrop = items.length;
      const missingClipUrl = items.filter(item => !item.clipUrl);
      if (missingClipUrl.length > 0) {
        const missingGames = missingClipUrl.map(i => `${i.away || '?'} vs ${i.home || i.gameId || '?'}`).join(', ');
        console.warn(`[generate-full-script] Gate 0: Dropping ${missingClipUrl.length}/${beforeDrop} NBA games with no clip URL: ${missingGames}`);
        items.splice(0, items.length, ...items.filter(item => !!item.clipUrl));
      }
      if (items.length === 0) {
        const errMsg = `Gate 0 FAIL: No NBA games have highlight clip URLs today. Run SELECT GAMES → wait for scraper to complete → retry.`;
        console.error(`[generate-full-script] ${errMsg}`);
        throw new Error(errMsg);
      }
      console.log(`[generate-full-script] Analyzing ${items.length} NBA highlight clip${items.length !== 1 ? 's' : ''} (dropped ${beforeDrop - items.length} with no URL)...`);
      // Re-fetch fresh ESPN URLs immediately before analysis — article.video URLs expire in seconds
      await Promise.all(items.map(async (item) => {
        if (!item.gameId) return;
        try {
          const summaryUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${item.gameId}`;
          const resp = await axios.get(summaryUrl, { timeout: 10000 });
          const summaryData = resp.data || {};
          const articleVideos = (summaryData.article && summaryData.article.video) || [];
          if (articleVideos.length) {
            const v = articleVideos[0];
            // Prefer Akamai HLS (stable) over direct CDN MP4 (expires in seconds)
            const freshUrl = v.links?.source?.HLS?.HD?.href
                          || v.links?.source?.HLS?.href
                          || v.links?.source?.HD?.href;
            if (freshUrl) {
              item.clipUrl = freshUrl;
              console.log(`[nba-fresh-url] ✅ Refreshed clip URL for ${item.gameId} [${freshUrl.includes('.m3u8') ? 'HLS' : 'MP4'}]`);
            }
          }
        } catch(e) {
          console.warn(`[nba-fresh-url] Failed to refresh URL for ${item.gameId}: ${e.message}`);
        }
      }));
      analyses = await Promise.all(
        items.map(item => geminiAnalyzeClip(item.localPath || item.clipUrl||'', item.thumbnailUrl||'', 'nba', item))
      );
      let nbaHits = analyses.filter(a => a && a.length > 50).length;
      console.log(`[generate-full-script] Got ${nbaHits}/${items.length} NBA analyses (${nbaHits} video, ${items.length - nbaHits} thumbnail/fallback)`);

      // Gate 0: All games must have video analysis — thumbnail fallback = fabricated narration
      if (nbaHits < items.length) {
        console.warn(`[generate-full-script] Gate 0: ${nbaHits}/${items.length} video analyses — HLS URLs likely expired. Re-fetching fresh URLs and retrying...`);
        await Promise.all(items.map(async (item) => {
          if (!item.gameId) return;
          try {
            const summaryUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${item.gameId}`;
            const resp = await axios.get(summaryUrl, { timeout: 10000 });
            const articleVideos = ((resp.data || {}).article || {}).video || [];
            if (articleVideos.length) {
              const v = articleVideos[0];
              const freshUrl = v.links?.source?.HLS?.HD?.href || v.links?.source?.HLS?.href || v.links?.source?.HD?.href;
              if (freshUrl) { item.clipUrl = freshUrl; console.log(`[gate0-retry] ✅ Fresh URL for ${item.gameId}`); }
            }
          } catch(e) { console.warn(`[gate0-retry] Failed to refresh ${item.gameId}: ${e.message}`); }
        }));
        analyses = await Promise.all(
          items.map(item => geminiAnalyzeClip(item.localPath || item.clipUrl||'', item.thumbnailUrl||'', 'nba', item))
        );
        nbaHits = analyses.filter(a => a && a.length > 50).length;
        console.log(`[generate-full-script] Gate 0 retry: Got ${nbaHits}/${items.length} NBA analyses`);
        if (nbaHits < items.length) {
          const failedGames = items.filter((_, i) => !analyses[i] || analyses[i].length <= 50).map(g => `${g.away} vs ${g.home}`).join(', ');
          throw new Error(`Gate 0 FAIL: Only ${nbaHits}/${items.length} NBA clips analyzed after retry. Failed: ${failedGames}. HLS streams may be unavailable. Try again in a few minutes.`);
        }
      }

    } else if (!_sourceModuleLoaded) {
      // News: prioritize stories by urgency before Gemini analysis
      if (type === 'news' || type === 'news-short') {
        const prioritized = prioritizeNewsStories(items);
        const priorityChange = prioritized.map((s, i) => `${i+1}. ${(s.title||'').slice(0, 40)}`).join(', ');
        console.log(`[generate-full-script] Story priority order: ${priorityChange}`);
        items.splice(0, items.length, ...prioritized);
      }
      // ── Fix 8B: Scrape og:image per story for TV card background ──
      // ── Fix 9: Scrape real video clips from Al Jazeera articles ──
      // Both run in parallel with Gemini analysis for speed.
      // Fix 8B: populates item.heroImageUrl for the top-right OVERLAY_ZONE TV card.
      // Fix 9: populates item.videoUrl so Fix 1's orderedClipUrls filter picks it up.
      //   Strategy: JSON-LD VideoObject → Brightcove embed URL → yt-dlp HLS manifest.
      //   Hit rate: ~30-40% on mixed RSS feed (100% on /video/ path articles).
      //   Non-fatal: stories without video get avatar-only segments (same as before Fix 9).
      console.log(`[generate-full-script] Scraping og:image + video URLs for ${items.length} news articles...`);
      const ogImagePromises = items.map(item => scrapeArticleOgImage(item.link || item.url || ''));
      const videoScrapePromises = items.map(item => scrapeArticleVideo(item.link || item.url || ''));

      // News: try video URL from RSS enclosure first, then thumbnail + full article text
      console.log(`[generate-full-script] Analyzing ${items.length} news stories...`);
      const [ogImages, scrapedVideoUrls, analysesResult] = await Promise.all([
        Promise.all(ogImagePromises),
        Promise.all(videoScrapePromises),
        Promise.all(items.map(item => geminiAnalyzeClip(item.videoUrl||'', item.thumbnailUrl||'', 'news', item)))
      ]);
      analyses = analysesResult;

      // Attach scraped og:image URLs and video URLs to items
      items.forEach((item, i) => {
        item.heroImageUrl = ogImages[i] || item.thumbnailUrl || '';
        // Fix 9: attach scraped video URL — overrides any RSS enclosure URL
        // Fix 1's orderedClipUrls filter at line ~6758 picks this up automatically
        if (scrapedVideoUrls[i]) {
          item.videoUrl = scrapedVideoUrls[i];
        }
      });

      // ADD: Override with Puppeteer-scraped AJ video pool if available and better
      if (ajVideoPool && ajVideoPool.length > 0) {
        items.forEach(item => {
          const match = matchStoryToAjVideo(item.title || item.link || '', ajVideoPool);
          if (match) {
            item.videoUrl         = match.hlsUrl;
            item.pillarboxFilter  = match.pillarboxFilter || null; // null for landscape
            item.sourceOrientation = match.orientation;
            console.log(`[news-video-match] "${(item.title||'').slice(0,40)}" → ${match.orientation} HLS from ${match.articleUrl.slice(-60)}`);
          }
        });
        const poolHits = items.filter(i => i.sourceOrientation).length;
        console.log(`[news-video-match] ${poolHits}/${items.length} stories matched to AJ Puppeteer pool`);
      }

      const heroHits = items.filter(i => i.heroImageUrl).length;
      const videoHits = items.filter(i => i.videoUrl).length;
      console.log(`[generate-full-script] Got ${heroHits}/${items.length} og:image URLs (hero images for TV cards)`);
      console.log(`[generate-full-script] Got ${videoHits}/${items.length} news video URLs (Fix 9 — Al Jazeera Brightcove scrape)`);

      const newsHits = analyses.filter(a => a && a.length > 50).length;
      console.log(`[generate-full-script] Got ${newsHits}/${items.length} news analyses`);

      // ── Fix 25c: Pre-Gate-0 hard gate — block episode if any story lacks video ──
      // Fires BEFORE any Gemini/Claude/HeyGen spend.
      // Root cause: global RSS feed has ~20-30% video hit rate; /video/newsfeed/ URLs
      // have 100% hit rate. If the dashboard still sends mixed stories, gate them here.
      if (type === 'news') {
        const expectedClipCount = items.length;
        const actualClipCount = items.filter(i => i.videoUrl && typeof i.videoUrl === 'string').length;
        if (actualClipCount < expectedClipCount) {
          const missingStories = items
            .filter(i => !i.videoUrl)
            .map(i => i.title || i.link || '(unknown)');
          const reason = `Gate 0: News scraper found ${actualClipCount}/${expectedClipCount} clips with confirmed video. Missing stories: ${missingStories.slice(0, 3).join(' | ')}${missingStories.length > 3 ? ` (+${missingStories.length - 3} more)` : ''}. AJ sitemap may be down or returning no US content today.`;
          
          // Mark stuck via HTTP endpoint (avoids circular dependency on server.js)
          if (jobId) {
            try {
              await axios.post(`http://localhost:${process.env.PORT || 3000}/job/${jobId}/stuck`, {
                gate: 'gate0',
                reason,
                detail: { actualClipCount, expectedClipCount, missingStories: missingStories.slice(0, 5) }
              }, { timeout: 5000 });
            } catch (e) {
              console.warn(`[news-clip-gate] Failed to mark job stuck: ${e.message}`);
            }
          }
          
          const errorMsg = `NEWS_CLIP_GATE_FAIL: ${actualClipCount} of ${expectedClipCount} selected stories have video. Missing: ${missingStories.join(' | ')}. Retry with a different selection or wait for fresh content.`;
          console.error(`[news-clip-gate] ${errorMsg}`);
          return res.status(400).json({
            ok: false,
            error: errorMsg,
            errorCode: 'NEWS_CLIP_GATE_FAIL',
            expectedClipCount,
            actualClipCount,
            missingStories
          });
        }
        console.log(`[news-clip-gate] ✅ PASS — ${actualClipCount}/${expectedClipCount} stories have video, proceeding to Gemini analysis`);
      }

      // Build orderedClipUrls for News — one entry per story, using the video URL
      // that Gemini analyzed (same URL used for assembly — news clips don't expire like Twitch CDN)
      // FIX: orderedClipUrls was only populated in the Twitch block (line 6172 comment says so).
      // News and NBA were added later but this step was never added — causing 22_avatar_0_clips output.
      if (type === 'news') {
        // Fix 6: preserve story-index alignment — keep null entries for stories without clips.
        // Previously .filter(c => c.url) dropped failed scrapes, destroying index alignment:
        // stories 1/2/4 scraped → filtered array [clip1,clip2,clip4] → poller mispairs clip4 to STORY3_SETUP.
        // Now: null entries are preserved; heygen-poller skips them cleanly.
        orderedClipUrls = items.map((item, i) => {
          const videoUrl = item.videoUrl || item.clipUrl || null;
          return {
            url:        videoUrl,
            clipUrl:    videoUrl,
            pageUrl:    item.link || item.url || '',
            label:      `STORY${i + 1}_CLIP`,
            streamer:   `story_${i + 1}`,
            title:      item.title || `Story ${i + 1}`,
            storyIndex: i  // explicit index tag for alignment verification
          };
        });
        const clipsWithUrl = orderedClipUrls.filter(c => c.url).length;
        console.log(`[generate-full-script] Built News orderedClipUrls: ${clipsWithUrl}/${items.length} stories have clip URLs (${items.length - clipsWithUrl} null placeholders preserved for index alignment)`);
      }
    }

    // ── Gate Worker System: Gate 0 + Scaffold ────────────────────────────────
    // Build a minimal jobSpec from resolved items for the gate worker system.
    // Falls back gracefully if gate modules or DB are unavailable.
    const gwJobSpec = req.body.jobSpec || {
      jobId,
      customerId: 'c0',
      templateId: (type && type.includes('-short')) ? 'short-form' : 'long-form',
      contentType: type || 'news',
      order: {
        contentType: type || 'news',
        formType: (type && type.includes('-short')) ? 'short' : 'long',
        inputs: {
          items: orderedClipUrls.length > 0
            ? orderedClipUrls.map((c, i) => ({
                id: String(i),
                url: c.url || c.geminiUrl || '',
                title: c.title || c.displayName || '',
                sourceUrl: c.url || c.geminiUrl || ''
              }))
            : items.map((item, i) => ({
                id: String(i),
                url: item.videoUrl || item.clipUrl || item.url || '',
                title: item.title || item.displayName || item.name || String(i),
                sourceUrl: item.videoUrl || item.clipUrl || item.url || ''
              }))
        },
        output: {
          format: (type && type.includes('-short')) ? '9:16' : '16:9'
        }
      },
      state: { gateResults: {}, savedOutputs: {} },
      designSpec: { chrome: {}, audio: {}, resolution: {}, ffmpeg: {} },
      deliverySpec: { platforms: [] },
      commitments: {}
    };

    // Gate 0 — source confirmation (BLOCKING: hard fail stops pipeline before HeyGen)
    let gwGate0Result = null;
    try {
      const gate0 = require('./gates/gate0');
      const { saveGateResult: gwSaveGateResult } = require('./job_spec');
      const g0Readiness = gate0.canProduce(gwJobSpec);
      if (g0Readiness.ready) {
        gwGate0Result = await gate0.run(gwJobSpec);
        try { await gwSaveGateResult(jobId, 'gate0', gwGate0Result); } catch(e) {}
        console.log(`[gate-worker] Gate 0: ${gwGate0Result.passed ? 'PASS' : 'HARD FAIL'} — confirmedFormat=${gwGate0Result.confirmedFormat}`);
        if (!gwGate0Result.passed) {
          // No source clip confirmed — stop before burning HeyGen credits
          const reason = gwGate0Result.failReason || 'No confirmed source clip';
          console.error(`[gate-worker] Gate 0 HARD FAIL — pipeline stopped: ${reason}`);
          return res.status(422).json({ error: `Gate 0 failed: ${reason}`, gate: 'gate0', outcome: 'hard_fail' });
        }
      } else {
        console.warn(`[gate-worker] Gate 0 canProduce not ready: ${g0Readiness.reasons.join('; ')} — pipeline stopped`);
        return res.status(422).json({ error: `Gate 0 not ready: ${g0Readiness.reasons.join('; ')}`, gate: 'gate0', outcome: 'not_ready' });
      }
    } catch (gwG0Err) {
      console.error(`[gate-worker] Gate 0 error — pipeline stopped: ${gwG0Err.message}`);
      return res.status(500).json({ error: `Gate 0 error: ${gwG0Err.message}`, gate: 'gate0', outcome: 'error' });
    }

    // Scaffold generation — build structure, inject into Gemini prompt
    let gwScaffoldResult = null;
    try {
      const { generateScaffold } = require('./scaffold');
      const { saveOutput: gwSaveOutput } = require('./job_spec');
      // Build scaffold-specific jobSpec with items mapped for scaffold builder
      const scaffoldJobSpec = {
        ...gwJobSpec,
        order: {
          ...gwJobSpec.order,
          contentType: type || 'news',
          formType: (type && type.includes('-short')) ? 'short' : 'long',
          inputs: {
            ...gwJobSpec.order.inputs,
            items: items.map((item, i) => ({
              id: String(i),
              name: item.displayName || item.streamer || item.name || `ITEM${i + 1}`,
              title: item.title || item.displayName || item.name || String(i),
              teams: item.away && item.home ? `${item.away}_VS_${item.home}` : (item.title || ''),
              url: item.videoUrl || item.clipUrl || item.url || ''
            }))
          }
        }
      };
      gwScaffoldResult = generateScaffold(scaffoldJobSpec);

      // Write scaffold results back to job spec as authoritative source of truth
      // All downstream gates read sceneHeaders + expectedClipCount from designSpec
      if (gwJobSpec && gwScaffoldResult) {
        gwJobSpec.designSpec = gwJobSpec.designSpec || {};
        // Build items[] — maps ITEM1/STORY1/GAME1 scene IDs to customer data
        // Used by assembly chrome burn to get sidebar card data without contentType branching
        const structureItems = items.map((item, i) => ({
          sceneId:     `ITEM${i + 1}`,    // matches scaffold scene header prefix
          label:       item.displayName || item.streamer || item.name || item.title || `Item ${i + 1}`,
          category:    item.category || gwJobSpec.designSpec?.chrome?.activeCategory || gwJobSpec.contentType?.toUpperCase() || 'ITEM',
          data: {
            displayName:  item.displayName || item.name || item.title || `Item ${i + 1}`,
            url:          item.url || item.pageUrl || item.videoUrl || item.clipUrl || '',
            fact:         item.fact || item.origin || item.description || '',
            imageUrl:     item.imageUrl || item.thumbnailUrl || item.profileImage || '',
            matchup:      item.teams || item.title || '',
            twitchUsername: item.username || item.streamer || item.twitchUsername || ''
          }
        }));

        gwJobSpec.designSpec.sceneStructure = {
          sceneHeaders:       gwScaffoldResult.sceneHeaders,
          expectedSceneCount: gwScaffoldResult.expectedSceneCount,
          expectedClipCount:  gwScaffoldResult.expectedClipCount,
          templateId:         gwScaffoldResult.templateId || gwJobSpec.templateId,
          items:              structureItems,  // sidebar card data per item — universal
          generatedAt:        new Date().toISOString()
        };
        // expectedClipCount in designSpec is used by Gate 3a, Gate 3b, Gate 5
        gwJobSpec.designSpec.expectedClipCount = gwScaffoldResult.expectedClipCount;
        // Persist updated spec to DB
        try {
          const { updateJobSpec } = require('./job_spec');
          updateJobSpec(gwJobSpec.jobId, { designSpec: gwJobSpec.designSpec });
        } catch(e) { /* non-fatal */ }
      }

      try { await gwSaveOutput(jobId, 'scaffold', gwScaffoldResult); } catch(e) { /* DB may not have job yet */ }
      console.log(`[gate-worker] Scaffold: ${gwScaffoldResult.expectedSceneCount} scenes, ${gwScaffoldResult.expectedClipCount} clips — job spec updated as authoritative source`);
    } catch (gwScaffoldErr) {
      console.warn(`[gate-worker] Scaffold error (non-blocking): ${gwScaffoldErr.message}`);
    }

    // ── Step 2: Build the full Claude prompt ─────────────────────────
    const baseSystemPrompt = FULL_SCRIPT_SYSTEM[type] || FULL_SCRIPT_SYSTEM.twitch;
    const referenceUrls = req.body.referenceUrls || [];
    // Load stored style fingerprint (generated by /analyze-style-library)
    const STYLE_GUIDE_PATH = path.join(__dirname, '..', 'data', 'cwn_style_guides.json');
    let styleGuides = {};
    try { styleGuides = JSON.parse(fs.readFileSync(STYLE_GUIDE_PATH, 'utf8')); } catch(e) {}

    const baseType = type.replace('-short',''); // nba-short → nba
    const storedGuide = styleGuides[type] || styleGuides[baseType] || null;

    let refContext = '';
    if (storedGuide) {
      // Use pre-analyzed style fingerprint (best quality — Gemini watched the videos)
      refContext = `\n\nCWN STYLE FINGERPRINT (learned from reference videos):\n${storedGuide}`;
      console.log(`[generate-full-script] Using stored style fingerprint for ${type}`);
    } else if (referenceUrls.length > 0) {
      // Fallback: just mention the URLs (Gemini can't watch them here but Claude knows they exist)
      refContext = `\n\nREFERENCE STYLE: Match the voice, pacing, and humor from these reference videos:\n${referenceUrls.map((u,i) => `${i+1}. ${u}`).join('\n')}`;
      console.log(`[generate-full-script] No stored style guide — using URL hints only. Run /analyze-style-library to teach Gemini.`);
    }
    const systemPrompt = baseSystemPrompt + refContext;

    let userPrompt = '';
    if (type === 'nba' || type === 'nba-short') {
      const isShort = type === 'nba-short';
      if (isShort) {
        const g0 = items[0] || {};
        userPrompt = `Write a COMPLETE Other Side of the Pillow NBA Short script for ${dateStr}.

ONE PLAYER FOCUS:
Game: ${g0.away||'?'} @ ${g0.home||'?'} | Score: ${g0.awayScore||'?'}-${g0.homeScore||'?'} FINAL
Top performer: ${g0.leader||'Unknown'} — ${g0.leaderStat||'stats unavailable'}
${g0.injuries && g0.injuries.length ? 'Out: ' + g0.injuries.join(', ') : ''}
Gemini video analysis: ${analyses[0] || '⚠️ NO VIDEO ANALYSIS — write ONLY from stats/box score above. DO NOT invent specific plays, quotes, or moments not in the data.'}

Write the FULL SCRIPT using exactly:
- === NBA SHORT ===

Fully written, no brackets, no placeholders. Single [CLIP PLAYS HERE] after setup.
Target: 50-70 words spoken total.`;
      } else {
        // NBA scene structure: 4 scenes per game
        // INTRO → NARRATION (voiceover over clip) → RECAP (what audience just saw) → REACTION (deadpan line)
        // NARRATION contains [CLIP PLAYS HERE] — assembly swaps Bobby G video for ESPN highlight,
        // keeps Bobby G audio running over it. All 4 scenes go to HeyGen as normal avatar segments.
        const sceneHeaders = ['=== INTRO ==='];
        items.forEach((g, i) => {
          const gameLabel = `GAME${i+1}`;
          const awayClean = (g.away||'AWAY').toUpperCase().replace(/\s+/g, '_');
          const homeClean = (g.home||'HOME').toUpperCase().replace(/\s+/g, '_');
          const teams = `${awayClean}_${homeClean}`;
          sceneHeaders.push(`=== ${gameLabel}_${teams}_INTRO ===`);
          sceneHeaders.push(`=== ${gameLabel}_${teams}_NARRATION ===`);
          sceneHeaders.push(`=== ${gameLabel}_${teams}_RECAP ===`);
          sceneHeaders.push(`=== ${gameLabel}_${teams}_REACTION ===`);
        });
        sceneHeaders.push('=== OUTRO ===');
        const expectedScenes = sceneHeaders.length;

        userPrompt = `Write the COMPLETE Other Side of the Pillow NBA Compilation script for ${dateStr}.

${items.length} game${items.length > 1 ? 's' : ''} total. ${items.length} [CLIP PLAYS HERE] markers required (one per game, inside each NARRATION scene).

GAME DATA:
${items.map((g, i) => `
GAME ${i+1}: ${g.away || 'Away'} @ ${g.home || 'Home'}
Score: ${g.awayScore || '?'}-${g.homeScore || '?'} FINAL
${g.leader ? 'Top performer: ' + g.leader + (g.leaderStat ? ' — ' + g.leaderStat : '') : ''}
${g.injuries && g.injuries.length ? 'Out: ' + g.injuries.join(', ') : ''}
${g.awayRec || g.homeRec ? 'Records: ' + g.away + ' ' + (g.awayRec||'') + ' | ' + g.home + ' ' + (g.homeRec||'') : ''}
ESPN highlight clip duration: ${g.clipDuration ? Math.round(g.clipDuration) + 's' : 'unknown'}
NARRATION word count target: ${g.clipDuration ? Math.round(g.clipDuration * 2.5) + '–' + Math.round(g.clipDuration * 3) + ' words' : '70–90 words'}
Gemini video analysis: ${analyses[i] || '⚠️ NO VIDEO ANALYSIS — write ONLY from box score/game data above. DO NOT invent specific plays, quotes, or moments not in the data.'}
`).join('')}

🎬 SCENE STRUCTURE — ${expectedScenes} SCENES REQUIRED:
Write the FULL SCRIPT using these === SCENE HEADERS === exactly:

${sceneHeaders.join('\n')}

⚠️ FIRST SCENE MUST BE === INTRO === — do NOT start with a GAME scene.
⚠️ EXACTLY ${expectedScenes} SCENES — 1 INTRO + ${items.length} games × 4 scenes each + 1 OUTRO.
⚠️ COUNT your === HEADER === lines before submitting. Must equal ${expectedScenes}.

📝 WHAT EACH SCENE DOES:

=== INTRO ===
Bobby G on screen. 2-3 sentences. Episode intro, set the tone.

=== GAME#_[TEAMS]_INTRO ===
Bobby G on screen. 2-3 sentences. Introduce the matchup — teams, stakes, storyline.
Do NOT describe specific plays — save that for NARRATION.

=== GAME#_[TEAMS]_NARRATION ===
Bobby G's AUDIO plays OVER the ESPN highlight clip — his face is NOT shown, only the clip video.
Write present-tense play-by-play as if calling the game live — STUART SCOTT CADENCE ONLY.
Use specific player names and moments from Gemini's video analysis — do NOT invent generic descriptions.
Word count must match the "NARRATION word count target" for this game.

STUART SCOTT CADENCE — THIS IS THE ONLY ACCEPTABLE STYLE:
Short bursts. Named. Specific. Flat landing. No connecting tissue between facts.
✅ GOOD: "Maxey. Pull-up from the elbow. Third one in four minutes."
✅ GOOD: "Drummond under the glass. Two hands. Done."
✅ GOOD: "Banchero steps back. Corner three. Heels by two."
✅ GOOD: "Curry. Half-court. Two steps past the logo. Nobody close enough to matter."
✅ GOOD: "Carter strips it. Cota with the flip. Jameson. Twenty-three in the half."
❌ BAD: "He demonstrates his scoring prowess early in the contest." — generic filler, NEVER write this
❌ BAD: "Stephen Curry dribbles the ball on the perimeter. He rises and hits a critical go-ahead three-pointer." — run-on broadcast cliché, NEVER write this
❌ BAD: "Both teams looked to finish strong." — meaningless, NEVER write this
❌ BAD: "He puts an exclamation point on the game." — cliché, NEVER write this

Format exactly:
[narration text — Stuart Scott bursts, present tense, specific player names from Gemini analysis only]
[beat]
[CLIP PLAYS HERE]
[beat]

=== GAME#_[TEAMS]_RECAP ===
Bobby G back on screen. 1-2 sentences. Quick factual recap of what the audience just watched.
State what happened — score change, big play, momentum shift. No opinion here, just facts.

=== GAME#_[TEAMS]_REACTION ===
Bobby G on screen. EXACTLY 1 sentence. Flat deadpan Bobby G take on the game.
Do NOT recap — RECAP already covered that. Just the observation. More alarming, not less.

=== OUTRO ===
1-2 sentences. Sign-off. Must end with "Appreciate you."

✅ VALIDATION:
- Total scenes: EXACTLY ${expectedScenes}
- Total [CLIP PLAYS HERE]: EXACTLY ${items.length} (one per NARRATION scene)
- Each NARRATION: present-tense, specific to Gemini analysis, correct word count, has [beat][CLIP PLAYS HERE][beat]
- Each RECAP: 1-2 sentences, factual only, no opinion
- Each REACTION: exactly 1 sentence, deadpan, no recap
- OUTRO ends with "Appreciate you"
- NEVER invent plays not in Gemini's video analysis`;
      }


    } else if (type === 'news' || type === 'news-short') {
      const isShort = type === 'news-short';
      if (isShort) {
        const s0 = items[0] || {};
        userPrompt = `Write a COMPLETE Because the Light Was On Short script for ${dateStr}.

ONE STORY FOCUS:
Headline: ${s0.title || 'Unknown'}
Source: ${s0.source || 'Al Jazeera'}
Article text: ${s0.desc || 'No description available'}
Gemini analysis: ${analyses[0] || '⚠️ NO VIDEO ANALYSIS — write ONLY from article title/text above. DO NOT invent specific events, quotes, or details not in the article text.'}

Write the FULL SCRIPT using exactly:
- === NEWS SHORT ===

Fully written, no brackets, no placeholders.
Target: 50-70 words spoken total. One headline, one observation, done.`;
      } else {
        const expectedScenes = 1 + (items.length * 5) + 1; // INTRO + N×5 + OUTRO

        userPrompt = `Write the COMPLETE Because the Light Was On script for ${dateStr}.

You have been given a pool of ${items.length} news videos. You choose the editorial order — arrange them however makes the best show. All ${items.length} stories must be covered.

VIDEO POOL (all ${items.length} must appear in your script — you decide the order):
${items.map((s, i) => `
── VIDEO ${i+1} ──
Title: ${s.title || 'Untitled'}
${s.pubDate ? 'Published: ' + s.pubDate : ''}
Article text: ${s.desc || 'No description available'}
Gemini video analysis: ${analyses[i] || '⚠️ NO VIDEO ANALYSIS — write ONLY from article title/text above. DO NOT invent specific events, quotes, or details not provided.'}
`).join('')}

🎬 CRITICAL - SCENE STRUCTURE (${expectedScenes} SCENES REQUIRED):
Use these exact === SCENE HEADERS === in this exact order (replace # with story number 1-${items.length}):

=== INTRO ===
=== STORY1_INTRO ===
=== STORY1_SETUP ===
=== STORY1_CLIP ===
=== STORY1_SUMMARY ===
=== STORY1_REACTION ===
=== STORY2_INTRO ===
=== STORY2_SETUP ===
=== STORY2_CLIP ===
=== STORY2_SUMMARY ===
=== STORY2_REACTION ===
[...continue for all ${items.length} stories...]
=== OUTRO ===

⚠️ BINDING RULE — for each STORY# block, write ONLY from the video analysis you assign to it:
- Assign one video from the pool to STORY1, a different video to STORY2, etc.
- Every scene in STORY1_* must describe the video you assigned to STORY1 — nothing else.
- Every scene in STORY2_* must describe the video you assigned to STORY2 — nothing else.
- Do NOT mix details across stories. The video analysis for each story is the ONLY source of facts for that story's scenes.

⚠️ SCENE LENGTH RULES:
- INTRO: 2-3 sentences (episode intro, set the tone)
- STORY#_INTRO: 2-3 sentences (introduce the story's headline and main fact)
- STORY#_SETUP: EXACTLY 1 sentence — a NEW fact not mentioned in INTRO. Give viewer a reason to watch.
- STORY#_CLIP: type: source_clip, spokenText: (empty) — video plays here, no spoken words
- STORY#_SUMMARY: 1-2 sentences — factual recap of what the clip showed, no opinions
- STORY#_REACTION: EXACTLY 1 sentence — flat, deadpan Bobby G take. More alarming, not less.
- OUTRO: 1-2 sentences, MUST end with "Goodnight and good luck."

📝 PLAIN TEXT FORMAT — write each scene exactly like this example (replace the example text with your actual written content — NO brackets, NO placeholders):

=== INTRO ===
type: avatar
spokenText: Good evening. I'm Bobby G. Tonight — ceasefire talks, a new ambassador, and a twelve-year-old caught in the middle of someone else's war. Let's get into it.

=== STORY1_INTRO ===
type: avatar
spokenText: A ceasefire between Israel and Lebanon went into effect this morning. Ten days. Both sides agreed.

=== STORY1_SETUP ===
type: avatar
spokenText: The deal was brokered with U.S. involvement and gives both sides time to pull back heavy weapons from the border.

=== STORY1_CLIP ===
type: source_clip
spokenText:

=== STORY1_SUMMARY ===
type: avatar
spokenText: The clip showed the moment the ceasefire was announced — crowds in Beirut reacting in the streets, some celebrating, some waiting to see if it holds.

=== STORY1_REACTION ===
type: avatar
spokenText: Ten days is not a ceasefire. Ten days is a commercial break.

[...repeat the same structure for STORY2 through STORY${items.length} — each story gets INTRO, SETUP, CLIP, SUMMARY, REACTION...]

=== OUTRO ===
type: avatar
spokenText: That's all the time we have before the light bill is due. I'm Bobby G for ClipzWorld News. Keep your clips short and your takes shorter. Goodnight and good luck.

✅ VALIDATION:
- Total scenes: MUST BE EXACTLY ${expectedScenes}
- Total STORY#_CLIP scenes: MUST BE EXACTLY ${items.length}
- Every STORY#_CLIP has type: source_clip and empty spokenText
- Every video from the pool must appear in exactly one story block
- DO NOT mix details from different videos into the same story block
- DO NOT use [CLIP PLAYS HERE] — use the === STORY#_CLIP === / type: source_clip format above
- DO NOT use [beat] markers
- NEVER attribute to a source: no "According to Al Jazeera", "Sources report", etc.

Target: 100-140 words spoken per story (INTRO + SETUP + SUMMARY + REACTION combined).`;
      }

    } else { // twitch, twitch-short
      const isShort = type === 'twitch-short';
      if (isShort) {
        const c0 = items[0] || {};
        const clip0 = (c0.clips && c0.clips.length) ? c0.clips[0] : c0;
        const anal0 = Array.isArray(analyses[0]) ? analyses[0][0] : analyses[0];
        userPrompt = `Write a COMPLETE ClipzWorld News Twitch Short script for ${dateStr}.

ONE STREAMER / ONE CLIP:
ON-AIR NAME (use ONLY this name — never use the Twitch username): ${getDisplayName(c0.streamer||'')||c0.streamer||'Unknown'}
Twitch username (do NOT say this on air): ${c0.streamer||'Unknown'}
${c0.notes ? 'Notes: ' + c0.notes : ''}
Clip title: "${clip0.title||'N/A'}" | ${clip0.views ? clip0.views.toLocaleString() + ' views' : ''} | ${clip0.game||''}
Gemini video analysis: ${anal0 || '⚠️ NO VIDEO ANALYSIS — write ONLY from clip title/game/category above. DO NOT invent specific quotes, plays, or moments not provided.'}

Write the FULL SCRIPT using exactly:
- === TWITCH SHORT ===

Fully written, no brackets, no placeholders. Single [CLIP PLAYS HERE] marker.
Target: 40-60 words spoken total (before + after clip).`;
      } else {
        const streamerSections = items.map((c, i) => {
          const clips = c.clips && c.clips.length ? c.clips : [{ title: c.title||'N/A', views: c.views||0, game: c.game||'' }];
          const clipAnalyses = Array.isArray(analyses[i]) ? analyses[i] : [analyses[i]||''];
          const notesStr = c.notes ? 'Streamer context: ' + c.notes : '';
          const displayName = getDisplayName(c.streamer);
          const sceneNameBase = displayName.toUpperCase().replace(/\s+/g, '_');
          const clipLines = clips.map((clip, ci) => `
  ── CLIP ${ci+1} → feeds scenes === ${sceneNameBase}_CLIP${ci+1}_SETUP === and === ${sceneNameBase}_CLIP${ci+1}_REACTION ===
  Title: "${clip.title||'N/A'}" | ${clip.views ? clip.views.toLocaleString()+' views' : ''} | ${clip.game||''}
  Analysis (write CLIP${ci+1}_SETUP and CLIP${ci+1}_REACTION based on THIS analysis ONLY): ${clipAnalyses[ci] || '⚠️ NO VIDEO ANALYSIS — write ONLY from clip title/game above. DO NOT invent specific quotes, plays, or moments.'}`).join('');
          return `STREAMER ${i+1}:
ON-AIR NAME (use this name ONLY — never use the Twitch username): ${displayName}
Twitch username (do NOT use this in spoken text): ${c.streamer||'Unknown'}
${notesStr}${clipLines}`;
        }).join('\n\n');

        // Determine clips per streamer from actual data structure
        // FIX: Use > 0 check to avoid empty array [] evaluating as falsy (length=0)
        const clipsPerStreamer = (items[0]?.clips?.length > 0 ? items[0].clips.length : null) ?? req.body.clipsPerStreamer ?? 2;
        console.log(`[generate-full-script] clipsPerStreamer: ${clipsPerStreamer} (source: ${items[0]?.clips?.length > 0 ? 'items[0].clips' : req.body.clipsPerStreamer ? 'req.body' : 'default:2'}) | totalClips: ${items.length * clipsPerStreamer}`);
        const totalClipSlots = items.length * clipsPerStreamer;

        // Generate 72 scene headers (1 INTRO + 10 streamers × 7 scenes each + 1 OUTRO)
        const sceneHeaders = ['=== INTRO ==='];
        items.forEach(item => {
          // Fix: replace spaces with underscores to prevent Gemini header parsing failures
          // e.g. "Jay Cinco" → "JAY_CINCO" not "JAY CINCO" (URGENT_TEST_FAILURE_INVESTIGATION.md Fix #1)
          const name = getDisplayName(item.streamer).toUpperCase().replace(/\s+/g, '_');
          sceneHeaders.push(`=== ${name}_INTRO ===`);
          for (let i = 1; i <= clipsPerStreamer; i++) {
            sceneHeaders.push(`=== ${name}_CLIP${i}_SETUP ===`);
            sceneHeaders.push(`=== ${name}_CLIP${i}_REACTION ===`);
          }
        });
        sceneHeaders.push('=== OUTRO ===');
        const expectedScenes = sceneHeaders.length;

        userPrompt = `🚨🚨🚨 CRITICAL — READ THIS FIRST 🚨🚨🚨
YOUR OUTPUT MUST HAVE EXACTLY ${expectedScenes} SCENES (=== HEADERS ===).
NOT ${items.length} SECTIONS. NOT 10-12 SECTIONS. EXACTLY ${expectedScenes} SEPARATE === HEADER === SCENES.
ONE SCENE PER HEADER. DO NOT COMBINE. DO NOT SKIP ANY. COUNT YOUR === HEADERS === AND VERIFY YOU HAVE ${expectedScenes}.

⚠️ IMPORTANT: You are generating ${expectedScenes} scenes. That is 1 INTRO + ${items.length} streamers with ${clipsPerStreamer} clips each (${items.length} × ${1 + clipsPerStreamer * 2} scenes per streamer = ${items.length * (1 + clipsPerStreamer * 2)} scenes) + 1 OUTRO = ${expectedScenes} total.
DO NOT generate ${items.length} sections. Generate ${expectedScenes} individual === HEADER === scenes.

Write the COMPLETE ClipzWorld News Twitch compilation script for ${dateStr}.

🎬 CRITICAL - SCENE STRUCTURE (${expectedScenes} SCENES REQUIRED):
Write the FULL SCRIPT using these === SCENE HEADERS === exactly (one scene per header):

${sceneHeaders.join('\n')}

⚠️ YOU MUST OUTPUT EXACTLY ${expectedScenes} SCENES - ONE PER HEADER LISTED ABOVE.
⚠️ BEFORE YOU SUBMIT: Count the number of === HEADER === lines in your output. It must equal ${expectedScenes}. If it doesn't, add the missing scenes.

STREAMER DATA (use this to write content for each scene):
${items.length} streamers. ${clipsPerStreamer} clip${clipsPerStreamer>1?'s':''} per streamer. ${totalClipSlots} total [CLIP PLAYS HERE] slots.

${streamerSections}

⚠️ SCENE LENGTH RULES - PREVENTS HEYGEN TTS FROM RUSHING:
- Each scene = 1-3 sentences MAXIMUM
- Scenes longer than 3 sentences cause HeyGen TTS to rush/skip words/poor enunciation
- INTRO scene: 2-3 sentences (episode intro)
- [NAME]_INTRO scenes: 2-3 sentences (introduce streamer)
- [NAME]_CLIP#_SETUP scenes: EXACTLY 2 sentences (not 1, not 3) + [beat] + [CLIP PLAYS HERE] + [beat]
- [NAME]_CLIP#_REACTION scenes: EXACTLY 1 sentence (short, flat, deadpan)
- OUTRO scene: 1-2 sentences (sign-off)

📝 CONTENT STRUCTURE PER SCENE:

=== INTRO ===
[2-3 sentences. Episode intro. Set the tone.]

=== [NAME]_INTRO ===
[2-3 sentences. Introduce streamer. Set up first clip context.]

=== [NAME]_CLIP1_SETUP ===
[EXACTLY 2 sentences — not 1, not 3. First sentence: context about what's happening. Second sentence: specific setup for the clip.]
[beat]
[CLIP PLAYS HERE]
[beat]

=== [NAME]_CLIP1_REACTION ===
[EXACTLY 1 sentence. Short. Flat. Deadpan. No explanation.]

=== [NAME]_CLIP2_SETUP ===
[EXACTLY 2 sentences — not 1, not 3. First sentence: bridge from previous reaction. Second sentence: specific setup for clip 2.]
[beat]
[CLIP PLAYS HERE]
[beat]

=== [NAME]_CLIP2_REACTION ===
[EXACTLY 1 sentence. Short. Flat. Deadpan. No explanation.]

=== [NAME]_CLIP3_SETUP ===
[EXACTLY 2 sentences — not 1, not 3. First sentence: bridge from previous reaction. Second sentence: specific setup for clip 3.]
[beat]
[CLIP PLAYS HERE]
[beat]

=== [NAME]_CLIP3_REACTION ===
[EXACTLY 1 sentence. Short. Flat. Deadpan. No explanation.]
[beat]
Subscribe. Appreciate you.

=== OUTRO ===
That's all the time we have before the light bill is due. I'm Bobby G for ClipzWorld News. Keep your clips short and your takes shorter. Goodnight and good luck.

✅ VALIDATION CHECKLIST:
- Total scenes: MUST BE EXACTLY ${expectedScenes}
- Total [CLIP PLAYS HERE] markers: MUST BE EXACTLY ${totalClipSlots}
- Each SETUP scene: EXACTLY 2 sentences (not 1, not 3) + contains [beat] + [CLIP PLAYS HERE] + [beat]
- Each REACTION scene: EXACTLY 1 sentence, no more
- [beat] = 3-second pause — use before and after every [CLIP PLAYS HERE]
- Never explain the joke in reactions. Never recap what just happened.

NAME RULE: Bobby G ALWAYS refers to each streamer by their ON-AIR NAME only. Never use the Twitch username in spoken text. For example: say "Ron" not "StableRonaldo", say "Jay Cinco" not "Jaycinco", say "Yonna" not "YonnaJay".
PRONOUN RULES: use streamer context notes for pronouns. Never assume gender from name alone.
Total [CLIP PLAYS HERE] count must be exactly ${totalClipSlots}.
Target: 80-100 words spoken per streamer.`;
      }
    }

    // ── Gate Worker System: Inject scaffold into Gemini user prompt ──────────────
    // If scaffold was generated, append it so Gemini fills [DIALOGUE] slots only.
    if (gwScaffoldResult && gwScaffoldResult.scaffold && userPrompt) {
      userPrompt += `\n\nSCRIPT SCAFFOLD — Fill the [DIALOGUE] slots only. Do NOT add, remove, or move scene headers or [CLIP PLAYS HERE] markers. Do NOT change any text that is already written — pre-filled lines (INTRO, OUTRO, and any locked text) must be kept EXACTLY as written, word for word:\n\n${gwScaffoldResult.scaffold}`;
      console.log(`[gate-worker] Scaffold injected into Gemini prompt (${gwScaffoldResult.expectedSceneCount} scenes)`);
    }

    // ── Step 3: Gemini generates the complete script (with Gate 1 retry loop) ─────────────────
    // NEW ARCHITECTURE (as of April 2026): Gemini writes, Claude QAs
    // Reason: Claude kept generating 11 scenes instead of 72 due to learned "one section per streamer" pattern
    const MAX_RETRIES = 3;
    let script = '';
    let scriptQA = null;
    let geminiResult = null;
    let tokenUsage = { input: 0, output: 0 };
    let wordCount = 0;
    let estSecs = 0;
    let retryAttempt = 0;

    const client = new Anthropic();

    // Calculate expected scene count for Claude QA to validate
    let expectedScenes = 0;
    if (type === 'twitch' && !type.includes('-short')) {
      // FIX: Use > 0 check to avoid empty array [] evaluating as falsy (length=0) — matches line 6262
      const clipsPerStreamer = (items[0]?.clips?.length > 0 ? items[0].clips.length : null) ?? req.body.clipsPerStreamer ?? 2;
      const scenesPerStreamer = 1 + clipsPerStreamer * 2;
      expectedScenes = 1 + items.length * scenesPerStreamer + 1; // 1 INTRO + (streamers × scenes) + 1 OUTRO
    } else if (type === 'nba') {
      expectedScenes = 1 + (items.length * 4) + 1; // 1 INTRO + (games × 4 scenes: _INTRO, _NARRATION, _RECAP, _REACTION) + 1 OUTRO
    } else if (type === 'news') {
      // Red 4 hotfix 6: News uses 5 scenes per story (intro + setup + CLIP + summary + reaction)
      // Clip is now a standalone source_clip scene instead of [CLIP PLAYS HERE] text marker.
      expectedScenes = 1 + (items.length * 5) + 1; // 1 INTRO + (stories × 5 scenes each) + 1 OUTRO
    }
    // Shorts and other types: expectedScenes remains 0 (no validation)

    // Retry loop: Generate script + run Gate 1 QA, retry on FAIL up to 3 times
    while (retryAttempt < MAX_RETRIES) {
      retryAttempt++;
      const attemptLabel = retryAttempt > 1 ? ` (retry ${retryAttempt}/${MAX_RETRIES})` : '';
      console.log(`[generate-full-script] 📝 Generating script via Gemini${attemptLabel}...`);

      // Build feedback message if this is a retry
      let feedbackMsg = '';
      if (retryAttempt > 1 && scriptQA) {
        const fd = scriptQA.fixDirective || {};
        const parts = [];

        // ── 0. Wrong scene naming format ─────────────────────────────────────
        // Gemini sometimes uses generic scene_01, scene_02 names instead of
        // === INTRO ===, === STORY1_INTRO === etc. Detect and correct explicitly.
        const hasWrongNames = /===\s*scene_\d+\s*===/i.test(script);
        if (hasWrongNames) {
          parts.push(
            `🚨 WRONG SCENE HEADER NAMES — HARD FAIL\n` +
            `You used generic names like === scene_01 ===, === scene_02 ===.\n` +
            `These are WRONG. You MUST use the EXACT headers provided in the prompt:\n` +
            `=== INTRO ===\n=== STORY1_INTRO ===\n=== STORY1_SETUP ===\n=== STORY1_CLIP ===\n=== STORY1_SUMMARY ===\n=== STORY1_REACTION ===\n` +
            `=== STORY2_INTRO === ... and so on through STORY${items.length}_REACTION ===\n=== OUTRO ===\n` +
            `Do NOT invent your own scene names. Copy the exact headers from the prompt.`
          );
        }

        // ── 1. Scene count directive ──────────────────────────────────────────
        if (fd.missingScenes && fd.missingScenes.length > 0) {
          const sceneCountFromDeductions = scriptQA.deductions?.find(d => d.reason?.includes('SCENE COUNT'));
          const foundCount  = sceneCountFromDeductions?.reason?.match(/Found (\d+)/)?.[1] || '?';
          const expectCount = sceneCountFromDeductions?.reason?.match(/expected (\d+)/)?.[1] || expectedScenes;
          parts.push(
            `🚨 SCENE COUNT — HARD FAIL\n` +
            `You wrote ${foundCount} scenes. The script MUST contain EXACTLY ${expectCount} scenes.\n` +
            `These scene headers are MISSING from your output — add them:\n` +
            fd.missingScenes.map(s => `  • ${s}`).join('\n') + '\n' +
            `Do NOT rename, combine, or skip any scene. Each header must appear exactly once.`
          );
        }

        // ── 2. Fabricated content directives ─────────────────────────────────
        if (fd.fabricatedContent && fd.fabricatedContent.length > 0) {
          parts.push(
            `🚨 FABRICATED CONTENT — HARD FAIL\n` +
            `The following scenes describe events that are NOT in the clip. Rewrite them using ONLY the facts below:\n` +
            fd.fabricatedContent.map(f =>
              `  SCENE: ${f.scene}\n  PROBLEM: ${f.problem}\n  REQUIRED FIX: ${f.fix}`
            ).join('\n\n')
          );
        }

        // ── 3. Name error directives ──────────────────────────────────────────
        if (fd.nameErrors && fd.nameErrors.length > 0) {
          parts.push(
            `🚨 WRONG DISPLAY NAMES — HARD FAIL\n` +
            `These names were wrong. Replace them everywhere in the script:\n` +
            fd.nameErrors.map(n => `  "${n.used}" → "${n.correct}"`).join('\n')
          );
        }

        // ── 4. Structural issue directives ────────────────────────────────────
        if (fd.structuralIssues && fd.structuralIssues.length > 0) {
          parts.push(
            `🚨 STRUCTURAL ISSUES:\n` +
            fd.structuralIssues.map(s => `  • ${s}`).join('\n')
          );
        }

        // ── 5. Fallback if fixDirective was empty (parse failure or unexpected pass) ──
        if (parts.length === 0) {
          const deductionsList = scriptQA.deductions?.map(d => `- ${d.reason} (-${d.points} points)`).join('\n') || 'See detailed report below';
          parts.push(
            `POINT DEDUCTIONS FROM PREVIOUS ATTEMPT:\n${deductionsList}\n\n` +
            `FULL QA REPORT:\n${scriptQA.claudeReport || scriptQA.report}`
          );
        }

        feedbackMsg = `\n\n⚠️ PREVIOUS ATTEMPT FAILED GATE 1 QA (Score: ${scriptQA.score}/100)\n\n` +
          `These are the EXACT issues that caused the failure. Fix ALL of them before resubmitting:\n\n` +
          parts.join('\n\n') +
          `\n\nGenerate the COMPLETE script with ALL issues above resolved. Do not leave any issue partially fixed.`;

        console.log(`[generate-full-script] 🔄 Gate 1 retry with structured fix directive: ` +
          `${fd.missingScenes?.length || 0} missing scenes, ` +
          `${fd.fabricatedContent?.length || 0} fabricated scenes, ` +
          `${fd.nameErrors?.length || 0} name errors, ` +
          `${fd.structuralIssues?.length || 0} structural issues`);
      }

      // Call Gemini to generate the script
      try {
        geminiResult = await geminiScriptGeneration(userPrompt, systemPrompt, {
          previousScript: script || null,
          feedbackMsg: feedbackMsg,
          contentType: type
        });
        script = geminiResult.script;
        tokenUsage = geminiResult.tokenUsage;

        // ── Post-process: normalize spaces→underscores inside === HEADERS ===
        // Gemini sometimes writes "=== JAY CINCO_INTRO ===" despite prompt using "JAY_CINCO"
        // This replaces spaces within the header name (between === and ===) with underscores
        // e.g. "=== JAY CINCO_INTRO ===" → "=== JAY_CINCO_INTRO ===" (server.js:~6516)
        if (script && typeof script === 'string') {
          script = script.replace(/===\s+([^=]+?)\s+===/g, (match, name) => {
            const normalized = name.trim().replace(/\s+/g, '_');
            return `=== ${normalized} ===`;
          });
        }

        // ── Post-process: inject missing === INTRO === header ───────────────
        // Gemini sometimes writes the intro text without the === INTRO === header,
        // jumping straight to === GAME1_... ===. The text is correct but the header
        // is missing, causing Gate 1 scene count to be off by 1.
        // Fix: if script doesn't start with === INTRO === but has text before the
        // first === GAME or === STORY header, inject === INTRO === at the top.
        if (script && typeof script === 'string' && !script.trimStart().startsWith('=== INTRO ===')) {
          const firstGameHeader = script.search(/===\s*(GAME\d|STORY\d)/);
          if (firstGameHeader > 0) {
            const textBefore = script.slice(0, firstGameHeader).trim();
            if (textBefore.length > 0) {
              console.warn('[geminiScriptGeneration] ⚠️ Missing === INTRO === header — injecting above orphaned intro text');
              script = '=== INTRO ===\n' + textBefore + '\n\n' + script.slice(firstGameHeader);
            } else {
              // No text before first game — inject empty INTRO so Gate 1 scene count is correct
              console.warn('[geminiScriptGeneration] ⚠️ Missing === INTRO === header and no intro text — injecting placeholder');
              script = '=== INTRO ===\nHello everyone! You are tuning into The Other Side of the Pillow brought to you by ClipzWorld News. Where we appreciate all of yesterday\'s games in the association. I am your host Bobby G. Let\'s get to it.\n\n' + script;
            }
          }
        }
      } catch(e) {
        console.error(`[generate-full-script] Gemini script generation failed: ${e.message}`);
        script = `[ERROR: Gemini script generation failed: ${e.message}]`;
        // Force fail this attempt
        scriptQA = { score: 0, outcome: 'fail', passed: false, outcomeLabel: '❌ HARD FAIL', deductions: [{ points: 100, reason: `Gemini API error: ${e.message}` }], report: `Gemini script generation failed: ${e.message}` };
        console.log(`[generate-full-script] Gate 1 Script QA: ${scriptQA.outcomeLabel} (${scriptQA.score}/100)`);
        // Skip to retry loop condition check
        if (retryAttempt < MAX_RETRIES) {
          console.log(`[generate-full-script] ❌ Gate 1 FAIL — Retrying script generation (attempt ${retryAttempt}/${MAX_RETRIES})...`);
          continue;
        } else {
          console.log(`[generate-full-script] ❌ Gate 1 FAIL — Max retries (${MAX_RETRIES}) reached. Giving up.`);
          break;
        }
      }

      wordCount = script.split(/\s+/).filter(w => w.length > 0).length;
      estSecs   = Math.round((wordCount / 130) * 60);
      console.log(`[generate-full-script] Script generated by Gemini: ${wordCount} words, ~${Math.floor(estSecs/60)}m ${estSecs%60}s`);

      // ── Gate 1: Script QA — Claude reviews Gemini's script ──────────
      // Derive clipsPerStreamer from the actual items array (mirrors the same logic
      // at line 6736 used for Gemini script generation). The dashboard's
      // callFullScriptServer() does NOT send req.body.clipsPerStreamer, so trusting
      // it caused Gate 1 to grade against a hardcoded fallback of 2 while Gemini
      // wrote against items[0].clips.length. Source-of-truth must be the items
      // array — whatever streamer qualified, with however many clips they brought.
      const gate1ClipsPerStreamer = (items[0]?.clips?.length > 0 ? items[0].clips.length : null) ?? req.body.clipsPerStreamer ?? 2;
      console.log(`[generate-full-script] 🔍 Running Gate 1 Script QA (Claude reviews Gemini's script) — clipsPerStreamer=${gate1ClipsPerStreamer}...`);
      scriptQA = await claudeScriptQA(script, analyses, {
        contentType: type,
        streamers: (type === 'twitch' || type === 'twitch-short') ? items.map(s => ({ displayName: s.displayName || s.name || s, twitchUsername: s.username || s }))
                 : (type === 'nba'    || type === 'nba-short')    ? items.map(g => ({ displayName: `${g.away} vs ${g.home}`, twitchUsername: g.gameId || '' }))
                 : (type === 'news'   || type === 'news-short')   ? items.map(s => ({ displayName: s.title || s.link || '', twitchUsername: '' }))
                 : [],
        clipsPerStreamer: gate1ClipsPerStreamer,
        jobId: `${type}_${dateStr}_${Date.now()}`,
        expectedScenes: expectedScenes,
        clipReportData: clipReportDataForQA
      });

      // ── Gate Worker System: gate1Worker is now AUTHORITATIVE for Gate 1 decision ──
      // claudeScriptQA result is kept as fallback only. gate1Worker score wins.
      try {
        const gate1 = require('./gates/gate1');
        const { saveGateResult: gwSaveG1Result } = require('./job_spec');
        const gwJobSpecWithScript = { ...gwJobSpec, filledScript: script };
        if (gate1.canProduce(gwJobSpecWithScript).ready) {
          const gwG1Result = await gate1.run(gwJobSpecWithScript, script, gwGate0Result || {});
          try { await gwSaveG1Result(jobId, 'gate1', gwG1Result); } catch(e) {}
          console.log(`[gate-worker] Gate 1 new: ${gwG1Result.outcome} (score ${gwG1Result.score}/100)`);
          // gate1Worker is authoritative — override claudeScriptQA result
          scriptQA = {
            score:        gwG1Result.score,
            outcome:      gwG1Result.passed ? 'pass' : (gwG1Result.outcome === 'sendback' ? 'sendback' : 'fail'),
            outcomeLabel: gwG1Result.passed ? '✅ PASS' : (gwG1Result.outcome === 'sendback' ? '🔄 SENDBACK' : '❌ HARD FAIL'),
            passed:       gwG1Result.passed,
            deductions:   gwG1Result.deductions || [],
            fixDirective: gwG1Result.fixDirective || {},
            report:       gwG1Result.report || ''
          };
          console.log(`[generate-full-script] Gate 1 Script QA: ${scriptQA.outcomeLabel} (${scriptQA.score}/100)`);
        } else {
          console.log(`[gate-worker] Gate 1 canProduce not ready — keeping claudeScriptQA result`);
        }
      } catch (gwG1Err) {
        console.warn(`[gate-worker] Gate 1 error — keeping claudeScriptQA fallback: ${gwG1Err.message}`);
      }

      // ── Gate 1 Auto-Action (Fix 5) ──────────────────────────────────
      const { action, directive, reason } = autoAction(1, scriptQA.score, {
        jobId,
        contentType: type,
        retryCount: retryAttempt - 1
      });
      logger.info({ gate: 1, score: scriptQA.score, action, directive, reason }, 'Gate 1 auto-action');

      if (action === 'proceed') {
        console.log(`[generate-full-script] ✅ Gate 1 AUTO-ACTION: ${action} — ${reason}`);
        // Continue to HeyGen send below
      } else if (action === 'manual_review') {
        console.log(`[generate-full-script] ⏸  Gate 1 AUTO-ACTION: ${action} — ${reason}`);
        // Save directive to job card, pause pipeline
        scriptQA.autoAction = { action, directive, reason };
        // Break retry loop — manual review required
        break;
      } else if (action === 'regenerate_script') {
        console.log(`[generate-full-script] 🔄 Gate 1 AUTO-ACTION: ${action} — ${reason}`);
        // Retry loop will continue if retryAttempt < MAX_RETRIES
        if (retryAttempt >= MAX_RETRIES) {
          console.log(`[generate-full-script] ❌ Gate 1 max retries reached — cannot regenerate`);
          break;
        }
        // Continue to retry logic below
      }

      // Break conditions:
      // 1. PASS (score >= 90) → proceed to HeyGen
      // 2. FAIL due to CLIP MATCH only → try claudeScriptFix before next Gemini retry
      // 3. FAIL + max retries reached → give up (no manual_review zone — threshold is 90)
      if (scriptQA.outcome === 'pass') {
        console.log(`[generate-full-script] ✅ Gate 1 PASS — Breaking retry loop (attempt ${retryAttempt}/${MAX_RETRIES})`);
        break;
      } else {
        // Try Claude surgical fix whenever structure is intact but content is wrong.
        // Fires before every Gemini retry — Claude reads the QA report and fixes
        // broken scenes directly rather than having Gemini regenerate the whole script.
        const hasStructuralFail = scriptQA.deductions && scriptQA.deductions.some(d =>
          d.reason && (d.reason.includes('SCENE COUNT') || d.reason.includes('CLIP COUNT') ||
                       d.reason.includes('SCENE NAMING') || d.reason.includes('Appreciate you'))
        );
        const hasContentFail = scriptQA.claudeReport && (
          scriptQA.claudeReport.includes('STORY MATCH') ||
          scriptQA.claudeReport.includes('CLIP MATCH') ||
          scriptQA.claudeReport.includes('STORY ACCURACY') ||
          scriptQA.claudeReport.includes('GAME ACCURACY') ||
          scriptQA.claudeReport.includes('fabricatedContent')
        );
        const shouldClaudeFix = !hasStructuralFail && (hasContentFail || scriptQA.fixDirective?.fabricatedContent?.length > 0);

        if (shouldClaudeFix) {
          console.log('[generate-full-script] [FIX] Gate 1 content mismatch — Claude surgical fix...');
          const fixResult = await claudeScriptFix(script, analyses, {
            contentType: type,
            streamers: (type === 'twitch' || type === 'twitch-short') ? items.map(s => ({ displayName: s.displayName || s.name || s, twitchUsername: s.username || s }))
                 : (type === 'nba'    || type === 'nba-short')    ? items.map(g => ({ displayName: `${g.away} vs ${g.home}`, twitchUsername: g.gameId || '' }))
                 : (type === 'news'   || type === 'news-short')   ? items.map(s => ({ displayName: s.title || s.link || '', twitchUsername: '' }))
                 : [],
            clipsPerStreamer: gate1ClipsPerStreamer,
            qaReport: scriptQA.claudeReport || scriptQA.report,
            jobId: type + '_' + dateStr + '_' + Date.now()
          });
          if (fixResult.fixed) {
            script = fixResult.script;
            console.log('[generate-full-script] [FIX] Claude fix applied -- re-running Gate 1 QA...');
            scriptQA = await claudeScriptQA(script, analyses, {
              contentType: type,
              streamers: (type === 'twitch' || type === 'twitch-short') ? items.map(s => ({ displayName: s.displayName || s.name || s, twitchUsername: s.username || s }))
                 : (type === 'nba'    || type === 'nba-short')    ? items.map(g => ({ displayName: `${g.away} vs ${g.home}`, twitchUsername: g.gameId || '' }))
                 : (type === 'news'   || type === 'news-short')   ? items.map(s => ({ displayName: s.title || s.link || '', twitchUsername: '' }))
                 : [],
              clipsPerStreamer: gate1ClipsPerStreamer,
              jobId: type + '_' + dateStr + '_' + Date.now(),
              expectedScenes: expectedScenes,
              clipReportData: clipReportDataForQA
            });
            console.log(`[generate-full-script] Gate 1 QA after Claude fix: ${scriptQA.outcomeLabel} (${scriptQA.score}/100)`);
            if (scriptQA.outcome === 'pass') {
              console.log('[generate-full-script] [FIX] Claude fix worked -- Gate 1 PASS');
              break;
            }
          }
        }

        if (retryAttempt < MAX_RETRIES) {
          console.log(`[generate-full-script] ❌ Gate 1 FAIL — Retrying script generation (attempt ${retryAttempt}/${MAX_RETRIES})...`);
          // Continue loop to retry
        } else {
          console.log(`[generate-full-script] ❌ Gate 1 FAIL — Max retries (${MAX_RETRIES}) reached. Giving up.`);
          
          // Mark job stuck after retry exhaustion
          const reason = `Gate 1: Script failed after ${MAX_RETRIES} retries. Final score: ${scriptQA.score}/100. Issues: ${scriptQA.deductions?.map(d => d.reason).slice(0, 3).join('; ') || 'See QA report'}`;
          if (jobId) {
            try {
              await axios.post(`http://localhost:${process.env.PORT || 3000}/job/${jobId}/stuck`, {
                gate: 'gate1',
                reason,
                detail: { 
                  score: scriptQA.score, 
                  retries: MAX_RETRIES, 
                  deductions: scriptQA.deductions?.slice(0, 5) || [],
                  fixDirective: scriptQA.fixDirective || {}
                }
              }, { timeout: 5000 });
            } catch (e) {
              console.warn(`[generate-full-script] Failed to mark job stuck: ${e.message}`);
            }
          }
          
          break;
        }
      }
    }

    // Scripts are plain-text === HEADER === format — no JSON directive processing needed.
    // Strip CAPTION: line before sending to HeyGen — it's metadata for overlay burn, not dialogue.
    // Bobby G should NOT speak the caption text aloud.
    let scriptForHeygen = script.replace(/^CAPTION:\s*.+$/mg, '').replace(/\n{3,}/g, '\n\n').trim();

    // ── News: rebuild orderedClipUrls from script order (not scrape order) ──
    // Gemini chose the editorial order. Parse STORY1_INTRO, STORY2_INTRO... from the
    // final passing script, extract each story's title from spokenText, match back to
    // the video pool by title similarity to get the correct HLS URL for each slot.
    if (type === 'news' && scriptQA.outcome === 'pass') {
      try {
        const storyBlocks = [];
        // Extract each STORY#_INTRO spoken text to identify which story Gemini put in each slot
        const introPattern = /===\s+STORY(\d+)_INTRO\s+===[\s\S]*?spokenText:\s*([^\n]+(?:\n(?!===)[^\n]+)*)/g;
        let introMatch;
        while ((introMatch = introPattern.exec(script)) !== null) {
          const slotNum = parseInt(introMatch[1], 10);
          const spokenText = introMatch[2].trim();
          storyBlocks.push({ slotNum, spokenText });
        }

        // Build pool lookup: title → item (for URL retrieval)
        const pool = items.map((item, i) => ({
          title: (item.title || '').toLowerCase(),
          url: item.videoUrl || item.clipUrl || null,
          item,
          originalIndex: i
        }));

        const newOrderedClipUrls = [];
        const usedIndices = new Set();

        for (const block of storyBlocks.sort((a, b) => a.slotNum - b.slotNum)) {
          // Find the pool item whose title best matches the spoken intro text
          let bestMatch = null;
          let bestScore = 0;
          for (let pi = 0; pi < pool.length; pi++) {
            if (usedIndices.has(pi)) continue;
            const poolTitle = pool[pi].title;
            // Score: count words from pool title that appear in the spoken text
            const titleWords = poolTitle.split(/\s+/).filter(w => w.length > 3);
            const spokenLower = block.spokenText.toLowerCase();
            const hits = titleWords.filter(w => spokenLower.includes(w)).length;
            const score = titleWords.length > 0 ? hits / titleWords.length : 0;
            if (score > bestScore) { bestScore = score; bestMatch = pi; }
          }
          if (bestMatch !== null && bestScore > 0.2) {
            usedIndices.add(bestMatch);
            const matched = pool[bestMatch];
            newOrderedClipUrls.push({
              url:        matched.url,
              clipUrl:    matched.url,
              pageUrl:    matched.item.link || matched.item.url || '',
              label:      `STORY${block.slotNum}_CLIP`,
              streamer:   `story_${block.slotNum}`,
              title:      matched.item.title || `Story ${block.slotNum}`,
              storyIndex: block.slotNum - 1
            });
            console.log(`[news-clip-reorder] STORY${block.slotNum} → "${matched.item.title?.slice(0,40)}" (match score ${(bestScore*100).toFixed(0)}%)`);
          } else {
            // No match found — preserve null placeholder for index alignment
            newOrderedClipUrls.push({
              url: null, clipUrl: null, pageUrl: '',
              label: `STORY${block.slotNum}_CLIP`,
              streamer: `story_${block.slotNum}`,
              title: `Story ${block.slotNum} (unmatched)`,
              storyIndex: block.slotNum - 1
            });
            console.warn(`[news-clip-reorder] STORY${block.slotNum} — no pool match found (score ${(bestScore*100).toFixed(0)}%), using null`);
          }
        }

        if (newOrderedClipUrls.length === items.length) {
          orderedClipUrls = newOrderedClipUrls;
          console.log(`[news-clip-reorder] ✅ Reordered ${orderedClipUrls.length} clips to match Gemini's editorial order`);
        } else {
          console.warn(`[news-clip-reorder] ⚠️ Slot count mismatch (${newOrderedClipUrls.length} vs ${items.length}) — keeping scrape-order fallback`);
        }
      } catch (reorderErr) {
        console.warn(`[news-clip-reorder] Failed (${reorderErr.message}) — keeping scrape-order fallback`);
      }
    }

    // ── Auto-send to HeyGen if Gate 1 passes ──────────────────────────
    // GATE_TEST_MODE=true disables auto-send so Gate 1 can be verified before HeyGen credits burn
    const GATE_TEST_MODE = process.env.GATE_TEST_MODE === 'true';
    let heygenResult = null;
    if (scriptQA.outcome === 'pass' && !GATE_TEST_MODE) {
      // Pre-flight: verify parseScriptIntoScenes finds at least 1 avatar scene before burning HeyGen credits
      const _preflightScenes = parseScriptIntoScenes(scriptForHeygen);
      const _avatarScenes = _preflightScenes.filter(s => s.type === 'avatar');
      if (_avatarScenes.length === 0) {
        console.error(`[generate-full-script] ❌ Pre-HeyGen validation failed — 0 avatar scenes parseable. Script lacks === HEADER === markers. Will retry script generation.`);
        scriptQA = { outcome: 'fail', score: 0, fixDirective: { structuralIssues: ['Script has no parseable scene headers — regenerate with correct === HEADER === format'] } };
        // Don't send to HeyGen — fall through to retry logic below
      } else {
      console.log(`[generate-full-script] 🎬 Gate 1 PASSED — ${_avatarScenes.length} avatar scenes validated — Auto-sending to HeyGen...`);
      try {
        const format = type.includes('-short') ? 'portrait' : 'landscape';
        heygenResult = await sendScriptToHeyGen(scriptForHeygen, {
          contentType: type,
          format,
          jobId: `${type}_${dateStr}_${Date.now()}`
        });
        console.log(`[generate-full-script] ✅ HeyGen video generation initiated: ${JSON.stringify(heygenResult.videoJobs?.map(j => j.video_id) || [heygenResult.video_id])}`);
      } catch(e) {
        console.error('[generate-full-script] ⚠️  HeyGen auto-send failed:', e.message);
        heygenResult = { error: e.message };
      }
      } // end else (_avatarScenes.length > 0)
    } else if (GATE_TEST_MODE && scriptQA.outcome === 'pass') {
      console.log('[generate-full-script] ⏸  GATE_TEST_MODE=true — Gate 1 PASSED but HeyGen auto-send is disabled for testing');
    } else {
      console.log(`[generate-full-script] ⏸  Gate 1 ${scriptQA.outcome.toUpperCase()} — Skipping HeyGen auto-send (${retryAttempt} attempt${retryAttempt>1?'s':''} made)`);
    }

    // Finalize script generation metrics
    // Note: Gemini API calls now split into two categories:
    //  1. Clip analysis (pre-script) - counted below as geminiAnalysisCalls
    //  2. Script generation (Gate 1) - counted as geminiScriptGenCalls
    const totalGeminiAnalysisCalls = type === 'twitch' || type === 'twitch-short'
      ? (analyses.flat ? analyses.flat().length : analyses.length)
      : analyses.length;
    const geminiHitCount = analyses.flat ? analyses.flat().filter(a=>a && a.length > 50).length : analyses.filter(a=>a && a.length > 50).length;

    scriptGenTimer
      .addData('contentType', type)
      .addData('itemCount', items.length)
      // Gemini metrics (script generation + analysis)
      .addData('geminiAnalysisCalls', totalGeminiAnalysisCalls)
      .addData('geminiHits', geminiHitCount)
      .addData('geminiScriptGenCalls', retryAttempt) // 1 call per retry attempt
      // Claude metrics (QA only)
      .addData('claudeQAInputTokens', scriptQA.tokenUsage?.input || 0)
      .addData('claudeQAOutputTokens', scriptQA.tokenUsage?.output || 0)
      .addData('totalClaudeTokens', (scriptQA.tokenUsage?.input || 0) + (scriptQA.tokenUsage?.output || 0))
      // Script metrics
      .addData('scriptWordCount', wordCount)
      .addData('estimatedSeconds', estSecs)
      // Gate 1 outcomes
      .addData('gate1Score', scriptQA.score)
      .addData('gate1Outcome', scriptQA.outcome)
      .addData('gate1Passed', scriptQA.passed)
      .addData('gate1RetryAttempts', retryAttempt);

    addStageMetrics(jobId, scriptGenTimer.end());
    finalizeJobMetrics(jobId);

    // ── Parse caption text + style for short-form videos ─────────────────────
    // CAPTION: line from the script becomes a burned-in text overlay in assembly.
    // Each show has its own font, color, background, and position per creative bible.
    let captionText = null;
    let captionStyle = null;
    if (type.includes('-short') && scriptForHeygen) {
      const captionMatch = scriptForHeygen.match(/^CAPTION:\s*(.+)$/m);
      if (captionMatch) {
        // Strip surrounding quotes and emoji — FFmpeg drawtext handles plain text
        captionText = captionMatch[1].trim().replace(/^["']|["']$/g, '').trim();
        console.log(`[generate-full-script] 📝 Caption parsed: "${captionText}"`);
      }

      // Per-show caption styling per creative bible
      // Twitch Soup: Impact, neon green/purple bg, top-center, internet speak
      // Other Side of the Pillow: Arial Bold Italic, electric blue, center-right, slanted vibe
      // Because the Light Was On: Georgia Bold, yellow/black news bar, bottom, formal
      const baseType = type.replace('-short', ''); // 'twitch' | 'nba' | 'news'
      const CAPTION_STYLES = {
        twitch: {
          font:      '/System/Library/Fonts/Supplemental/Impact.ttf',
          fontsize:  72,
          fontcolor: 'white',
          boxcolor:  '0x6441A5@0.92',   // Twitch purple
          boxborderw: 20,
          position:  'top-center',      // x=center, y=60 from top
          style:     'uppercase',       // Force all caps
          emojis:    true
        },
        nba: {
          font:      '/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf',
          fontsize:  68,
          fontcolor: '0x1CE8FF',        // Electric blue
          boxcolor:  '0x000000@0.75',
          boxborderw: 18,
          position:  'center-right',    // x=W*0.52, y=center
          style:     'uppercase',
          emojis:    true
        },
        news: {
          font:      '/System/Library/Fonts/Supplemental/Georgia Bold.ttf',
          fontsize:  52,
          fontcolor: '0x111111',        // Black text
          boxcolor:  '0xFFD700@0.95',   // Yellow news bar
          boxborderw: 24,
          position:  'bottom-bar',      // x=0, y=H-120, w=full width
          style:     'titlecase',
          emojis:    false
        }
      };
      captionStyle = CAPTION_STYLES[baseType] || CAPTION_STYLES.news;
    }

    res.json({
      ok: true,
      script: scriptForHeygen,
      wordCount,
      estSecs,
      geminiHits: analyses.filter(a=>a).length,
      orderedClipUrls,
      // Design metadata — Gemini's visual instructions for Claude to execute
      design_metadata: {
        visualHook: null,       // Timestamp where visual interest peaks (e.g., "0:15")
        safeZone: null,         // Coordinates avoiding TikTok/Reels UI overlap
        overlayPositions: [],   // Array of {sceneId, x, y, w, h} for each overlay
        burnInImages: [],       // Array of {sceneId, design_brief, position}
        logoPlacement: null,    // Override default logo position if needed
        colorGrading: null      // Optional color grading suggestions
      },
      // Gate 1 QA results — dashboard shows these before user approves HeyGen send
      scriptQA: {
        score:         scriptQA.score,
        outcome:       scriptQA.outcome,
        outcomeLabel:  scriptQA.outcomeLabel,
        passed:        scriptQA.passed,
        report:        scriptQA.report,
        deductions:    scriptQA.deductions,
        retryAttempts: retryAttempt
      },
      // HeyGen auto-send result (only present if Gate 1 passed)
      heygen: heygenResult,
      // Short-form caption overlay — text + per-show style for FFmpeg burn
      captionText,
      captionStyle,
      // Include metrics in response for debugging
      metricsJobId: jobId
    });

    // ── Persist job card to disk so server restarts don't lose it ──
    // Saved whenever Gate 1 passes and HeyGen is submitted.
    // Dashboard calls GET /jobs on load to restore the job queue.
    if (scriptQA.outcome === 'pass' && heygenResult && !heygenResult.error) {
      // Parse script into scenes so saveJobCard can extract sourceClipSegments
      // and startup resume can rebuild segmentData after a server restart.
      const scriptScenes = parseScriptIntoScenes(script);
      const jobCard = {
        jobId,
        scriptJobId: jobId,   // same value, explicit field for restore path
        jobSpecId: req?.jobSpecId || null,  // semantic job spec ID — links script job to full job spec in DB
        stage: 'all_sent',    // pipeline stage — used by /jobs filter and startup resume
        contentType: type,
        date: dateStr,
        script: { raw: script, scenes: scriptScenes },
        wordCount,
        estSecs,
        orderedClipUrls,
        heygen: heygenResult,
        gate1Score: scriptQA.score,
        expectedClips: scriptQA.expectedClips ?? 0,  // Pipeline contract — carried through to Gate 3
        captionText: captionText || null,       // Short-form: text overlay burned in assembly
        captionStyle: captionStyle || null,     // Short-form: per-show FFmpeg drawtext style
        streamers: type === 'twitch' ? items.map(s => ({ displayName: s.displayName || s.name || s, twitchUsername: s.username || s.streamer || s })) : [],
        clipsPerStreamer: req.body.clipsPerStreamer || 2,
        newsItems: type === 'news' ? items.map(s => ({
          title:        s.title || '',
          source:       s.source || '',
          category:     s.category || 'WORLD NEWS',
          thumbnailUrl: s.thumbnailUrl || s.imageUrl || '',
          heroImageUrl: s.heroImageUrl || '',
          videoUrl:     s.videoUrl || s.clipUrl || '',
          link:         s.link || s.url || ''
        })) : [],
        nbaItems: (type === 'nba' || type === 'nba-short') ? items.map(s => ({
          title:   s.title || s.matchup || '',
          matchup: s.matchup || s.title || '',
          gameId:  s.gameId || null,
          category: 'NBA GAME'
        })) : [],
        designSpec: gwJobSpec?.designSpec || null
      };
      saveJobCard(jobId, jobCard);
      console.log(`[jobs] ✅ Job card persisted to disk: ${jobId}`);

      // ── Auto-poll HeyGen → auto-assemble → auto-publish ──────────────
      // Starts a background poller that checks HeyGen every 30s until all
      // segments are completed, then automatically triggers assembly.
      // Gate 3 → Drive upload → Gate 6 publish (private) all run inside /assemble.
      // Rob's only role: review private drafts on YouTube/TikTok/Instagram.
      startHeyGenPoller(jobId, jobCard).catch(e => {
        console.error(`[heygen-poller:${jobId}] Poller startup error: ${e.message}`);
      });
    }

  } catch(err) {
    console.error('[generate-full-script] Error:', err.message);
    const isGate0 = err.message && err.message.startsWith('Gate 0 FAIL');
    logError(isGate0 ? 'GATE0' : 'SCRIPT_GEN', err.message, {
      contentType: req.body.type,
      itemCount: (req.body.items || []).length,
      gate: isGate0 ? 'gate0' : null
    });
    res.status(500).json({ error: err.message, gate: isGate0 ? 'gate0' : null });
  }
}

/**
 * matchStoryToAjVideo — keyword-based story-to-video matcher
 * @param {string} storyTopic - Story title or link text
 * @param {Array} ajVideoPool - Array of {articleUrl, hlsUrl, orientation, pillarboxFilter, title}
 * @returns {Object|null} - Best matching entry if score >= 1, else null
 */
function matchStoryToAjVideo(storyTopic, ajVideoPool) {
  if (!ajVideoPool || ajVideoPool.length === 0) return null;

  // Extract keywords from story topic (lowercase, filter words >3 chars)
  const topicWords = (storyTopic || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/[\s-]+/)
    .filter(w => w.length > 3);

  if (topicWords.length === 0) return null;

  let bestMatch = null;
  let bestScore = 0;

  // Score each pool entry by counting keyword overlaps with article URL slug AND title
  for (const entry of ajVideoPool) {
    // Split slug on hyphens AND spaces for better tokenization
    const slug = (entry.articleUrl || '').toLowerCase();
    const slugWords = slug.replace(/[^a-z0-9\s-]/g, '').split(/[\s-]+/);
    
    // Also tokenize article title if available
    const title = (entry.title || '').toLowerCase();
    const titleWords = title.replace(/[^a-z0-9\s-]/g, '').split(/[\s-]+/);
    
    // Combine both for matching
    const allWords = [...slugWords, ...titleWords];
    
    let score = 0;
    for (const word of topicWords) {
      if (allWords.includes(word)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
    }
  }

  // Return best match regardless of score — Gate 4 handles relevance QA.
  // If no keyword overlap, return first available 9:16 clip from the pool.
  // We accept any AJ Brightcove clip rather than sending no clip at all.
  return bestMatch || ajVideoPool[0] || null;
}

module.exports = {
  sendScriptToHeyGen,
  geminiScriptGeneration,
  getVoiceGuide,
  scrapeArticleVideo,
  scrapeArticleOgImage,
  geminiAnalyzeClip,
  geminiAnalyzeThumbnail,
  prioritizeNewsStories,
  handleGenerateFullScript,
  matchStoryToAjVideo
};
