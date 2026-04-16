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

const TMP_DIR = path.join(__dirname, '..', 'tmp');

const GEMINI_MODEL  = 'gemini-2.5-flash';
const GEMINI_APIKEY = process.env.GEMINI_API_KEY;

// ── System prompts per content type ──────────────────────────────────────────
// Moved here from server.js during module split — script_gen.js is the only consumer
const FULL_SCRIPT_SYSTEM = {

nba: `You write scripts for ClipzWorld News (@clipznashite), a deadpan sports and news channel hosted by a single anchor.

VOICE — four sources blended:
• Norm MacDonald Weekend Update: flat delivery, state the fact, one observation, done. Never explain the joke.
• Daily Show Jon Stewart: calls out the ONE absurd implication of what just happened. Makes it MORE alarming, not less.
• Space Ghost: sudden non-sequitur pivot after a big moment is encouraged. Chaos is fine.
• NBA Inside Stuff (warm NBA energy): genuinely celebrating that basketball happened. No debates, no hot takes.

STRICT RULES:
- Never say "incredible", "amazing", "crazy", "wild", "absolutely", "definitely"
- Never explain or editorialize — state the thing, then stop
- Zero hot takes, zero "who is better" debates
- Warmth comes from specificity, not adjectives
- [beat] = natural pause in delivery, use freely
- [CLIP PLAYS HERE] = structural marker, keep it, it is not spoken
- Write every single line — no brackets, no placeholders, no [YOUR OBSERVATION HERE]

HEYGEN PRONUNCIATION BEST PRACTICES:
The avatar (HeyGen AI) reads your script aloud — EVERYTHING in the script is spoken, including parenthetical text.
1. **Difficult names**: Write the phonetic spelling DIRECTLY as the spoken word. Do NOT add parenthetical hints.
   - WRONG: "Giannis Antetokounmpo (YAH-nis)" — Bobby G will say both
   - RIGHT: Write "Yan-is An-tet-oh-KOON-po" OR just "Giannis" (HeyGen handles common NBA names fine)
   - Common names (LeBron, Curry, Durant, Luka) need no changes — HeyGen knows them
   - Only respell if a name is genuinely unusual AND HeyGen will mispronounce it
2. **Numbers**: Always spell out for clarity
   - Write "thirty-two points" NOT "32 points"
   - Write "one hundred and fifty" NOT "150"
   - Exception: Years like "2024" can stay numeric
3. **Abbreviations**: Spell out OR use phonetic if ambiguous
   - "NBA" → write "N-B-A" OR just "the NBA" (works fine)
   - "MVP" → write "M-V-P" OR "the MVP" (works fine)
4. **Foreign words/phrases**: Use simple phonetic respelling
   - "Nikola Jokić" → "Nikola Jokic (YO-kich)"
5. **Avoid homophones**: If a word could be mispronounced, clarify it
   - "Read" (past tense) → consider context or rephrase
6. **Punctuation = pacing**: Commas create short pauses, periods create full stops
   - Use commas liberally for natural speech rhythm
7. **Streamer names from streamers.json**: If phonetic field exists, use it on first mention
   - Check streamers.json for phonetic guidance (e.g., "Yonna" has phonetic: "Yawn-uh")

SCRIPT FORMAT — The user prompt will provide exact === SCENE HEADERS === to use. Output EXACTLY those headers, one scene per header. Do not combine scenes. Do not skip scenes.
Target: 120-150 words of SPOKEN TEXT per game segment (90 seconds of delivery).
The cold open and outro are short. Every game segment must be fully written and dense.
COLD OPEN — ALWAYS use this EXACT wording, no variation:
"Hello everyone! You are tuning into The Other Side of the Pillow brought to you by ClipzWorld News. Where we appreciate all of yesterday's games in the association. I am your host Bobby G. Let's get to it."
Do not improvise the cold open. This line is fixed for every compilation.
CRITICAL: Do NOT use "Witness the NBA" — the show is called "The Other Side of the Pillow". This is non-negotiable.

OUTRO — ALWAYS use this EXACT wording, no variation:
"Well everybody, that does it for another edition of The Other Side of the Pillow brought to you by ClipzWorld News. Don't forget to like, comment, share and subscribe. Go play a pick-up game today. Let us know how you did in the comments. Appreciate you!"
Do not improvise the outro. This line is fixed for every compilation.
CRITICAL: Do NOT use "Witness the NBA" in the outro — the show is called "The Other Side of the Pillow".

DELIVERY NOTE — OUTRO: "Appreciate you!" must be on its own line after [beat]. Warm. Genuine. Give it room.

NBA VOICEOVER STRUCTURE — IMPORTANT:
In NBA compilations the avatar speaks WHILE the clip plays (voiceover style), not before/after.
This means: the intro sets up the game, then [CLIP PLAYS HERE] begins, and the avatar's commentary
plays as audio OVER the video highlight. The avatar is not seen during clips — only heard.
Write all game commentary assuming it will play as voiceover during the highlight clip.`,

news: `You write scripts for ClipzWorld News (@clipznashite), a deadpan world news show. Same rhythm as Twitch: setup → clip → reaction.

VOICE — two sources blended:
• Norm MacDonald Weekend Update: flat delivery, zero warmth, the world is absurd and we are simply reporting it. "Hi, I'm Norm MacDonald and this is the news."
• Daily Show Jon Stewart: the observation must make the headline MORE alarming, not less. "I urge you not to think about it too hard." Never explain the observation.

STRICT RULES:
- Each story follows: setup (2-3 sentences) → [beat] → [CLIP PLAYS HERE] → [beat] → reaction (1 sentence, flat)
- Setup: headline + context, establishes what happened
- Reaction: ONE flat observation after the clip. Short. Deadpan. Make it MORE alarming, not less.
- Never say "shocking", "alarming", "incredible", "wild"
- Never explain the observation — state it, period, move on
- [beat] = pause, use freely between sentences
- [CLIP PLAYS HERE] = structural marker, keep it, it is not spoken
- Write every single line — no brackets, no placeholders whatsoever
- This is long-form. Every story needs FULL CONTENT.

HEYGEN PRONUNCIATION BEST PRACTICES:
The avatar (HeyGen AI) reads your script aloud — EVERYTHING in the script is spoken, including any text in parentheses.
1. **Difficult names/places**: Write them as they should be HEARD. Do NOT add parenthetical pronunciation guides — they will be spoken aloud.
   - WRONG: "Zelenskyy (zeh-LEN-skee)" → Bobby G says "Zelenskyy zeh-LEN-skee"
   - RIGHT: "Zelenskyy" — HeyGen handles this fine. Or write "zeh-LEN-skee" directly if needed.
   - Most common names (Iran, Qatar, Beijing, Ukraine) HeyGen pronounces correctly — leave them as-is.
   - Only rewrite if the word is genuinely obscure AND you are certain HeyGen will mispronounce it.
2. **Numbers**: Spell out for clarity → "twenty-three" NOT "23"
3. **Abbreviations**: Spell out OR hyphenate → "UN" becomes "U-N" OR "the UN"
4. **Punctuation = pacing**: Use commas for natural speech rhythm

SCRIPT FORMAT — The user prompt will provide exact === SCENE HEADERS === to use. Output EXACTLY those headers, one scene per header. Do not combine scenes. Do not skip scenes.
Target: 80-120 words of SPOKEN TEXT per story (setup + reaction, clip audio stripped).
The cold open and outro are short. Every story segment must be fully written and dense.
COLD OPEN — ALWAYS use this EXACT wording, no variation:
"Hello everyone! You are tuning into Because the Light Was On brought to you by ClipzWorld News. Where we bring you the most impactful news stories of the day, our way, the CWN way. I am your host Bobby G. Let's get to it."
Do not improvise the cold open. This line is fixed for every compilation.

OUTRO — ALWAYS use this EXACT wording, no variation:
"Well everybody, that does it for another edition of Because the Light Was On brought to you by ClipzWorld News. Don't forget to like, comment, share and subscribe. Let us know in the comments which of the stories covered concerns you the most. Appreciate you!"
Do not improvise the outro. This line is fixed for every compilation.

DELIVERY NOTE — OUTRO: "Appreciate you!" must be on its own line after [beat]. Warm. Genuine. Give it room.

NEWS STRUCTURE — IMPORTANT:
Each story follows the same rhythm as Twitch:
[Setup — 2-3 sentences. Headline + context. What happened and why it matters. Sets up the clip.]
[beat]
[CLIP PLAYS HERE]
[beat]
[ONE flat reaction sentence. Short. Deadpan. Makes the story MORE alarming, not less. Could be a non-sequitur.]
[beat]
Source: [Source name]. Link in description.`,

twitch: `You write scripts for ClipzWorld News (@clipznashite), a deadpan Twitch clip reaction show.

VOICE — two sources blended:
• Norm MacDonald: deadpan on the setup, flat delivery, do not explain what just happened in the clip.
• Space Ghost Coast to Coast: sudden non-sequitur after the clip is fine. Chaos is fine. One line after the clip, then move on.
• The clip is the joke. Do not summarize the clip. Do not react with hype. Just witness it and say one flat thing.

STRICT RULES:
- Intro the streamer briefly (2-3 sentences max), then [CLIP PLAYS HERE]
- After the clip: ONE sentence. Flat. Could be completely unrelated. Do not explain what just happened.
- Then: "Follow [streamer]. Link in description."
- Never say "that was incredible", "oh my god what a clip", or anything that explains the clip
- Write every single line — no brackets, no placeholders
- Use the visual analysis provided to inform what the clip is about, but do not narrate it

HEYGEN PRONUNCIATION BEST PRACTICES:
The avatar (HeyGen AI) reads your script aloud — EVERYTHING is spoken, including parenthetical text.
1. **Streamer names**: If streamers.json has a phonetic field, use the phonetic spelling DIRECTLY as the spoken name.
   - WRONG: "Yonna (YAWN-uh)" → Bobby G says "Yonna YAWN-uh"
   - RIGHT: Write "YAWN-uh" directly in the script where the name is first spoken. After that, use the display name normally.
   - Most streamer display names (xQc, Pokimane, Kai Cenat, Hasan) are fine as-is — HeyGen handles them.
2. **Numbers**: Spell out → "fifty thousand viewers" NOT "50k viewers"
3. **Game titles**: If unusual, add phonetic → "Valorant" is fine, "Lies of P" is fine
4. **Punctuation = pacing**: Commas create natural pauses in speech

⚠️ CRITICAL - SCENE STRUCTURE:
The user prompt will provide a NUMBERED LIST of === SCENE HEADERS ===.
YOU MUST output EXACTLY that many scenes with EXACTLY those headers.
- If the user lists 72 scene headers, your output MUST have exactly 72 === HEADER === sections
- ONE scene per header - do NOT combine multiple headers into one section
- Do NOT skip any headers from the list
- Do NOT create your own headers - use ONLY the headers provided in the user prompt
- Count the headers in the user prompt and ensure your output has that exact count
- EXAMPLE: For 10 streamers with 3 clips each, you need 1 INTRO + (10 streamers × 7 scenes) + 1 OUTRO = 72 scenes total
- Each streamer gets: 1 INTRO scene + 3 SETUP scenes + 3 REACTION scenes = 7 scenes per streamer
- You must write ALL scene headers provided - no shortcuts, no summarizing, no combining

INTRO SCENE — Use this EXACT text for the === INTRO === scene:
"Hello everyone! You are tuning into Twitch Soup brought to you by ClipzWorld News. Where we appreciate our favorite streamers on Twitch. I am your host Bobby G. Let's get to it."

OUTRO SCENE — Use this EXACT text for the === OUTRO === scene:
"Well everybody, that does it for another edition of Twitch Soup brought to you by ClipzWorld News. Don't forget to like, comment, share and subscribe. Let us know in the comments which of the clips you liked the most. Appreciate you!"

Target: 80-100 words of SPOKEN TEXT per streamer (45 seconds before and after clip).

DELIVERY NOTE — OUTRO: "Appreciate you!" must feel warm and genuine. Write it on its own line after a [beat] so HeyGen delivers it with weight. Never rush it.

DELIVERY NOTE — BEFORE CLIPS: INTRO segments must end with a complete sentence followed by [beat]. Never end an INTRO mid-thought. The avatar needs a clean stop before the clip rolls or it will produce a filler sound.

DELIVERY NOTE — REACTIONS + FOLLOW LINE: Always put [beat] between the reaction sentence and "Follow [name]." These are two separate beats — the reaction lands, then the follow ask. Example:
"She did not blink once.
[beat]
Follow Cinna. Link in description."
Never write them on the same line or without a [beat] between them.`,

// ── SHORTS / REELS (portrait 9:16, single subject, ~45 seconds total) ───────
'nba-short': `You write scripts for ClipzWorld News (@clipznashite) — The Daily Update.

VOICE: Same as NBA compilation (Norm MacDonald deadpan + NBA Inside Stuff warmth) but compressed.
One player. One moment. One observation. Done.

COLD OPEN (spoken): "The Daily Update. ClipzWorld News."
OUTRO (spoken): "Subscribe for daily NBA highlights. Appreciate you."

STRICT RULES:
- 40-60 words TOTAL spoken content — every word must earn its place
- Same flat delivery as compilations, just faster pacing
- State player name → what they did → one stat → [CLIP PLAYS HERE] → one flat observation
- [beat] = pause. Use sparingly in shorts.
- No debates, no hot takes, no "arguably the best"

SCRIPT FORMAT:
=== NBA SHORT ===
The Daily Update. ClipzWorld News.
[beat]
[Player name]. [What they did. Score. Their stat. One sentence flat.]
[beat]
[CLIP PLAYS HERE]
[beat]
[One flat observation. End the sentence.]
Subscribe for daily NBA highlights. Appreciate you.`,

'news-short': `You write scripts for ClipzWorld News (@clipznashite) — The Daily Update.

VOICE: Same as News compilation (Norm MacDonald flat + Daily Show observation) but compressed.
One headline. One alarming implication. Done.

COLD OPEN (spoken): "The Daily Update. ClipzWorld News."
OUTRO (spoken): "Subscribe for daily news. Appreciate you."

STRICT RULES:
- 40-60 words TOTAL spoken content
- Same flat delivery as compilations, just one story, no filler
- Headline → one context sentence → one observation that makes it MORE alarming
- Never explain the observation. State it. End the sentence.
- [beat] = pause. Use sparingly.

SCRIPT FORMAT:
=== NEWS SHORT ===
The Daily Update. ClipzWorld News.
[beat]
[Headline. Exactly as it happened. Flat.]
[beat]
[ONE context sentence.]
[beat]
[ONE observation. Most absurd implication. Do not explain it.]
Subscribe for daily news. Appreciate you.

Target: 50-70 words of spoken content total. Dense with one story, no filler.`,

'twitch-short': `You write scripts for ClipzWorld News (@clipznashite) — The Daily Update.

VOICE: Same as Twitch compilation (Norm MacDonald deadpan + Space Ghost non-sequitur) but compressed.
One clip. One streamer. One reaction. Done.

COLD OPEN (spoken): "The Daily Update. ClipzWorld News."
OUTRO (spoken): "Subscribe. Appreciate you."

STRICT RULES:
- 40-60 words TOTAL spoken content
- Same flat delivery as Twitch compilations — the clip is still the joke
- Intro the streamer in ONE sentence max. Do not hype them.
- After the clip: ONE sentence. Flat. Non-sequitur is fine.
- [beat] = pause. Use sparingly.
- Do not explain the clip. Do not summarize what happened.

SCRIPT FORMAT:
=== TWITCH SHORT ===
The Daily Update. ClipzWorld News.
[beat]
[One sentence intro to the streamer. What they do. Flat.]
[beat]
[CLIP PLAYS HERE]
[beat]
[One reaction sentence. Flat. Could be completely unrelated.]
Follow [streamer]. Link in description. Subscribe.`

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
  const HEYGEN_AVATAR_ID = process.env.HEYGEN_AVATAR_ID || '1a5d4e9130d2467fa01d9e1580aff829';
  const HEYGEN_AVATAR_SHORT_ID = process.env.HEYGEN_AVATAR_SHORT_ID || 'ed57439c9c3d4a398f3b247b75714b13';
  const HEYGEN_VOICE_ID = process.env.HEYGEN_VOICE_ID || '2e598f1a6022448cb6710e5d44665325';
  const HEYGEN_SPEAK_SPEED = parseFloat(process.env.HEYGEN_SPEAK_SPEED || '0.85');

  if (!HEYGEN_API_KEY) {
    throw new Error('HEYGEN_API_KEY not set in environment');
  }

  // Select avatar based on format
  const avatarId = format === 'portrait' ? HEYGEN_AVATAR_SHORT_ID : HEYGEN_AVATAR_ID;

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

      let response;
      if (templateId) {
        try {
          response = await axios.post(
            'https://api.heygen.com/v2/video/generate',
            templateBody,
            {
              headers: { 'X-Api-Key': HEYGEN_API_KEY, 'Content-Type': 'application/json' },
              timeout: 30000
            }
          );
          console.log(`[heygen]   using template ${templateId.slice(0,8)}...`);
        } catch (tmplErr) {
          console.warn(`[heygen]   template call failed (${tmplErr.message}), falling back to full-gen`);
          response = await axios.post(
            'https://api.heygen.com/v2/video/generate',
            fullGenBody,
            {
              headers: { 'X-Api-Key': HEYGEN_API_KEY, 'Content-Type': 'application/json' },
              timeout: 30000
            }
          );
        }
      } else {
        response = await axios.post(
          'https://api.heygen.com/v2/video/generate',
          fullGenBody,
          {
            headers: { 'X-Api-Key': HEYGEN_API_KEY, 'Content-Type': 'application/json' },
            timeout: 30000
          }
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
    // Normalize content type (remove -short suffix for style lookup)
    const styleType = contentType.replace('-short', '');
    styleGuide = styleGuides[styleType] || '';
    if (styleGuide) {
      console.log(`[geminiScriptGeneration] Loaded ${styleType} style guide (${styleGuide.length} chars)`);
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
    maxOutputTokens = 2000;
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

    const script = (candidate?.content?.parts || [])
      .map(p => p.text||'')
      .join('')
      .trim();

    if (!script || script.length < 100) {
      throw new Error('Gemini returned empty or too-short script');
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
    const tmpPath = path.join(TMP_DIR, `gemini_vid_${Date.now()}_${Math.random().toString(36).slice(2,7)}.mp4`);
    let geminiFile = null;
    try {
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
        // News/NBA: may be HLS manifest (.m3u8) — use FFmpeg to transcode to MP4
        const isHls = /\.m3u8(\?|$)/i.test(mp4Url) || /manifest\.prod\.boltdns\.net/i.test(mp4Url);
        if (isHls) {
          console.log(`[gemini-video] HLS→MP4 via FFmpeg (max 90s): ${mp4Url.slice(0, 80)}...`);
          const { ffmpegPath } = require('./ffmpeg_utils');
          await new Promise((res, rej) => {
            const { execFile } = require('child_process');
            const args = [
              '-i', mp4Url,
              '-t', '90',           // cap at 90s — enough for Gemini, under 34MB
              '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
              '-c:a', 'aac', '-ar', '44100', '-ac', '2',
              '-movflags', '+faststart',
              '-y', tmpPath
            ];
            execFile(ffmpegPath(), args, { timeout: 120000 }, (err) => {
              if (err) rej(new Error(`FFmpeg HLS transcode failed: ${err.message}`));
              else res();
            });
          });
          const size = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
          if (size < 1000) throw new Error(`FFmpeg HLS output too small: ${size} bytes`);
          console.log(`[gemini-video] HLS→MP4 ✓ ${(size/1024/1024).toFixed(1)}MB — uploading to Gemini...`);
        } else {
          // Direct MP4 (e.g. ESPN CDN) — use FFmpeg to download+transcode
          // Axios fails on ESPN due to CDN auth/streaming restrictions; FFmpeg handles natively
          console.log(`[gemini-video] FFmpeg download (max 90s): ${mp4Url.slice(0, 80)}...`);
          const { ffmpegPath } = require('./ffmpeg_utils');
          await new Promise((res, rej) => {
            const { execFile } = require('child_process');
            const args = [
              '-i', mp4Url,
              '-t', '90',
              '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
              '-c:a', 'aac', '-ar', '44100', '-ac', '2',
              '-movflags', '+faststart',
              '-y', tmpPath
            ];
            execFile(ffmpegPath(), args, { timeout: 120000 }, (err) => {
              if (err) rej(new Error(`FFmpeg MP4 download failed: ${err.message}`));
              else res();
            });
          });
          const size = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
          if (size < 1000) throw new Error(`FFmpeg MP4 output too small: ${size} bytes`);
          console.log(`[gemini-video] FFmpeg download ✓ ${(size/1024/1024).toFixed(1)}MB — uploading to Gemini...`);
        }
      }

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
      console.warn(`[gemini-video] Video analysis failed, falling back to thumbnail: ${e.message}`);
    } finally {
      if (fs.existsSync(tmpPath)) { try { fs.unlinkSync(tmpPath); } catch(e) {} }
      if (geminiFile) await deleteGeminiFile(geminiFile.name);
    }
  }

  // ── Fallback: thumbnail image analysis ───────────────────────────
  if (!thumbnailUrl) return '';
  try {
    console.log(`[gemini-thumb] Analyzing thumbnail for ${contentType}...`);
    const imgResp = await axios.get(thumbnailUrl, { responseType: 'arraybuffer', timeout: 8000 });
    const b64     = Buffer.from(imgResp.data).toString('base64');
    const mime    = (imgResp.headers['content-type'] || 'image/jpeg').split(';')[0];
    const gResp   = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
      { contents: [{ parts: [{ text: thumbPrompts[contentType]||thumbPrompts.twitch }, { inline_data: { mime_type: mime, data: b64 } }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0.2 } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return (gResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim();
  } catch(e) {
    console.warn(`[gemini-thumb] Fallback thumbnail analysis failed: ${e.message}`);
    return '';
  }
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
    // ── Step 1: Gemini analysis — full video where possible ──────────
    console.log('[generate-full-script] Running Gemini analysis...');

    // For Twitch: analyze ALL clips across all streamers with full video
    let analyses = [];
    let orderedClipUrls = []; // populated by twitch block — returned alongside script
    let clipReportDataForQA = null; // populated inside twitch block, passed to claudeScriptQA
    if (type === 'twitch' || type === 'twitch-short') {
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
      console.log(`[generate-full-script] Gemini analyzed ${geminiHits}/${allClips.length} clips (${allClips.length - geminiHits} fell back to thumbnail)`);

      // Fix #6: Filter out streamers without enough REAL video clips (sig= URL).
      // Thumbnail fallback analyses are also >50 chars, so the old length check was broken —
      // it let streamers with 0 real clips through, causing Gemini to hallucinate content.
      // Now we require ≥N real video-analyzed clips (isVideoAnalyzed flag set in Fix #6A).
      // targetClipsPerStreamer is derived dynamically from actual data, not hardcoded.
      const targetClipsPerStreamer = (items[0]?.clips?.length > 0 ? items[0].clips.length : null) ?? req.body.clipsPerStreamer ?? 2;
      const itemsBefore = items.length;
      const filteredPairs = items
        .map((item, i) => ({ item, analysis: analyses[i] }))
        .filter(({ item }) => (videoAnalyzedByStreamer[item.streamer] || 0) >= targetClipsPerStreamer);
      if (filteredPairs.length < itemsBefore) {
        const dropped = items
          .filter(item => !filteredPairs.find(p => p.item.streamer === item.streamer))
          .map(item => item.streamer);
        console.warn(`[generate-full-script] ⚠️  Dropping ${itemsBefore - filteredPairs.length} streamers with no real clip analyses: ${dropped.join(', ')}`);
        items.splice(0, items.length, ...filteredPairs.map(p => p.item));
        analyses = filteredPairs.map(p => p.analysis);
      }
      console.log(`[generate-full-script] Streamers with real clips: ${items.length}/${itemsBefore} — ${items.map(i => i.streamer).join(', ')}`);


    } else if (type === 'nba' || type === 'nba-short') {
      // NBA: use stored ESPN highlight clip URLs for full video analysis
      // clipUrl comes from ESPN summary API links.source.HD.href or similar
      // Gate 0: Hard fail if ANY game is missing a clipUrl
      const missingClipUrl = items.filter(item => !item.clipUrl);
      if (missingClipUrl.length > 0) {
        const missingGames = missingClipUrl.map(i => i.gameId || i.headline || '?').join(', ');
        const errMsg = `Gate 0 FAIL: ${missingClipUrl.length}/${items.length} NBA games have no highlight clip URL. Missing: ${missingGames}. Run SELECT GAMES → wait for scraper to complete → retry.`;
        console.error(`[generate-full-script] ${errMsg}`);
        throw new Error(errMsg);
      }
      console.log(`[generate-full-script] Analyzing ${items.length} NBA highlight clips (video + audio)...`);
      analyses = await Promise.all(
        items.map(item => geminiAnalyzeClip(item.clipUrl||'', item.thumbnailUrl||'', 'nba', item))
      );
      const nbaHits = analyses.filter(a => a && a.length > 50).length;
      console.log(`[generate-full-script] Got ${nbaHits}/${items.length} NBA analyses (${nbaHits} video, ${items.length - nbaHits} thumbnail/fallback)`);

    } else {
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
Gemini video analysis: ${analyses[0] || 'No analysis — use stats only'}

Write the FULL SCRIPT using exactly:
- === NBA SHORT ===

Fully written, no brackets, no placeholders. Single [CLIP PLAYS HERE] after setup.
Target: 50-70 words spoken total.`;
      } else {
        // Generate scene headers for NBA (3 scenes per game: intro + narration + reaction)
        // Wave 1-NBA: renamed SETUP→NARRATION, dropped CLIP_REACTION (PIP fiction — not implemented in assembly)
        const sceneHeaders = ['=== INTRO ==='];
        items.forEach((g, i) => {
          const gameLabel = `GAME${i+1}`;
          // Fix: replace spaces with underscores to prevent Gemini header parsing failures
          // e.g. "Trail Blazers" → "TRAIL_BLAZERS" not "TRAIL BLAZERS" (URGENT_TEST_FAILURE_INVESTIGATION.md Fix #2)
          const awayClean = (g.away||'AWAY').toUpperCase().replace(/\s+/g, '_');
          const homeClean = (g.home||'HOME').toUpperCase().replace(/\s+/g, '_');
          const teams = `${awayClean}_${homeClean}`;
          sceneHeaders.push(`=== ${gameLabel}_${teams}_INTRO ===`);
          sceneHeaders.push(`=== ${gameLabel}_${teams}_NARRATION ===`);
          sceneHeaders.push(`=== ${gameLabel}_${teams}_REACTION ===`);
        });
        sceneHeaders.push('=== OUTRO ===');
        const expectedScenes = sceneHeaders.length;

        userPrompt = `Write the COMPLETE Other Side of the Pillow NBA Compilation script for ${dateStr}.

${items.length} game${items.length > 1 ? 's' : ''} total. ${items.length} [CLIP PLAYS HERE] markers required (one per game).

GAME DATA:
${items.map((g, i) => `
GAME ${i+1}: ${g.away || 'Away'} @ ${g.home || 'Home'}
Score: ${g.awayScore || '?'}-${g.homeScore || '?'} FINAL
${g.leader ? 'Top performer: ' + g.leader + (g.leaderStat ? ' — ' + g.leaderStat : '') : ''}
${g.injuries && g.injuries.length ? 'Out: ' + g.injuries.join(', ') : ''}
${g.awayRec || g.homeRec ? 'Records: ' + g.away + ' ' + (g.awayRec||'') + ' | ' + g.home + ' ' + (g.homeRec||'') : ''}
ESPN highlight clip duration: ${g.clipDuration ? Math.round(g.clipDuration) + ' seconds' : 'unknown'}
NARRATION word count target for this game: ${g.clipDuration ? Math.round(g.clipDuration * 2.5) + '-' + Math.round(g.clipDuration * 3) + ' words' : '70-90 words (default)'}
Gemini video analysis: ${analyses[i] || 'No analysis — use box score data only'}
`).join('')}

⏱ CLIP DURATION GUIDANCE:
Each game has an "ESPN highlight clip duration" in seconds. The NARRATION scene for that game
is the audio track that plays OVER the highlight video (via the voiceover branch at assembly time).
See the "NARRATION word count target for this game" line in each GAME DATA block above — use the
upper end of that range to guarantee narration covers the full clip. Write in present tense.
If clip duration is "unknown", target ~70-90 words of NARRATION as a reasonable default.
If the clip is longer than 60 seconds, split the action into 2-3 sentences of present-tense
play-by-play instead of one long run-on sentence.

🎬 CRITICAL - SCENE STRUCTURE (${expectedScenes} SCENES REQUIRED):
Write the FULL SCRIPT using these === SCENE HEADERS === exactly (one scene per header):

${sceneHeaders.join('\n')}

⚠️ SCENE LENGTH RULES:
- INTRO scene: 2-3 sentences (episode intro)
- [GAME]_[TEAMS]_INTRO scenes: 2-3 sentences (introduce the matchup, teams, stakes). Bobby G is on screen during this scene with the game's TV card in the top-right corner.
- [GAME]_[TEAMS]_NARRATION scenes: play-by-play calling the clip from the broadcast booth, sized to cover the full clip duration. See GAME DATA above for per-game target word counts — use the upper end of the range to guarantee narration covers the full clip. Write in present tense. If the clip is very short (<15 seconds), target ~35-40 words. If very long (>60 seconds), split into 2-3 short sentences instead of one long run-on.
- [GAME]_[TEAMS]_REACTION scenes: EXACTLY 1 sentence. Bobby G is back on screen after the clip ends. Deadpan take on the play. Do NOT recap what happened — the narration already covered it. Just the take.
- OUTRO scene: 1-2 sentences (sign-off)

📝 CONTENT STRUCTURE PER SCENE:

=== INTRO ===
[2-3 sentences. Episode intro. Set the tone. Bobby G on screen.]

=== GAME#_[TEAMS]_INTRO ===
[2-3 sentences. Introduce the matchup — teams, stakes, storyline. Do NOT describe specific plays; save that for NARRATION. Bobby G on screen with the game's TV card visible in the top-right corner.]

=== GAME#_[TEAMS]_NARRATION ===
[4-8 sentences of play-by-play narration covering the ESPN highlight clip. Bobby G's audio plays OVER the clip video — avatar is NOT on screen during this scene, only the narration. Write in present tense as if you are calling the game from the booth. Describe the action visible in the clip (from Gemini's video analysis) with specific player names, numbers, outcomes. Length must cover the full clip duration — see NARRATION word count target in GAME DATA above.]
[beat]
[CLIP PLAYS HERE]
[beat]

=== GAME#_[TEAMS]_REACTION ===
[EXACTLY 1 sentence. Bobby G back on screen after the clip ends. Deadpan take on the play — what it means, what it tells us about the team, the season, the moment. Do NOT recap the play — NARRATION already called it. Just the take.]

=== OUTRO ===
[1-2 sentences. Sign-off.]

✅ VALIDATION CHECKLIST:
- Total scenes: MUST BE EXACTLY ${expectedScenes}
- Total [CLIP PLAYS HERE] markers: MUST BE EXACTLY ${items.length}
- Each NARRATION scene: word count matches "NARRATION word count target for this game" in the GAME DATA section. Tolerance: ±15% around the upper bound. Contains [beat] + [CLIP PLAYS HERE] + [beat] after the narration text.
- Each REACTION scene: EXACTLY 1 sentence (deadpan take, no recap)
- [beat] = 3-second pause — use before and after every [CLIP PLAYS HERE]
- Never recap the play in REACTION — NARRATION already called the action.
- Never mention "watch this" or "check this out" in INTRO/NARRATION — just call the game like a broadcaster.
- Play-by-play must be present-tense, specific (player names, jersey numbers, shot types), and cover the full clip duration without dead air.

Use Gemini video analysis AND box score data for specific, accurate content.
Total script target: INTRO (~25 words) + per-game (INTRO ~25 + NARRATION [per GAME DATA] + REACTION ~15) + OUTRO (~25 words).`;
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
Gemini analysis: ${analyses[0] || 'Not available — use article text only'}

Write the FULL SCRIPT using exactly:
- === NEWS SHORT ===

Fully written, no brackets, no placeholders.
Target: 50-70 words spoken total. One headline, one observation, done.`;
      } else {
        // Red 4 hotfix 6: generate scene headers for News (5 scenes per story:
        // intro + setup + CLIP + summary + reaction). Clip is now a standalone
        // source_clip scene with empty spokenText, matching the architecturally
        // correct proactive directive pattern. Previous 4-scene-per-story pattern
        // with [CLIP PLAYS HERE] text markers inside SETUP scene spokenText was
        // the source of a 5-hotfix ladder tonight because Gemini couldn't decide
        // between text markers and standalone clip scenes from the hybrid prompt.
        const sceneHeaders = ['=== INTRO ==='];
        items.forEach((s, i) => {
          const storyLabel = `STORY${i+1}`;
          sceneHeaders.push(`=== ${storyLabel}_INTRO ===`);
          sceneHeaders.push(`=== ${storyLabel}_SETUP ===`);
          sceneHeaders.push(`=== ${storyLabel}_CLIP ===`);
          sceneHeaders.push(`=== ${storyLabel}_SUMMARY ===`);
          sceneHeaders.push(`=== ${storyLabel}_REACTION ===`);
        });
        sceneHeaders.push('=== OUTRO ===');
        const expectedScenes = sceneHeaders.length;

        userPrompt = `Write the COMPLETE Because the Light Was On script for ${dateStr}.

${items.length} stor${items.length > 1 ? 'ies' : 'y'} total. Each story MUST have its own standalone CLIP scene (type="source_clip") in the JSON output — ${items.length} source_clip scenes required total.

STORY DATA:
${items.map((s, i) => `
STORY ${i+1}: ${s.title || 'Untitled'}
Source: ${s.source || 'Al Jazeera'}
${s.pubDate ? 'Published: ' + s.pubDate : ''}
Article text: ${s.desc || 'No description available'}
${s.link ? 'Link: ' + s.link : ''}
Gemini visual/video analysis: ${analyses[i] || 'Not available — use article text only'}
`).join('')}

🎬 CRITICAL - SCENE STRUCTURE (${expectedScenes} SCENES REQUIRED):
Write the FULL SCRIPT using these === SCENE HEADERS === exactly (one scene per header):

${sceneHeaders.join('\n')}

⚠️ SCENE LENGTH RULES - PREVENTS HEYGEN TTS FROM RUSHING:
- Each avatar scene = 1-3 sentences MAXIMUM
- Scenes longer than 3 sentences cause HeyGen TTS to rush/skip words/poor enunciation
- INTRO scene: 2-3 sentences (episode intro)
- STORY#_INTRO scenes: 2-3 sentences (introduce the story/headline)
- STORY#_SETUP scenes: EXACTLY 1 sentence — a NEW fact or hook (not a summary, not a restatement of INTRO). Give the viewer a reason to watch the clip that follows.
- STORY#_CLIP scenes: source_clip type with EMPTY spokenText (""). These are non-spoken scenes — the Al Jazeera source video plays here. Assembly fills them with real clip content.
- STORY#_SUMMARY scenes: 1-2 sentences — factual recap of what just played in the clip. No reactions, no quips, no opinions. Sets up the REACTION scene that follows.
- STORY#_REACTION scenes: EXACTLY 1 sentence (short, flat, deadpan take on the story. Makes it MORE alarming, not less.)
- OUTRO scene: 1-2 sentences (sign-off)

📝 CONTENT STRUCTURE PER SCENE:

=== INTRO ===
type: avatar
spokenText: [2-3 sentences. Episode intro. Set the tone.]

=== STORY#_INTRO ===
type: avatar
spokenText: [2-3 sentences. Introduce the headline. Build context. NO source attribution. NO "According to..." phrases.]

=== STORY#_SETUP ===
type: avatar
spokenText: [EXACTLY 1 sentence. A NEW fact or hook that gives the viewer a reason to watch the clip. Do NOT restate the INTRO. Do NOT summarize the story. Introduce information the INTRO did not mention — a specific angle, an unexpected detail, a stake.]

=== STORY#_CLIP ===
type: source_clip
spokenText: "" (EMPTY STRING — this scene has no spoken narration, the Al Jazeera video plays here)

=== STORY#_SUMMARY ===
type: avatar
spokenText: [1-2 sentences. Factual recap of what just played in the clip. Describe what the viewer saw in neutral, descriptive language. No opinions, no reactions, no quips. This is the bridge between the clip and Bobby G's take.]

=== STORY#_REACTION ===
type: avatar
spokenText: [EXACTLY 1 sentence. Short. Flat. Deadpan. Bobby G's take on the story. Makes it MORE alarming, not less. Never explain. Never recap — that's the SUMMARY's job.]

=== OUTRO ===
type: avatar
spokenText: [1-2 sentences. Sign-off. MUST contain the phrase "Appreciate you" as the final send-off.]

✅ VALIDATION CHECKLIST:
- Total scenes: MUST BE EXACTLY ${expectedScenes} (1 INTRO + ${items.length} × 5 per story + 1 OUTRO)
- Total source_clip scenes: MUST BE EXACTLY ${items.length} (one STORY#_CLIP per story)
- STORY#_CLIP scenes have type="source_clip" and empty spokenText ""
- All other scenes have type="avatar" and non-empty spokenText
- Each SETUP scene: EXACTLY 1 sentence (new fact or hook, not a restatement of INTRO)
- Each SUMMARY scene: 1-2 sentences (factual recap of clip, no opinions or reactions)
- Each REACTION scene: EXACTLY 1 sentence (deadpan take, no recap)
- OUTRO must contain "Appreciate you" in the spokenText
- DO NOT write [beat] markers in spokenText — the TTS engine handles pacing automatically
- DO NOT write [CLIP PLAYS HERE] markers anywhere — clips are standalone source_clip scenes now, not text markers
- Never explain the take in reactions. Never recap what just happened — that's SUMMARY's job.

SOURCE ATTRIBUTION RULE (STRICT — ABSOLUTE PROHIBITION):
- NEVER speak the source name OR any organization name that published the story.
- Bobby G NEVER uses attribution phrases of ANY kind. This includes but is not limited to:
    "According to Al Jazeera"
    "According to a direct statement from..."
    "According to [any organization/government/body]"
    "Sources report"
    "Sources at..."
    "Reports from..."
    "A statement from..."
    "Officials at [X] say..."
    "[X] reports"
    "[X] says"
    "[X]'s coverage shows..."
- Source names are tracked in story metadata and published in the video description automatically. Bobby G's spoken text NEVER references the publication, reporting body, or issuing organization.
- If a story is uniquely identifiable only by its source, rephrase to describe the event without the attribution.
  WRONG: "According to Al Jazeera, Iran's army seized US plans..."
  RIGHT: "Iran's army reportedly seized US plans..."
  WRONG: "According to a direct statement from the E-U, peace is not possible..."
  RIGHT: "The E-U says peace is not possible..." — NO wait, that still attributes. Use instead: "Peace is not possible while Lebanon burns, officials warn..." or simply "Peace is not possible while Lebanon burns." Drop the attribution entirely.
  WRONG: "Officials at the White House say Trump will not apologize..."
  RIGHT: "Trump will not apologize..." — state the fact directly, no attribution wrapper.
- When in doubt: remove the attribution phrase and state the fact as Bobby G's own observation.
- Gate 1 Claude QA will scan every spokenText field for attribution patterns. Any match = hard -25 deduction = script regeneration. Do not waste the pipeline's retry budget.
  WRONG: "Al Jazeera reports that Israeli forces fired tear gas..."
  RIGHT: "Israeli forces fired tear gas into a Palestinian schoolchildren's crowd."
- This rule applies to ALL 10 stories, every scene type, no exceptions.

Target: 100-140 words spoken per story (setup + summary + reaction, clip audio is stripped).

── Red 4: JSON CHROME DIRECTIVE FORMAT ──────────────────────────────────────
Output your ENTIRE script as a single JSON object (no markdown fences, no plain text outside the JSON).

Top-level structure:
{
  "scriptVersion": 1,
  "contentType": "news",
  "clientId": "cwn",
  "brandConfig": {
    "primaryHex": "#22304b",
    "accentHex": "#c7af4f",
    "showName": "ClipzWorld News",
    "episodeNumber": 123
  },
  "estimatedTotalDurationSec": 300,
  "storyList": [
    { "index": 0, "title": "Story 1 headline", "source": "Al Jazeera" },
    { "index": 1, "title": "Story 2 headline", "source": "BBC News" }
  ],
  "scenes": [ ... ]
}

Each scene object:
{
  "id": "scene_label_matching_assembly",
  "type": "avatar" | "source_clip",
  "storyIndex": 0, // Required Zod field — which story this scene belongs to (0-based)
  "spokenText": "The exact words the anchor speaks (empty string for source_clip scenes)",
  "estimatedDurationSec": 15, // Required for avatar scenes
  "chrome": {
    "flag": { "visible": true, "text": "HEADLINE TEXT", "source": "Al Jazeera" },
    "sidebar": { "visible": true, "activeIndex": 0, "cap": 5 },
    "ticker": { "visible": true },
    "logo": { "visible": true }
  }
}

// source_clip scene (NO spokenText field — Zod will reject it):
{
  "id": "scene_04",
  "type": "source_clip",
  "storyIndex": 0,
  "clipUrl": "https://example.com/clip.mp4",
  "clipMaxDurationSec": 25,
  "chrome": {
    "flag": { "visible": false },
    "sidebar": { "visible": false, "activeIndex": 0, "cap": 5 },
    "ticker": { "visible": true },
    "logo": { "visible": true }
  }
}

Layout rules:
- Scene 1 (cold open / intro): flag.visible=false, sidebar.visible=false, ticker.visible=true, logo.visible=true
- First avatar scene of each story: flag.visible=true, sidebar.visible=true, ticker.visible=true, logo.visible=true
- Subsequent avatar scenes of same story: flag.visible=true, sidebar.visible=true, ticker.visible=true, logo.visible=true
- source_clip scenes: flag.visible=false, sidebar.visible=false, ticker.visible=true, logo.visible=true
- Final outro scene: flag.visible=false, sidebar.visible=false, ticker.visible=true, logo.visible=true
- activeIndex: 0-based index of the current story (0 for cold open/outro)
- The "id" field must exactly match the scene label used in assembly (e.g. "scene_01", "scene_02", etc.)

IMPORTANT: The JSON must be valid and parseable. Do not include any text before or after the JSON object.`;
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
Gemini video analysis: ${anal0 || 'No analysis available'}

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
  Analysis (write CLIP${ci+1}_SETUP and CLIP${ci+1}_REACTION based on THIS analysis ONLY): ${clipAnalyses[ci] || 'No analysis'}`).join('');
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
[1-2 sentences. Sign-off.]

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

    // ── Step 3: Gemini generates the complete script (with Gate 1 retry loop) ─────────────────
    // NEW ARCHITECTURE (as of April 2026): Gemini writes, Claude QAs
    // Reason: Claude kept generating 11 scenes instead of 72 due to learned "one section per streamer" pattern
    const MAX_RETRIES = 2;
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
      expectedScenes = 1 + (items.length * 3) + 1; // 1 INTRO + (games × 3 scenes: _INTRO, _NARRATION, _REACTION) + 1 OUTRO
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
        streamers: type === 'twitch' ? items.map(s => ({ displayName: s.displayName || s.name || s, twitchUsername: s.username || s }))
                 : type === 'nba'    ? items.map(g => ({ displayName: `${g.away} vs ${g.home}`, twitchUsername: g.gameId || '' }))
                 : type === 'news'   ? items.map(s => ({ displayName: s.title || s.link || '', twitchUsername: '' }))
                 : [],
        clipsPerStreamer: gate1ClipsPerStreamer,
        jobId: `${type}_${dateStr}_${Date.now()}`,
        expectedScenes: expectedScenes,
        clipReportData: clipReportDataForQA
      });

      console.log(`[generate-full-script] Gate 1 Script QA: ${scriptQA.outcomeLabel} (${scriptQA.score}/100)`);
      if (scriptQA.deductions?.length) {
        scriptQA.deductions.forEach(d => console.log(`[generate-full-script]   -${d.points} ${d.reason}`));
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
        // Check if the ONLY issue is clip match (no structural failures)
const hasStructuralFail = scriptQA.deductions && scriptQA.deductions.some(d => d.type !== 'clip_match');
const isClipMatchOnly = !hasStructuralFail &&
  scriptQA.claudeReport &&
  scriptQA.claudeReport.includes('CLIP MATCH') &&
          !scriptQA.claudeReport.includes('SCENE COUNT') &&
          !scriptQA.claudeReport.includes('CLIP COUNT') &&
          !scriptQA.claudeReport.includes('Appreciate you');

        if (isClipMatchOnly) {
          console.log('[generate-full-script] [FIX] Gate 1 FAIL (clip match only) -- Trying Claude surgical fix...');
          const fixResult = await claudeScriptFix(script, analyses, {
            contentType: type,
            streamers: type === 'twitch' ? items.map(s => ({ displayName: s.displayName || s.name || s, twitchUsername: s.username || s }))
                 : type === 'nba'    ? items.map(g => ({ displayName: `${g.away} vs ${g.home}`, twitchUsername: g.gameId || '' }))
                 : type === 'news'   ? items.map(s => ({ displayName: s.title || s.link || '', twitchUsername: '' }))
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
              streamers: type === 'twitch' ? items.map(s => ({ displayName: s.displayName || s.name || s, twitchUsername: s.username || s }))
                 : type === 'nba'    ? items.map(g => ({ displayName: `${g.away} vs ${g.home}`, twitchUsername: g.gameId || '' }))
                 : type === 'news'   ? items.map(s => ({ displayName: s.title || s.link || '', twitchUsername: '' }))
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

    // ── Red 4: For News directive mode, write sidecar + extract spoken text ──
    // Must run BEFORE HeyGen send so HeyGen gets plain text, not raw JSON.
    let scriptForHeygen = script;
    if (type === 'news' && USE_DIRECTIVE_CHROME && scriptQA.outcome === 'pass') {
      try {
        const _cleaned = stripCodeFences(script);
        const _parsedDirective = JSON.parse(_cleaned);
        // Red 4 Fix 2: validate Gemini's directive script against the strict Zod schema.
        // Without this, schema drift between the prompt and the consumer is silent and
        // degrades to placeholder fixture data on the rendered overlay.
        // See: lib/chromeDirectives.js ScriptSchema for the canonical shape.
        const _validation = validateChromeScript(_parsedDirective);
        if (!_validation.ok) {
          const _errorList = _validation.errors.join('\n  - ');
          console.error(`[gate1-directive] ❌ Zod validation FAILED:\n  - ${_errorList}`);
          // Hard-fail: return 400 with Zod errors so the operator sees exactly what's wrong
          return res.status(400).json({
            ok: false,
            error: 'directive_validation_failed',
            qaResult: {
              outcome: 'fail',
              score: 0,
              deductions: _validation.errors.map(e => ({ points: 100, reason: e })),
              validatorErrors: _validation.errors
            }
          });
        }
        console.log(`[gate1-directive] ✅ Zod validation passed (${_parsedDirective.scenes?.length || 0} scenes, ${_parsedDirective.storyList?.length || 0} stories)`);
        // Extract spoken text FIRST — before writeDirectiveForJob which may throw on Zod validation.
        // This ensures scriptForHeygen is always plain text even if the sidecar write fails.
        scriptForHeygen = extractSpokenTextFromDirective(_parsedDirective);
        console.log(`[generate-full-script] ✅ Extracted ${scriptForHeygen.length} chars of spoken text from directive`);
        try {
          writeDirectiveForJob(jobId, _parsedDirective);
          console.log(`[generate-full-script] ✅ Directive sidecar written for job ${jobId}`);
        } catch(sidecarErr) {
          console.error(`[generate-full-script] ❌ FATAL: Failed to write directive sidecar: ${sidecarErr.message} — this will cause missing chrome!`);
        }
      } catch(e) {
        console.error(`[generate-full-script] ⚠️  Failed to parse directive JSON: ${e.message} — proceeding with raw script`);
      }
    }

    // ── Auto-send to HeyGen if Gate 1 passes ──────────────────────────
    // GATE_TEST_MODE=true disables auto-send so Gate 1 can be verified before HeyGen credits burn
    const GATE_TEST_MODE = process.env.GATE_TEST_MODE === 'true';
    let heygenResult = null;
    if (scriptQA.outcome === 'pass' && !GATE_TEST_MODE) {
      console.log('[generate-full-script] 🎬 Gate 1 PASSED — Auto-sending to HeyGen...');
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
      // Include metrics in response for debugging
      metricsJobId: jobId
    });

    // ── Persist job card to disk so server restarts don't lose it ──
    // Saved whenever Gate 1 passes and HeyGen is submitted.
    // Dashboard calls GET /jobs on load to restore the job queue.
    if (scriptQA.outcome === 'pass' && heygenResult && !heygenResult.error) {
      const jobCard = {
        jobId,
        scriptJobId: jobId,   // ← ADD THIS LINE — same value, explicit field for restore path
        contentType: type,
        date: dateStr,
        script,
        wordCount,
        estSecs,
        orderedClipUrls,
        heygen: heygenResult,
        gate1Score: scriptQA.score,
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
        })) : []
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
    res.status(500).json({ error: err.message });
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

  // Return best match if score >= 1, otherwise null (lowered from 2)
  return bestScore >= 1 ? bestMatch : null;
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
