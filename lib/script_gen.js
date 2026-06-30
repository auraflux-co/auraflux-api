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
// CPD-989: HeyGen config resolution lives in lib/avatar/adapters/heygen.js now.
const { nrPipelineEvent } = require('./nr_pipeline');
const pipelineBus = require('./pipeline_events');
const { recordWhyLedger, INTERVENTION, FAILURE_CLASS } = require('./why_ledger');
const { QA_TIER_REVIEW } = require('./qa_cycle');
const { auditAndRecordGateResult, preflightGateExecution } = require('./job_spec_contracts');
const { runUnifiedGatePolicy } = require('./portal_policy_runner');

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

/** Gate 1 on /generate-full-script does not go through assembly.emitGateResult — mirror bus events for monitoring + why_ledger. */
function emitScriptGate1Bus(scriptQA, ctx) {
  if (!scriptQA || !ctx?.jobId) return;
  const passed = !!scriptQA.passed;
  const event = passed ? 'gate:pass' : (scriptQA.outcome === 'sendback' ? 'gate:sendback' : 'gate:hard_fail');
  const reason = scriptQA.report
    || (scriptQA.deductions && scriptQA.deductions.map(d => d.reason).filter(Boolean).join('; '))
    || null;
  const payload = {
    jobId: ctx.jobId,
    customerId: ctx.customerId || 'c0',
    contentType: ctx.contentType || 'unknown',
    gate: 'gate1',
    score: scriptQA.score ?? null,
    outcome: scriptQA.outcome,
    attempt: ctx.retryAttempt,
    concerns: [],
    deductions: scriptQA.deductions || [],
    reason,
    fixDirective: scriptQA.fixDirective || {}
  };
  if (event === 'gate:sendback') payload.qaTier = QA_TIER_REVIEW;
  pipelineBus.emit(event, payload);
  try {
    auditAndRecordGateResult({
      jobId: ctx.jobId,
      gate: 'gate1',
      result: {
        gate: 'gate1',
        passed,
        outcome: scriptQA.outcome,
        score: scriptQA.score ?? null,
        deductions: scriptQA.deductions || [],
        concerns: [],
        report: reason
      },
      fallbackJobSpec: ctx.jobSpec || null
    });
  } catch (specAuditErr) {
    console.warn(`[gate-contracts] gate1 audit failed (non-fatal): ${specAuditErr.message}`);
  }
}

function parseSceneHeadersFromScript(script) {
  if (typeof script !== 'string' || !script.trim()) return [];
  const { normalizeInlineSceneHeaders } = require('./scaffold');
  const normalized = normalizeInlineSceneHeaders(script);
  // Only accept full-line scene markers to avoid matching instruction text.
  return Array.from(normalized.matchAll(/^===\s*([A-Z0-9_]+)\s*===\s*$/gm))
    .map((m) => String(m[1] || '').trim())
    .filter(Boolean);
}

function buildTranscriptBlocks(script, contentType) {
  return parseScriptIntoScenes(script, { contentType }).map((scene, idx) => ({
    idx,
    sceneId: scene.name || `SCENE_${idx + 1}`,
    type: scene.type || 'avatar',
    text: (scene.text || '').trim()
  }));
}

async function runGateHandoffReview({
  jobId,
  semanticJobId,
  gate,
  nextGate,
  contentType,
  jobSpec,
  script,
  scriptForHeygen,
  gateResult
}) {
  const { saveOutput } = require('./job_spec');
  const { normalizeScriptForGate1 } = require('./scaffold');
  const expectedHeaders = (jobSpec?.designSpec?.sceneStructure?.sceneHeaders || [])
    .map((h) => String(h || '').trim())
    .filter(Boolean);
  script = normalizeScriptForGate1(script, expectedHeaders);
  if (typeof scriptForHeygen === 'string') {
    scriptForHeygen = normalizeScriptForGate1(scriptForHeygen, expectedHeaders);
  }
  const review = {
    gate,
    nextGate,
    reviewedAt: new Date().toISOString(),
    contentType: contentType || null,
    checks: {},
    issues: []
  };
  const targetIds = [...new Set([jobId, semanticJobId].filter(Boolean))];
  const expectedHeaders = (jobSpec?.designSpec?.sceneStructure?.sceneHeaders || []).map((h) => String(h || '').trim()).filter(Boolean);
  const foundHeaders = parseSceneHeadersFromScript(script);
  const expectedClipCount = Number(
    jobSpec?.designSpec?.sceneStructure?.expectedClipCount
    ?? jobSpec?.designSpec?.expectedClipCount
    ?? 0
  ) || 0;

  if (expectedHeaders.length > 0) {
    const exactOrder =
      foundHeaders.length === expectedHeaders.length &&
      expectedHeaders.every((h, idx) => foundHeaders[idx] === h);
    review.checks.sceneHeaders = { pass: exactOrder, expected: expectedHeaders, found: foundHeaders };
    if (!exactOrder) review.issues.push('scene headers do not match jobSpec.sceneStructure.sceneHeaders');
  }

  const transcriptBlocks = buildTranscriptBlocks(script, contentType);
  const heygenBlocks = buildTranscriptBlocks(scriptForHeygen, contentType);
  const avatarCount = heygenBlocks.filter((b) => b.type === 'avatar').length;
  const sourceClipCount = heygenBlocks.filter((b) => b.type === 'source_clip').length;
  const headerClipCount = foundHeaders.filter((h) => /^STORY\d+_CLIP$/.test(h) || /_CLIP$/.test(h) || h === 'CLIP').length;
  const clipMarkerCount = (String(script || '').match(/\[CLIP PLAYS HERE\]/g) || []).length;
  const clipCount = Math.max(sourceClipCount, headerClipCount, clipMarkerCount);
  const parityPass = transcriptBlocks.length > 0 && heygenBlocks.length > 0;
  review.checks.transcriptBlocks = {
    pass: parityPass,
    transcriptBlockCount: transcriptBlocks.length,
    heygenBlockCount: heygenBlocks.length
  };
  if (!parityPass) review.issues.push('transcript blocks empty or HeyGen-parsed blocks empty');

  review.checks.avatarScenes = { pass: avatarCount > 0, avatarCount };
  if (avatarCount === 0) review.issues.push('no avatar scenes available for HeyGen submission');

  if (expectedClipCount > 0) {
    review.checks.clipCount = { pass: clipCount === expectedClipCount, expected: expectedClipCount, found: clipCount };
    if (clipCount !== expectedClipCount) review.issues.push(`clip count mismatch expected=${expectedClipCount} found=${clipCount}`);
  }

  const fallbackJobSpec = {
    ...(jobSpec || {}),
    state: {
      ...(jobSpec?.state || {}),
      gateResults: {
        ...(jobSpec?.state?.gateResults || {}),
        [gate]: gateResult || { passed: true, outcome: 'pass' }
      }
    }
  };
  const preflight = preflightGateExecution({ jobId, gate: nextGate, fallbackJobSpec });
  review.checks.nextGatePreflight = { pass: !!preflight.ready, reasons: preflight.reasons || [] };
  if (!preflight.ready) review.issues.push(`next gate ${nextGate} preflight failed: ${(preflight.reasons || []).join('; ')}`);

  review.passed = review.issues.length === 0;
  for (const id of targetIds) {
    try {
      await saveOutput(id, `${gate}_handoff_review`, review);
    } catch (e) {
      console.warn(`[handoff-review] saveOutput failed for ${id}: ${e.message}`);
    }
  }
  return { review, transcriptBlocks, heygenBlocks };
}

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
The avatar reads EVERYTHING aloud. No parenthetical pronunciation guides — they get spoken twice.
- ANY word that needs special pronunciation (names, places, brands, jargon): write ONLY the phonetic spelling directly in the script — e.g. "ee-RAHN" not "Iran (ee-RAHN)", "LAY-see" not "Lacy (LAY-see)". Never use parentheses for pronunciation.
- Common NBA names (LeBron, Curry, Durant, Luka, Giannis) HeyGen handles fine — leave them as-is
- Only respell unusual words when HeyGen will mispronounce the normal spelling
- Spell out numbers: "thirty-two points" NOT "32 points"
- "NBA" and "MVP" are fine as-is

SCRIPT FORMAT — Plain text only. No JSON, no XML. Use EXACTLY the === SCENE HEADERS === from the user prompt. One scene per header. Do not combine. Do not skip.
Target: 120-150 words of SPOKEN TEXT per game segment (90 seconds of delivery).

COLD OPEN — The === INTRO === scene is already pre-filled by the scaffold with the LOCKED text. DO NOT change it. Copy it exactly as written in the scaffold.

OUTRO — The === OUTRO === scene is already pre-filled by the scaffold with the LOCKED text. DO NOT change it. Copy it exactly as written in the scaffold.

DELIVERY NOTE — OUTRO: Last line lands flat. No warmup, no runway. Just state it and stop.

NBA VOICEOVER STRUCTURE — IMPORTANT:
The avatar speaks WHILE the clip plays. Write commentary assuming it plays as audio OVER the highlight — not before or after. Present tense. Immediate.`,

news: `You write scripts for "Because the Light Was On" — a ClipzWorld News world news show.

HOST PERSONA: The Literal Satirist.
VOCAL SETTING: Dry, mid-tempo, monotone with long pauses.
Present facts. Make one observation. Move on. The host is not alarmed. Not your friend. A newsreader who has been doing this too long. The comedy comes from the gap between what happened and how calmly it is reported.

POLITICAL ACCURACY — CURRENT AS OF 2026:
- Donald Trump IS the current US President (2025–). NEVER say "former President Trump".
- Joe Biden is the former US President. Refer to him as "former President Biden".
- Do not invent titles or tenure dates — use the current reality above.

STRICT RULES:
- Each story: setup (1-2 sentences, headline + context) → [beat] → [CLIP PLAYS HERE] → [beat] → reaction (1 flat sentence, stated plainly, done)
- Never say "shocking", "alarming", "incredible", "wild", "you won't believe this"
- Never explain why the observation is significant — state it and stop
- Never editorialize with emotion
- [beat] = pause. Use it. Long pauses are part of the delivery.
- [CLIP PLAYS HERE] = structural marker, not spoken
- Write every single line — no brackets, no placeholders

HEYGEN PRONUNCIATION:
The avatar reads EVERYTHING aloud. No parenthetical pronunciation guides — they get spoken twice.
- ANY word that needs special pronunciation (names, places, leaders, brands): write ONLY the phonetic spelling directly — never "Iran (ee-RAHN)" or "Zelenskyy (zeh-LEN-skee)"
- Common names (Iran, Qatar, Beijing, Ukraine) HeyGen usually handles — leave as-is unless you respell without parentheses
- Spell out numbers: "twenty-three" NOT "23"
- "UN" → "U-N" or "the UN"

SCRIPT FORMAT — Plain text only. No JSON, no XML. Use EXACTLY the === SCENE HEADERS === from the user prompt. One scene per header. Do not combine. Do not skip.
Target: 80-120 words of SPOKEN TEXT per story.

COLD OPEN — The === INTRO === scene is already pre-filled by the scaffold with the LOCKED text. DO NOT change it. Copy it exactly as written in the scaffold.

OUTRO — The === OUTRO === scene is already pre-filled by the scaffold with the LOCKED text. DO NOT change it. Copy it exactly as written in the scaffold.

DELIVERY NOTE — OUTRO: Flat. No warmth. No runway. State it and stop.

NEWS STORY STRUCTURE:
[Setup — 1-2 sentences. Headline + one fact. What happened, stated plainly.]
[beat]
[CLIP PLAYS HERE]
[beat]
[SUMMARY — 1 sentence. A real, factual follow-on detail from the story. NOT a description of what was on screen. NEVER say "The clip showed…", "The video displayed…", "The graphic highlighted…". Give a new fact, a number, context, or consequence the viewer now needs.]
[beat]
[REACTION — 1 sentence. Flat. Deadpan. Could be a non-sequitur. The host's one-line take on the whole story. Do not explain it.]
[beat]
Source: [Source name]. Link in description.`,

twitch: `You write scripts for "Twitch Soup" — a ClipzWorld News Twitch clip reaction show.

HOST PERSONA: The Internet's Reluctant Janitor.
VOCAL SETTING: Fast, slightly annoyed, high-frequency.
The host has seen everything on this platform and is no longer impressed. He is reporting from the digital dumpster fire. He does not enjoy it. He is here because it is his job. The clip is the joke — he just witnesses it and says one flat thing.

STRICT RULES:
- ALWAYS call the streamer by their ON-AIR NAME. NEVER say "this streamer", "a Twitch streamer", or "this Twitch streamer" in place of the name — the audience clicked for the person.
- Intro the streamer briefly (2-3 sentences max), then [CLIP PLAYS HERE]
- After the clip: Write ONE reaction line — the single best flat take. ONE sentence only. Could be a non-sequitur. Do not explain what just happened. Do NOT write "Option A/B/C" or multiple alternatives — pick the best line and output it alone.
- "Follow [streamer]. Link in description." goes ONLY on the LAST clip reaction for that streamer, after the reaction line. Do NOT add it to earlier reactions.
- Never say "that was incredible", "oh my god", or anything that hypes or explains the clip
- Never summarize what the viewer just watched
- Write every single line — no brackets, no placeholders
- Use the visual analysis to know what the clip is — do not narrate it

HEYGEN PRONUNCIATION:
The avatar reads EVERYTHING aloud. No parenthetical pronunciation guides — they get spoken twice.
- ANY word that needs special pronunciation: write ONLY the phonetic spelling directly in the script — never "Word (guide)" in parentheses
- Streamer names: if streamers.json has a phonetic field, write ONLY that spelling (e.g. "LAY-see" not "Lacy (LAY-see)")
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

INTRO SCENE — The === INTRO === scene is already pre-filled by the scaffold with the LOCKED text. DO NOT change it. Copy it exactly as written in the scaffold.

OUTRO SCENE — The === OUTRO === scene is already pre-filled by the scaffold with the LOCKED text. DO NOT change it. Copy it exactly as written in the scaffold.

Target: 80-100 words of SPOKEN TEXT per streamer (45 seconds before and after clip).

DELIVERY NOTE — STREAMER INTRO + CLIP SETUP: Streamer intro and all CLIP#_SETUP scenes are speech only — no [scene hold], no trailing [studio laugh] on intros. Scene-reset joins rely on the previous REACTION's [studio laugh] hold + crowd, then the next scene speaks immediately.

DELIVERY NOTE — REACTIONS + FOLLOW LINE + STUDIO LAUGH: Each CLIP_REACTION scene is ONE spoken reaction line (no Option A/B/C labels, no alternates). The "Follow [name]. Link in description." line goes on the LAST clip reaction only, AFTER a [studio laugh] pause (4 seconds — avatar holds still while crowd audio plays in assembly). Do NOT use [beat] before the follow line — use [studio laugh] instead.

Last-clip reaction example:
"He knew exactly what he was doing the whole time.
[studio laugh]
Follow Jason. Link in description."

Earlier-clip reactions: one reaction line, then [studio laugh] at the end — no follow line.`,

// ── TOP-10 COUNTDOWN (CPD-997) — twitch pipeline, ranking variant ────────────
// Runs on type 'twitch' with scriptVariant 'top10'. Same scene machinery
// (NAME_INTRO / NAME_CLIP#_SETUP / NAME_CLIP#_REACTION), countdown narrative.
top10: `You write scripts for "Twitch Soup" — a ClipzWorld News Twitch countdown show.

HOST PERSONA: The Internet's Reluctant Janitor, forced to host an awards show.
VOCAL SETTING: Fast, slightly annoyed, high-frequency — but tonight there are RANKINGS, and the host treats the ranking as deadly serious bureaucracy.
He has seen everything on this platform and is no longer impressed. The countdown is the format: every entry gets its number announced flatly, like reading a court docket. The clip is the evidence. He just presents it and says one flat thing.

THIS IS A COUNTDOWN SHOW:
- The user prompt assigns each streamer a RANK NUMBER. The list counts DOWN to number one.
- Each streamer's _INTRO scene MUST open by announcing the rank: "Number five." [beat] then the intro.
- Build stakes as the numbers get smaller — not with hype words, but with shorter sentences and flatter delivery. Number one gets the flattest read of the night.
- NEVER reveal a later (better) entry early. NEVER say who is coming up next.

STRICT RULES:
- ALWAYS call the streamer by their ON-AIR NAME. NEVER say "this streamer" or "a Twitch streamer" — the audience clicked for the person.
- Announce the rank, intro the streamer briefly (2-3 sentences max), then [CLIP PLAYS HERE]
- After the clip: Write ONE reaction line — the single best flat take. ONE sentence only. Could be a non-sequitur. Do not explain what just happened. Do NOT write "Option A/B/C" or multiple alternatives — pick the best line and output it alone.
- "Follow [streamer]. Link in description." goes ONLY on the LAST clip reaction for that streamer, after the reaction line.
- Never say "that was incredible", "oh my god", or anything that hypes or explains the clip
- Never summarize what the viewer just watched
- Write every single line — no brackets, no placeholders
- Use the visual analysis to know what the clip is — do not narrate it

TTS PRONUNCIATION:
The avatar reads EVERYTHING aloud. No parenthetical pronunciation guides — they get spoken twice.
- ANY word that needs special pronunciation: write ONLY the phonetic spelling — NEVER "Word (guide)" in parentheses
- Streamer names: if a phonetic spelling is provided, write ONLY that spelling — "LAY-see" is correct; "LAY-see (Lacy)" is WRONG
- Numbers: rank announcements are spelled out → "Number five." NOT "Number 5." / "#5"
- View counts: spell out → "fifty thousand viewers" NOT "50k viewers"
- Commas create natural pauses in speech

⚠️ SCENE STRUCTURE — CRITICAL:
The user prompt provides a NUMBERED LIST of === SCENE HEADERS ===.
Output EXACTLY that many scenes with EXACTLY those headers.
- ONE scene per header — do NOT combine
- Do NOT skip any headers
- Do NOT create your own headers

SCRIPT FORMAT — Plain text only. No JSON, no XML.

INTRO SCENE — The === INTRO === scene is already pre-filled by the scaffold with the LOCKED text. DO NOT change it. Copy it exactly as written in the scaffold.

OUTRO SCENE — The === OUTRO === scene is already pre-filled by the scaffold with the LOCKED text. DO NOT change it. Copy it exactly as written in the scaffold.

Target: 80-100 words of SPOKEN TEXT per ranked entry (45 seconds before and after clip).

DELIVERY NOTE — RANK ANNOUNCEMENTS: The rank is its own beat. "Number five." [beat] — then the streamer intro. Never run the number into the sentence.

DELIVERY NOTE — REACTIONS + FOLLOW LINE + STUDIO LAUGH: Each CLIP_REACTION scene is ONE spoken reaction line (no Option A/B/C labels, no alternates). The "Follow [name]. Link in description." line goes on the LAST clip reaction only, AFTER [studio laugh] (4s pause — crowd laugh plays here in assembly). Use [studio laugh] not [beat] before the follow line.`,

// ── SHORTS / REELS (portrait 9:16, single subject, ~45 seconds total) ───────
'nba-short': `You write short-form scripts for ClipzWorld News — Other Side of the Pillow (NBA).

FORMAT: 9:16 split-screen. 0-3s HOOK (top screen, BobbyG states the value/stakes), then clip plays bottom while BobbyG is held/silent on top, then 2-4 line REACTION (top screen, fast-paced punchy commentary). Total under 60 seconds.

YOUR OUTPUT HAS THREE PARTS:

1. HOOK (1-2 lines Bobby G says BEFORE the clip — immediate value, shock, or question):
- State the stakes in the fewest words. Player name + action + why it matters.
- Under 3 seconds (~10-15 words total). No "Hey guys". No preamble.
- Example: "Murray. Down two. Fifteen seconds left."

2. REACTION (2-4 lines Bobby G says AFTER the clip ends):
- Fast-paced punchy commentary. Sharp emotional reaction or analysis that ADDS VALUE.
- Not a recap of what they just saw. The take. The implication. The unspoken thing.
- Example: "He's been doing that all season. Nobody's guarding him in the fourth. That's a problem that only gets worse in the playoffs."

3. CAPTION (max 3 words — "The Vibe" style):
- Standalone text overlay. Electric blue. Slanted. Rhythmic. Confident.
- Reads instantly. The cold fact or the vibe check.
- Good: "ICE IN VEINS" / "NOBODY GUARDING HIM" / "CLOCK SAID NO"
- Bad: "Amazing play!" / "Watch this!"

NO OUTRO. No sign-off. The caption IS the ending.

OUTPUT FORMAT — use exactly this structure:
=== NBA SHORT ===
HOOK: [1-2 lines before clip, under 3 seconds]
[CLIP PLAYS HERE]
REACTION: [2-4 lines after clip — the take, not the recap]
CAPTION: [max 3 words, uppercase, vibe-check style]`,

'news-short': `You write short-form scripts for ClipzWorld News — Because the Light Was On (News).

FORMAT: 9:16 split-screen. 0-3s HOOK (top screen, BobbyG states the story immediately), then clip plays bottom while BobbyG is held/silent on top, then 2-4 line REACTION (top screen, punchy commentary). Total under 60 seconds.

POLITICAL ACCURACY — CURRENT AS OF 2026:
- Donald Trump IS the current US President (2025–). NEVER say "former President Trump".
- Joe Biden is the former US President. Refer to him as "former President Biden".
- Do not invent titles or tenure dates — use the current reality above.

YOUR OUTPUT HAS THREE PARTS:

1. HOOK (1-2 lines Bobby G says BEFORE the clip — immediate value or shock):
- State WHAT HAPPENED in the fewest words. No alarm, no hype buildup. Just the fact.
- Under 3 seconds (~15 words total). No "breaking news". No "hey guys".
- Example: "A city just banned car horns. Here's the first day."

2. REACTION (2-4 lines Bobby G says AFTER the clip ends):
- Fast-paced punchy commentary. The absurd implication, the unspoken consequence, the sharp take.
- NOT a recap. The viewer just watched the clip — do NOT describe what was in it.
- NEVER say "The clip showed…", "The video displayed…", "The graphic highlighted…", or any variation of describing the visuals.
- Give them something NEW: a follow-on fact, a number, a consequence, or the unspoken implication.
- Example: "The city didn't solve noise. They solved blame. These are different problems with the same fine."

3. CAPTION (max 6 words — "Deadpan Headline" style):
- Standalone text overlay. Yellow background, black serif text. Breaking news chyron format.
- Slightly wrong. Not AP wire copy. The real headline but one beat off.
- Good: "City Very Quiet About This." / "Drones Still A Thing." / "Fine Issued, Confusion Ongoing."
- Bad: "Ukraine War Continues." (too real) / "Unbelievable!" (too vague)

NO OUTRO. No sign-off. The caption IS the ending.

OUTPUT FORMAT — use exactly this structure:
=== NEWS SHORT ===
HOOK: [1-2 lines before clip, under 3 seconds]
[CLIP PLAYS HERE]
REACTION: [2-4 lines after clip — the implication, not the recap]
CAPTION: [max 6 words, Title Case, subtly absurd chyron]`,

'reddit-short': `You write short-form scripts for ClipzWorld News — Because the Light Was On: Reddit Desk (THE THREAD).

FORMAT: 9:16 split-screen. HOOK → clip → REACTION. BTL deadpan voice — not Twitch Soup energy.

HOST PERSONA: Literal satirist reading the internet's witness stand. OP write-up + top comments are your script fuel. Name the subreddit once. Quote comment energy without reading comments verbatim.

YOUR OUTPUT HAS THREE PARTS:
1. HOOK — state the Reddit post's absurd premise in under 15 words (what happened + why scroll-stopping)
2. REACTION — 2-4 lines AFTER the clip. Weave ONE top-comment angle + one flat Bobby G observation. NOT a recap of pixels.
3. CAPTION — max 6 words, Title Case, deadpan chyron slightly wrong

Use OP text + comment thread from the user prompt. Never invent events not in OP/analysis/comments.

OUTPUT FORMAT:
=== REDDIT SHORT ===
HOOK: [...]
[CLIP PLAYS HERE]
REACTION: [...]
CAPTION: [...]`,

'reddit': `You write scripts for "Because the Light Was On — Reddit Desk" (THE THREAD).

HOST PERSONA: BTL Literal Satirist. One Reddit post per episode. OP write-up + comment thread inform every beat — Gemini video analysis grounds clip beats.

STRUCTURE: INTRO (locked) → POST_SETUP (context from OP) → alternating BEAT#_REACT / BEAT#_CLIP → THREAD_CLOSE (best comment energy, flat) → OUTRO (locked).

RULES:
- POST_SETUP: headline + OP selftext in 2-3 deadpan sentences
- Each BEAT#_REACT: react BEFORE that clip chunk — one sharp line, optionally echo a comment's vibe
- BEAT#_CLIP: source_clip only, no spoken text
- THREAD_CLOSE: 1-2 sentences — the thread's collective verdict, stated flat
- Never recap the whole video; each beat is a new angle from OP/comments/analysis
- Never say "shocking", "insane", "you won't believe"

SCRIPT FORMAT — plain text, === SCENE HEADERS === exactly as scaffold.`,

'twitch-short': `You write short-form scripts for ClipzWorld News — Twitch Soup.

FORMAT: 9:16 split-screen. 0-3s HOOK (top screen, BobbyG states who and why immediately), then clip plays bottom while BobbyG is held/silent on top, then 2-4 line REACTION (top screen, punchy internet voice). Total under 60 seconds.

YOUR OUTPUT HAS THREE PARTS:

1. HOOK (1-2 lines Bobby G says BEFORE the clip — immediate value, who this is and the shock):
- State who this streamer is BY NAME and why you're stopping your scroll right now.
- NEVER "this streamer" / "a Twitch streamer" — say the on-air name. The name IS the hook.
- Under 3 seconds (~15 words total). No preamble. No "hey guys". Name + fact.
- Example: "This is Jason. He spent eight hours on this and it still didn't work."

2. REACTION (2-4 lines Bobby G says AFTER the clip ends):
- Fast-paced punchy internet-voice commentary. The meme take. The unfiltered observation.
- What the top comment on the clip would be, if someone with a vocabulary wrote it.
- Add value — not just restating what happened.
- Example: "He had every warning sign. The game told him three times. He interpreted all three as encouragement."

3. CAPTION (max 4 words — "Viewer's Internal Thought" style):
- Standalone text overlay. Twitch purple background. Bold Impact font. All caps. Emoji allowed.
- Internet speak. Sarcastic. What the viewer's brain just said.
- Good: "WHO LET HIM COOK 💀" / "CHAT WAS RIGHT" / "L + RATIO"
- Bad: "This is interesting." / "What a play!" (too formal, too hype)

NO OUTRO. No sign-off. The caption IS the ending.

OUTPUT FORMAT — use exactly this structure:
=== TWITCH SHORT ===
HOOK: [1-2 lines before clip, under 3 seconds]
[CLIP PLAYS HERE]
REACTION: [2-4 lines after clip — the internet take, not the recap]
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

// CPD-978: roster (data/streamers.json) is the source of truth for on-air
// names + phonetic respellings; the hardcoded map above is the fallback for
// logins not yet in the roster file.
let _rosterByLogin = null;
function _loadRosterIndex() {
  if (_rosterByLogin) return _rosterByLogin;
  _rosterByLogin = {};
  try {
    const raw = require('fs').readFileSync(require('path').join(__dirname, '..', 'data', 'streamers.json'), 'utf8');
    for (const s of (JSON.parse(raw)?.roster || [])) {
      if (s.twitchUsername) _rosterByLogin[s.twitchUsername.toLowerCase()] = s;
    }
  } catch { /* fail-open to hardcoded map */ }
  return _rosterByLogin;
}

function getDisplayName(twitchUsername) {
  if (!twitchUsername) return twitchUsername;
  const login = twitchUsername.toLowerCase();
  const rosterEntry = _loadRosterIndex()[login];
  return rosterEntry?.onAirName || rosterEntry?.displayName ||
    STREAMER_DISPLAY_NAMES[login] || twitchUsername;
}

/** Phonetic respelling for HeyGen pronunciation (streamers.json), or null. */
function getPhonetic(twitchUsername) {
  if (!twitchUsername) return null;
  return _loadRosterIndex()[twitchUsername.toLowerCase()]?.phonetic || null;
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

/** HeyGen UI + bulk download often truncate filenames — scene index must lead; trim the middle, not the prefix/suffix. */
const HEYGEN_TITLE_MAX_LEN = 120;

function shortContentTypeTag(contentType) {
  const ct = String(contentType || '').toLowerCase();
  const map = {
    twitch: 'tw',
    'twitch-short': 'twS',
    'clips-short': 'cS',
    news: 'nw',
    'news-short': 'nwS',
    nba: 'nba',
    'nba-short': 'nbaS'
  };
  if (map[ct]) return map[ct];
  return ct.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'unk';
}

function sanitizeHeyGenTitlePart(s, maxLen) {
  const out = String(s || '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, Math.max(1, maxLen));
  return out || 'SC';
}

/**
 * Short label for HeyGen title only — pipeline order is carried by sceneIndex prefix on the title.
 * Stops long TEAM_VS_TEAM strings from pushing idx/tag past HeyGen's visible/download cutoff.
 */
function compactSceneNameForHeyGen(sceneName) {
  const s = String(sceneName || '').trim();
  if (!s) return 'SC';
  const mGame = s.match(/^GAME(\d+)_.*_(INTRO|CLIP|NARRATION|OUTRO)$/i);
  if (mGame) return `G${mGame[1]}_${mGame[2].toUpperCase()}`;
  const mStory = s.match(/^STORY(\d+)_.*_(INTRO|CLIP|NARRATION|OUTRO)$/i);
  if (mStory) return `S${mStory[1]}_${mStory[2].toUpperCase()}`;
  if (/^INTRO$/i.test(s)) return 'INTRO';
  if (/^OUTRO$/i.test(s)) return 'OUTRO';
  return s;
}

function buildHeyGenVideoTitle({ contentType, sceneName, sceneIndex, runTag }) {
  const ct = shortContentTypeTag(contentType);
  const idx = String(Number(sceneIndex) || 0).padStart(2, '0');
  const tag = sanitizeHeyGenTitlePart(runTag, 12);
  const prefix = `${idx}_${ct}_`;
  const suffix = tag ? `_${tag}` : '';
  const compacted = compactSceneNameForHeyGen(sceneName);
  let maxScene = HEYGEN_TITLE_MAX_LEN - prefix.length - suffix.length;
  if (maxScene < 8) maxScene = 8;
  const scene = sanitizeHeyGenTitlePart(compacted, maxScene);
  return `${prefix}${scene}${suffix}`;
}

/** Stable tail derived from the same jobId used for Gate 0–5 + poller (not a second synthetic id). */
function runTagFromCanonicalJobId(jobId) {
  if (!jobId || jobId === 'unknown') return null;
  const compact = String(jobId).replace(/[^A-Za-z0-9_-]/g, '');
  if (!compact) return null;
  return compact.length <= 12 ? compact : compact.slice(-12);
}

/**
 * Delivery enhancement (CPD-606) — replicates HeyGen web app "Auto-enhance".
 * One Gemini call inserts ElevenLabs v3 audio tags + <break> pauses into each avatar
 * scene's text without changing any spoken words. Requires the eleven_v3 voice engine
 * at submit time (set by the caller) so tags are performed, not read aloud.
 *
 * @param {Array<{name: string, text: string, type?: string}>} scenes
 * @param {string} contentType
 * @returns {Promise<Object>} map of scene index → enhanced text (avatar scenes only)
 */
async function enhanceDeliveryTags(scenes, contentType) {
  if (!GEMINI_APIKEY) throw new Error('GEMINI_API_KEY not configured');

  const avatarScenes = scenes
    .map((s, i) => ({ index: i, name: s.name, text: s.text, type: s.type }))
    .filter(s => s.type !== 'source_clip');
  if (avatarScenes.length === 0) return {};

  const prompt = `You are a voice delivery director for a high-energy sports/gaming commentary show.
For each scene below, enhance the delivery by inserting:
- ElevenLabs v3 audio tags in square brackets to direct emotion and non-verbal sounds, e.g. [excited], [whispers], [laughs], [sighs], [curious], [sarcastic], [shouts]
- <break time="0.5s"/> style pause tags at dramatic moments (0.3s-1.5s, space before and after the tag)

STRICT RULES:
1. Do NOT add, remove, or change ANY spoken words — only insert tags between words/sentences
2. Use tags sparingly: 1-3 audio tags and 0-2 break tags per scene, only where they genuinely fit the content
3. Place audio tags immediately before the phrase they apply to
4. Keep the show's energy: punchy, enthusiastic, occasionally conspiratorial — never monotone
5. Content type: ${contentType}

Scenes (JSON):
${JSON.stringify(avatarScenes.map(({ index, name, text }) => ({ index, name, text })))}

Respond with ONLY a JSON array (no markdown fences): [{"index": <number>, "enhanced": "<text with tags>"}]`;

  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
    { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4 } },
    { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
  );

  const raw = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed)) throw new Error('Gemini response is not a JSON array');

  const stripTags = (t) => t.replace(/\[[^\]]{1,30}\]/g, '').replace(/<break[^>]*\/>/g, '');
  const normalize = (t) => t.replace(/\s+/g, ' ').trim();

  const out = {};
  for (const row of parsed) {
    const original = scenes[row.index]?.text;
    if (!original || typeof row.enhanced !== 'string' || !row.enhanced.trim()) continue;
    // Safety: reject any enhancement that altered the spoken words — Gate 1 approved the exact text
    if (normalize(stripTags(row.enhanced)) !== normalize(original)) {
      console.warn(`[heygen-enhance] ⚠️  Scene ${row.index} altered spoken words — using original text`);
      continue;
    }
    if (row.enhanced !== original) out[row.index] = row.enhanced;
  }
  return out;
}

async function sendScriptToHeyGen(script, opts = {}) {
  const {
    contentType = 'twitch',
    format = 'landscape', // 'landscape' for long form, 'portrait' for short form
    jobId = 'unknown',
    heygenRunId = null,
    existingVideoJobs = [],
    onSceneComplete = null
  } = opts;

  const runTag = heygenRunId
    ? sanitizeHeyGenTitlePart(heygenRunId, 12)
    : (runTagFromCanonicalJobId(jobId)
      || sanitizeHeyGenTitlePart(`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, 12));
  const HEYGEN_SIM_MODE = process.env.HEYGEN_SIM_MODE === 'true';

  // Load HeyGen credentials from environment
  const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
  const HEYGEN_VOICE_ID = process.env.HEYGEN_VOICE_ID;

  // CPD-989: avatar/voice/speed/engine resolution moved behind the avatar adapter layer.
  const avatar = require('./avatar');
  const avatarCfg = avatar.resolveConfig({ contentType, format });
  let avatarId = avatarCfg.avatarId;
  let HEYGEN_VOICE_ID_RESOLVED = avatarCfg.voiceId || HEYGEN_VOICE_ID;
  if (String(contentType).includes('twitch') && !String(contentType).includes('-short') && format === 'landscape') {
    try {
      const { resolveHeygenShow } = require('./heygen_shows');
      const show = resolveHeygenShow({ customerId: opts.customerId || 'c0', showKey: opts.showKey, card: opts.card });
      if (show.ok) {
        avatarId = show.avatarId;
        if (show.voiceId) HEYGEN_VOICE_ID_RESOLVED = show.voiceId;
        console.log(`[heygen] Show "${show.label}" → avatar ${avatarId.slice(0, 8)}… folder ${show.heygenFolder}`);
      } else {
        console.warn(`[heygen] Show resolve: ${show.error}`);
      }
    } catch (_hs) { /* non-fatal */ }
  }
  const avatarEngine = 'heygen';

  if (!HEYGEN_SIM_MODE && !HEYGEN_API_KEY) {
    throw new Error('HEYGEN_API_KEY not set in environment');
  }
  const HEYGEN_SPEAK_SPEED = avatarCfg.speakSpeed;
  const HEYGEN_ENGINE = avatarCfg.engine;

  // Delivery enhancement (CPD-606): Gemini inserts ElevenLabs v3 audio tags ([excited], [whispers]...)
  // + <break> pauses into the HeyGen script, and voice_settings switches to the eleven_v3 engine which
  // interprets the tags as delivery direction instead of speaking them. Replaces the web app's
  // "Auto-enhance" delivery style. Set HEYGEN_ENHANCE_DELIVERY=0 to disable (plain text, default engine).
  const HEYGEN_ENHANCE_DELIVERY = !['0', 'false', 'no'].includes(String(process.env.HEYGEN_ENHANCE_DELIVERY || '1').toLowerCase());

  let reactionPauseSec = null;
  let sceneHoldPauseSec = Number(process.env.SCENE_HOLD_SEC) || 1;
  try {
    const {
      isStudioLaughEnabled,
      getStudioLaughConfig,
      injectStudioLaughPausesInScript,
    } = require('./studio_laughter');
    if (String(contentType).includes('twitch') && isStudioLaughEnabled('c0')) {
      reactionPauseSec = getStudioLaughConfig('c0')?.reactionPauseSec ?? 4;
      script = injectStudioLaughPausesInScript(script);
      const { injectSceneResetHoldsInScript } = require('./soup_scene_reset_holds');
      script = injectSceneResetHoldsInScript(script);
    }
  } catch (_) {}

  // Template IDs (pre-baked avatar+background — lower render cost)
  const HEYGEN_TEMPLATE_LANDSCAPE = process.env.HEYGEN_TEMPLATE_LANDSCAPE || 'a917e52ebb164cc8ab3da97936361829';
  const HEYGEN_TEMPLATE_PORTRAIT  = process.env.HEYGEN_TEMPLATE_PORTRAIT  || 'ae51839648a84ce891bd83e0a44798db';
  const templateId = format === 'portrait' ? HEYGEN_TEMPLATE_PORTRAIT : HEYGEN_TEMPLATE_LANDSCAPE;

  // Parse script into scenes
  let scenes = parseScriptIntoScenes(script, { contentType });
  if (String(contentType).includes('twitch')) {
    const { mergeStreamerBlockHeyGenScenes } = require('./soup_intro_clip1_merge');
    scenes = mergeStreamerBlockHeyGenScenes(scenes, { contentType });
    const mergedIntro = scenes.filter((s) => s.introClip1Merged);
    const mergedRxn = scenes.filter((s) => s.reactionClip2Merged);
    if (mergedIntro.length || mergedRxn.length) {
      console.log(`[heygen] Streamer block merges: intro+clip1=${mergedIntro.length} reaction+clip2=${mergedRxn.length}`);
    }
  }

  console.log(`[heygen] Submitting ${scenes.length} scenes to HeyGen as individual videos (${contentType}, ${format}, avatar: ${avatarId.slice(0,8)}...)`);

  if (scenes.length === 0) {
    throw new Error('No scenes found in script. Script must have === SCENE_NAME === markers.');
  }

  console.log(`[heygen] Scene breakdown:`);
  scenes.forEach((scene, idx) => {
    console.log(`  ${idx + 1}. ${scene.name} - ${scene.text.substring(0, 50)}... (${scene.text.length} chars)`);
  });

  // Delivery enhancement (CPD-606) — non-fatal: any failure falls back to the original Gate-1 text.
  // Only the HeyGen `script` field gets the tagged text; sceneTextMap/captions/QA keep the original.
  let enhancedTexts = {};
  if (HEYGEN_ENHANCE_DELIVERY && !HEYGEN_SIM_MODE) {
    try {
      enhancedTexts = await enhanceDeliveryTags(scenes, contentType);
      const enhancedCount = Object.keys(enhancedTexts).length;
      console.log(`[heygen-enhance] ✅ Delivery tags added to ${enhancedCount}/${scenes.filter(s => s.type !== 'source_clip').length} avatar scenes`);
    } catch (e) {
      console.warn(`[heygen-enhance] ⚠️  Enhancement failed (${e.message}) — submitting original text`);
      enhancedTexts = {};
    }
  }

  const { resolveHeyGenFolderId } = require('./heygen_folder_map');
  const heygenFolderId = resolveHeyGenFolderId(contentType);
  if (heygenFolderId && !HEYGEN_SIM_MODE) {
    // POST /v3/videos rejects unknown fields (additionalProperties: false) and has no folder_id —
    // videos land in the HeyGen default library. Pipeline matching uses video_id + title, so this is cosmetic.
    console.warn(`[heygen] folder routing not supported on v3 API — ${contentType} videos go to HeyGen default library (was folder ${heygenFolderId})`);
  }

  // Submit each scene as a separate video generation request
  // In sim mode we generate local synthetic MP4s so Gate 2/assembly can run without HeyGen spend.
  const videoJobs = Array.isArray(existingVideoJobs) ? [...existingVideoJobs] : [];
  const completedScenes = new Set(
    videoJobs.filter((v) => v.status === 'completed' && v.video_id).map((v) => v.sceneName)
  );

  try {
  function resolveSimFontFile() {
    const env = process.env.HEYGEN_SIM_FONT;
    if (env && fs.existsSync(env)) return env;
    const candidates = [
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/System/Library/Fonts/Helvetica.ttc',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
      '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  async function buildSimClip(scene, sceneIndex) {
    const { execFile } = require('child_process');
    const { ffmpegPath } = require('./ffmpeg_utils');
    const outDir = path.join(TMP_DIR, 'heygen_sim');
    fs.mkdirSync(outDir, { recursive: true });
    const durSec = Math.max(4, parseInt(process.env.HEYGEN_SIM_DURATION_SEC || '6', 10) || 6);
    const w = format === 'portrait' ? 720 : 1280;
    const h = format === 'portrait' ? 1280 : 720;
    const safeScene = String(scene.name || `SCENE_${sceneIndex + 1}`).replace(/[^A-Za-z0-9_ -]/g, '').slice(0, 40);
    const outPath = path.join(outDir, `${jobId}_${String(sceneIndex).padStart(2, '0')}_${safeScene}.mp4`);
    const label = `${safeScene}`.replace(/:/g, '\\:').replace(/'/g, "\\'");
    const font = resolveSimFontFile();
    // testsrc2 animates — avoids false freeze flags; sine + atrim keeps mean volume above Gate 2 silence floor
    const box = `drawbox=x=0:y=0:w=iw:h=72:color=0x111827@0.88:t=fill`;
    const text = font
      ? `,drawtext=fontfile=${font.replace(/:/g, '\\:')}:text='SIM ${label}':x=24:y=24:fontsize=28:fontcolor=white`
      : `,drawtext=text='SIM':x=24:y=24:fontsize=28:fontcolor=white`;
    const draw = `${box}${text}`;
    const args = [
      '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=30`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', String(durSec),
      '-vf', draw,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '44100', '-shortest',
      '-y', outPath
    ];
    await new Promise((resolve, reject) => {
      const p = execFile(ffmpegPath(), args, { timeout: 45000, maxBuffer: 20 * 1024 * 1024 });
      p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg sim clip failed (${code})`)));
      p.on('error', reject);
    });
    return outPath;
  }

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];

    // Skip source_clip scenes — they are video clips, not avatar renders.
    // Bobby G does NOT speak in source_clip scenes — the clip plays instead.
    // Submitting them to HeyGen causes assembly sync issues (avatar nulled during voiceover).
    if (scene.type === 'source_clip') {
      console.log(`[heygen] ⏭  Skipping source_clip scene: ${scene.name}`);
      continue;
    }

    if (completedScenes.has(scene.name)) {
      console.log(`[heygen] ⏭  Skipping already-rendered scene: ${scene.name}`);
      continue;
    }

    // Build single-scene video request
    // Title is for HeyGen library UX only; pipeline matches segments via video_id + sceneName on the job card.
    const sharedTitle = buildHeyGenVideoTitle({
      contentType,
      sceneName: scene.name,
      sceneIndex: i,
      runTag
    });
    // CPD-989: request body construction moved into lib/avatar/adapters/heygen.js.
    // Chrome overlay, ticker, logo added by assembly (FFmpeg) — not the avatar engine.
    const sceneScript = enhancedTexts[i] || scene.text;

    try {
      if (HEYGEN_SIM_MODE) {
        const simPath = await buildSimClip(scene, i);
        const fakeVideoId = `sim_${jobId}_${String(i).padStart(2, '0')}`;
        console.log(`[heygen-sim] ✅ Scene ${i + 1}/${scenes.length} (${scene.name}) → ${simPath}`);
        videoJobs.push({
          sceneName: scene.name,
          sceneIndex: i,
          video_id: fakeVideoId,
          status: 'completed',
          video_url: simPath,
          textLength: scene.text.length,
          simulated: true
        });
        continue;
      }
      console.log(`[heygen] Submitting scene ${i + 1}/${scenes.length}: ${scene.name}... (${scene.text.length} chars, avatar: ${avatarId.slice(0,8)}, engine: ${HEYGEN_ENGINE})`);
      const { videoId: video_id, status, videoUrl: directUrl } = await avatar.submitSegment({
        text: sceneScript,
        title: sharedTitle,
        aspectRatio: format === 'portrait' ? '9:16' : '16:9',
        config: { ...avatarCfg, avatarId, voiceId: HEYGEN_VOICE_ID_RESOLVED, reactionPauseSec, sceneHoldPauseSec },
        sceneName: scene.name,
        // eleven_v3 interprets [bracket] audio tags as delivery direction (verified: not spoken aloud)
        enhancedDelivery: !!enhancedTexts[i]
      }, { engine: avatarEngine });

      let video_url = directUrl || null;
      if (status === 'completed' && !video_url) {
        const st = await avatar.getSegmentStatus(video_id, { engine: avatarEngine });
        video_url = st.videoUrl;
      }

      console.log(`[heygen] ✅ Scene ${i + 1}/${scenes.length} (${scene.name}): video_id=${video_id}, status=${status}`);

      videoJobs.push({
        sceneName: scene.name,
        sceneIndex: i,
        video_id,
        status,
        video_url,
        textLength: scene.text.length
      });

      if (onSceneComplete) {
        try {
          await onSceneComplete({ videoJobs: [...videoJobs], sceneName: scene.name, sceneIndex: i });
        } catch (e) {
          console.warn(`[heygen] onSceneComplete failed (non-fatal): ${e.message}`);
        }
      }

      // Add 2-second delay between requests to avoid rate limiting
      if (i < scenes.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

    } catch(e) {
      const errData = e.response?.data;
      console.error(`[heygen] API Error for scene ${scene.name}:`, e.message, errData || '');
      if (onSceneComplete && videoJobs.length) {
        try {
          await onSceneComplete({ videoJobs: [...videoJobs], failedScene: scene.name, partial: true });
        } catch (saveErr) {
          console.warn(`[heygen] partial checkpoint save failed: ${saveErr.message}`);
        }
      }
      const partial = new Error(
        `Avatar render failed for scene ${scene.name}: ${e.message}${errData ? ` - ${JSON.stringify(errData)}` : ''}` +
        (videoJobs.length ? ` (${videoJobs.length} scene(s) completed — resume to continue)` : '')
      );
      partial.videoJobs = videoJobs;
      partial.failedScene = scene.name;
      throw partial;
    }
  }

  if (HEYGEN_SIM_MODE) {
    console.log(`[heygen-sim] ✅ Generated ${videoJobs.length} synthetic scene clips (no HeyGen API calls)`);
  } else {
    console.log(`[heygen] ✅ All ${scenes.length} scenes submitted successfully`);
    console.log(`[heygen] Video IDs: ${videoJobs.map(j => j.video_id).join(', ')}`);
  }

  // Store script text with scene mapping for Gate 2 re-rendering
  const sceneTextMap = {};
  scenes.forEach((scene, idx) => {
    sceneTextMap[scene.name] = {
      text: scene.text,  // original Gate-1-approved text — captions/QA/re-renders use this
      ...(enhancedTexts[idx] ? { enhancedText: enhancedTexts[idx] } : {}),
      index: idx,
      videoId: videoJobs[idx]?.video_id
    };
  });

  return {
    videoJobs,  // Array of {sceneName, sceneIndex, video_id, status, textLength}
    avatarId,
    voiceId: avatarCfg.voiceId,
    speakSpeed: HEYGEN_SPEAK_SPEED,
    engine: HEYGEN_ENGINE,
    sceneCount: scenes.length,
    scenes: scenes.map(s => s.name),
    sceneTextMap,  // Full script text mapped by scene name for Gate 2 re-rendering
    fullScript: script,  // Complete original script for reference
    simulated: HEYGEN_SIM_MODE
  };
  } finally { /* HeyGen only — no pod teardown */ }
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
  // Product lock: reject AJ feature pages for episode clips.
  // These are often explainer/editorial pages that mismatch requested hard-news footage.
  if (/aljazeera\.[^/]+\/features\//i.test(String(articleUrl))) {
    console.log(`[news-scrape-video] ⏭  Skipping feature page: ${articleUrl.slice(0, 90)}`);
    return null;
  }
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

    nba: (() => {
      const awayAbbr = metadata.away || '?';
      const homeAbbr = metadata.home || '?';
      const scoreStr = `${metadata.awayScore||'?'}-${metadata.homeScore||'?'}`;
      const pc = metadata.playerContext || {};
      const rosterLines = Object.entries(pc)
        .map(([team, names]) => `  ${team}: ${names.join(', ')}`)
        .join('\n');
      const rosterSection = rosterLines
        ? `\n⚠️ CONFIRMED PLAYERS IN THIS GAME (ESPN boxscore — current rosters only):\n${rosterLines}\nCRITICAL: Only use names from this list. Your training-data roster knowledge is outdated — trades happen constantly. If a name is not above, DO NOT use it.`
        : `\n⚠️ PLAYER NAMES: Only name a player when their name appears as text on screen (graphic/lower-third) or is unmistakably called by the announcer. DO NOT infer identities from jersey numbers or team associations — rosters change and your training data may be outdated.`;
      const clipTitle = metadata.clipHeadline ? `\nClip title: "${metadata.clipHeadline}" — use this to confirm which team dominated.` : '';
      const scoreClarified = (metadata.awayScore && metadata.homeScore)
        ? `${awayAbbr} scored ${metadata.awayScore}, ${homeAbbr} scored ${metadata.homeScore} (${Number(metadata.awayScore) > Number(metadata.homeScore) ? awayAbbr : homeAbbr} won)`
        : scoreStr;
      return `This is an NBA game highlight: ${awayAbbr} (away) vs ${homeAbbr} (home). Score: ${scoreClarified}.${clipTitle}${rosterSection}

Analyze the FULL video with audio and map every significant moment to its exact timestamp.

Return output as a two-column timeline table using this exact header:
Timestamp | Narration

Rules:
1. Every row MUST be a timestamp range (start-end). Cover the ENTIRE clip with no gaps — rows must be contiguous from 0:00 to the end. Example: 0:00-0:03, 0:03-0:07, 0:07-0:12, etc.
2. Aim for one row every 3-5 seconds of video. Do NOT lump the whole clip into one row.
3. Each row describes ONLY what is visually happening in that specific time window. Use player names ONLY from the confirmed list above (or visible on-screen graphics). If you cannot confirm a name, describe by team and jersey number or position instead.
4. Describe on-court action only — do NOT quote the announcer or include phrases like "Announcer says" or "Announcer:" anywhere in the table. Use the audio only to help identify which player is acting.
5. Keep each narration cell concise (10-15 words max). No hype language. No speculation.
6. End the table, then add one line: "Key takeaway: [one sentence]"`;
    })(),

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
  const mp4Url = videoUrl || (contentType === 'twitch' ? twitchClient.thumbnailToMp4(thumbnailUrl) : '');

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
    let sourceCfg = null;
    let sourceModule = null;
    let sourceGate0FailData = null;
    const baseItemsSnapshot = JSON.parse(JSON.stringify(Array.isArray(items) ? items : []));

    try {
      const { getContentTypeConfig } = require('./configLoader');
      sourceCfg = getContentTypeConfig(type);
      if (sourceCfg && sourceCfg.source && sourceCfg.source.module) {
        sourceModule = require(path.join(__dirname, sourceCfg.source.module));
        const sourceResult = await sourceModule.fetchData({
          items,
          type,
          jobId,
          ajVideoPool,
          geminiAnalyzeClip,
          scrapeArticleOgImage,
          scrapeArticleVideo,
          prioritizeNewsStories,
          matchStoryToAjVideo,
          // CPD-997: top10 sends 1 clip per streamer — twitch_source relaxes its 2-clip floor
          scriptVariant: String(req.body.scriptVariant || '').toLowerCase() || null
        }, sourceCfg);

        // News Gate 0 failure — source module can't issue the HTTP response directly
        // because it doesn't have access to `res`. Handle it here.
        if (sourceResult.gate0Fail && sourceResult.gate0Data) {
          const { errorMsg, expectedClipCount, actualClipCount, missingStories } = sourceResult.gate0Data;
          console.error(`[news-clip-gate] ${errorMsg}`);
          sourceGate0FailData = {
            errorMsg,
            expectedClipCount,
            actualClipCount,
            missingStories
          };
        }

        analyses            = sourceResult.analyses;
        orderedClipUrls     = sourceResult.orderedClipUrls;
        clipReportDataForQA = sourceResult.clipReportDataForQA;
        console.log(`[generate-full-script] ✅ Source module loaded: ${sourceCfg.source.module}`);
      }
    } catch (sourceModuleErr) {
      throw new Error(`Source module failed for ${type}: ${sourceModuleErr.message}`);
    }

    // ── Gate Worker System: Gate 0 + Scaffold ────────────────────────────────
    // Build a minimal jobSpec from resolved items for the gate worker system.
    // req.jobSpec is set by server.js createJobSpec() at request time and carries
    // pre-resolved voice, scaffold, and chrome data. req.body.jobSpec is a fallback
    // for callers that embed the spec directly in the body. Falls back to inline minimal.
    // Deep-clone so mutations (jobId reassign, sceneStructure overwrite) don't bleed back
    // into req.jobSpec which the server.js pre-generate gate sign-off already consumed.
    const gwJobSpec = (req.jobSpec ? JSON.parse(JSON.stringify(req.jobSpec)) : null) || req.body.jobSpec || {
      jobId,
      customerId: 'c0',
      templateId: (type && type.includes('-short')) ? 'short-form' : 'long-form',
      contentType: type || 'news',
      order: {
        contentType: type || 'news',
        formType: (type && type.includes('-short')) ? 'short' : 'long',
        inputs: { items: [] },
        output: {
          format: (type && type.includes('-short')) ? '9:16' : '16:9'
        }
      },
      state: { gateResults: {}, savedOutputs: {} },
      designSpec: { chrome: {}, audio: {}, resolution: {}, ffmpeg: {} },
      deliverySpec: { platforms: [] },
      commitments: {}
    };
    const semanticJobId = req?.jobSpec?.jobId || req?.jobSpecId || req?.body?.jobSpecId || null;
    const PERSISTENCE_STRICT = process.env.SCAFFOLD_PERSISTENCE_STRICT !== '0';

    /**
     * Persist scaffold/script/transcript artifacts to both script_* and semantic c0_* rows
     * and verify they are queryable immediately. In strict mode, throws on missing writes.
     */
    async function persistAndVerifyArtifacts(artifacts = {}) {
      const { saveOutput: saveOut, getJobSpec: getSpec } = require('./job_spec');
      const targetIds = [...new Set([jobId, semanticJobId].filter(Boolean))];
      const checks = [];

      for (const targetId of targetIds) {
        if (artifacts.scaffold) {
          await saveOut(targetId, 'scaffold', artifacts.scaffold);
          checks.push({ targetId, key: 'scaffold' });
        }
        if (typeof artifacts.filledScript === 'string' && artifacts.filledScript.trim()) {
          await saveOut(targetId, 'filledScript', artifacts.filledScript);
          checks.push({ targetId, key: 'filledScript' });
        }
        if (Array.isArray(artifacts.transcriptBlocks) && artifacts.transcriptBlocks.length) {
          await saveOut(targetId, 'transcriptBlocks', artifacts.transcriptBlocks);
          checks.push({ targetId, key: 'transcriptBlocks' });
        }
      }

      const failures = [];
      for (const chk of checks) {
        const spec = getSpec(chk.targetId);
        const val = spec?.state?.savedOutputs?.[chk.key];
        const ok = chk.key === 'filledScript'
          ? (typeof val === 'string' && val.trim().length > 0)
          : chk.key === 'transcriptBlocks'
            ? (Array.isArray(val) && val.length > 0)
            : !!val;
        if (!ok) failures.push(`${chk.targetId}:${chk.key}`);
      }

      if (failures.length) {
        const msg = `[artifact-persist] Missing persisted artifacts: ${failures.join(', ')}`;
        if (PERSISTENCE_STRICT) throw new Error(msg);
        console.warn(msg);
      }
    }

    const resetItemsToRequestSnapshot = () => {
      if (!Array.isArray(items)) return;
      items.splice(0, items.length, ...JSON.parse(JSON.stringify(baseItemsSnapshot)));
    };

    const syncGate0InputsFromItems = () => {
      if (!Array.isArray(items) || items.length === 0) return;
      gwJobSpec.order = gwJobSpec.order || {};
      gwJobSpec.order.inputs = gwJobSpec.order.inputs || {};
      gwJobSpec.order.inputs.items = items.map((item, i) => {
        const isReddit = !!(item.postId || item.redditPostId || item.redditSource || item.source === 'reddit');
        return {
          id:              String(i),
          name:            item.displayName || item.streamer || item.name || `ITEM${i + 1}`,
          displayName:     item.displayName || item.name || item.streamer || `Item ${i + 1}`,
          title:           item.title || item.displayName || item.name || String(i),
          teams:           item.away && item.home ? `${item.away}_VS_${item.home}` : (item.title || ''),
          url:             item.videoUrl || item.clipUrl || orderedClipUrls.find(c => (c.streamer||'').toLowerCase() === (item.streamer||item.displayName||'').toLowerCase())?.url || item.clips?.[0]?.videoUrl || item.url || '',
          pageUrl:         item.link || item.pageUrl || (String(item.url||'').includes('aljazeera.com') ? item.url : '') || '',
          postId:          item.postId || item.redditPostId || null,
          redditSource:    isReddit,
          subreddit:       item.subreddit || null,
          redditPermalink: item.redditPermalink || item.permalink || null,
          source:          item.source || null,
          handle:          item.username || item.streamer || item.twitchUsername || '',
          twitchUsername:  item.username || item.streamer || item.twitchUsername || '',
          imageUrl:        item.imageUrl || item.thumbnailUrl || item.profileImage || '',
          fact:            item.fact || item.origin || item.description || item.desc || '',
          category:        item.category || (type || '').toUpperCase()
        };
      });
      gwJobSpec.order.inputs.itemCount = gwJobSpec.order.inputs.items.length;
    };

    // ── Inject items into jobSpec.order.inputs.items ──────────────────────────
    // req.body.items is the authoritative source — always write unconditionally.
    // script_gen receives items via the request body — write them into gwJobSpec now so
    // scaffold pre-generation (if run later) and all gates see the real items.
    syncGate0InputsFromItems();

    // SQLite spine for script_* — saveOutput / persistAndVerifyArtifacts require a jobs row + backfillable job_spec.
    // seedJobSpecFromScript only runs when a row exists and job_spec is empty (see lib/db.js).
    gwJobSpec.jobId = jobId;
    if (semanticJobId) gwJobSpec.semanticJobId = semanticJobId;

    const { validateForScriptPipeline } = require('./job_spec_preflight');
    const preflight = validateForScriptPipeline(gwJobSpec);
    if (!preflight.ok) {
      console.error(`[generate-full-script] Job spec preflight failed: ${preflight.errors.join('; ')}`);
      return res.status(400).json({
        error: 'Job spec preflight failed — required fields missing for production line',
        errors: preflight.errors,
        jobId
      });
    }

    try {
      const db = require('./db');
      db.saveJob(jobId, {
        jobId,
        contentType: type || 'news',
        formType: type && String(type).includes('-short') ? 'short' : 'long',
        status: 'pending',
        stage: 'fetch',
        createdAt: new Date().toISOString()
      });
      const spineSpec = {
        ...gwJobSpec,
        jobId,
        scriptJobId: jobId,
        state: {
          gateResults: { ...(gwJobSpec.state && gwJobSpec.state.gateResults) },
          savedOutputs: { ...(gwJobSpec.state && gwJobSpec.state.savedOutputs) }
        }
      };
      db.seedJobSpecFromScript(jobId, spineSpec);
    } catch (spineErr) {
      console.warn(`[generate-full-script] script job DB spine (non-fatal): ${spineErr.message}`);
    }

    // Gate 0 — source confirmation (BLOCKING: hard fail stops pipeline before HeyGen)
    let gwGate0Result = null;
    try {
      const gate0 = require('./gates/gate0');
      const { saveGateResult: gwSaveGateResult, saveOutput: gwSaveOutput } = require('./job_spec');
      const runGate0Attempt = async ({ phase }) => {
        try {
          const needsSourceRefetch = phase !== 'worker_attempt';
          if (needsSourceRefetch && sourceModule && sourceCfg) {
            resetItemsToRequestSnapshot();
            const gate0Strategy = {
              phase,
              passType: phase.startsWith('sendback_')
                ? 'sendback'
                : phase.startsWith('intervention_')
                  ? 'intervention'
                  : 'attempt',
              passNumber: Number((phase.split('_')[1] || '0')) || 0,
              contentType: type
            };
            const sourceResult = await sourceModule.fetchData({
              items,
              type,
              jobId,
              ajVideoPool,
              geminiAnalyzeClip,
              scrapeArticleOgImage,
              scrapeArticleVideo,
              prioritizeNewsStories,
              matchStoryToAjVideo,
              scriptVariant: String(req.body.scriptVariant || '').toLowerCase() || null
            }, { ...(sourceCfg || {}), gate0Strategy });
            analyses = sourceResult.analyses;
            orderedClipUrls = sourceResult.orderedClipUrls;
            clipReportDataForQA = sourceResult.clipReportDataForQA;
            sourceGate0FailData = sourceResult.gate0Fail && sourceResult.gate0Data
              ? {
                  errorMsg: sourceResult.gate0Data.errorMsg,
                  expectedClipCount: sourceResult.gate0Data.expectedClipCount,
                  actualClipCount: sourceResult.gate0Data.actualClipCount,
                  missingStories: sourceResult.gate0Data.missingStories
                }
              : null;
          }

          syncGate0InputsFromItems();

          let attemptResult;
          if (sourceGate0FailData) {
            attemptResult = {
              gate: 0,
              jobId,
              passed: false,
              outcome: 'hard_fail',
              confirmedFormat: null,
              confirmedSources: [],
              failReason: sourceGate0FailData.errorMsg,
              upstreamContext: { reviewedReports: [], confirmedClean: [], escalatedConcerns: [sourceGate0FailData.errorMsg], downstreamHeadsUp: null },
              completedAt: new Date().toISOString()
            };
          } else {
            const g0Readiness = gate0.canProduce(gwJobSpec);
            if (!g0Readiness.ready) {
              attemptResult = {
                gate: 0,
                jobId,
                passed: false,
                outcome: 'not_ready',
                confirmedFormat: null,
                confirmedSources: [],
                failReason: `Gate 0 not ready: ${g0Readiness.reasons.join('; ')}`,
                upstreamContext: { reviewedReports: [], confirmedClean: [], escalatedConcerns: g0Readiness.reasons, downstreamHeadsUp: null },
                completedAt: new Date().toISOString()
              };
            } else {
              attemptResult = await gate0.run(gwJobSpec);
            }
          }

          try { await gwSaveGateResult(jobId, 'gate0', attemptResult); } catch(e) {}
          return attemptResult;
        } catch (attemptErr) {
          return {
            gate: 0,
            jobId,
            passed: false,
            outcome: 'error',
            confirmedFormat: null,
            confirmedSources: [],
            failReason: `Gate 0 attempt error: ${attemptErr.message}`,
            upstreamContext: { reviewedReports: [], confirmedClean: [], escalatedConcerns: [attemptErr.message], downstreamHeadsUp: null },
            completedAt: new Date().toISOString()
          };
        }
      };

      const gate0PolicyRun = await runUnifiedGatePolicy({
        gateKey: 'gate0',
        jobId,
        runWorkerAttempt: runGate0Attempt,
        runInterventionAttempt: async ({ interventionAttempt }) => `gate0 intervention pass ${interventionAttempt}`,
        isPass: (result) => !!result?.passed,
        persistStatus: async (policy) => {
          const targetIds = [...new Set([jobId, semanticJobId].filter(Boolean))];
          for (const targetId of targetIds) {
            try { await gwSaveOutput(targetId, 'gate0_policy', policy); } catch (_e) {}
          }
        },
        onRetryAttempt: async ({ phase, attempt, maxAttempts }) => {
          try {
            pipelineBus.emit('pipeline:retry_attempt', {
              jobId,
              gate: 'gate0',
              stage: `gate0_${phase}`,
              attempt,
              maxAttempts
            });
          } catch (_e) { /* non-fatal */ }
        }
      });
      gwGate0Result = gate0PolicyRun.result;

      try {
        auditAndRecordGateResult({
          jobId,
          gate: 'gate0',
          result: { ...gwGate0Result, gate: 'gate0' },
          fallbackJobSpec: gwJobSpec
        });
      } catch (specAuditErr) {
        console.warn(`[gate-contracts] gate0 audit failed (non-fatal): ${specAuditErr.message}`);
      }
      console.log(`[gate-worker] Gate 0: ${gwGate0Result.passed ? 'PASS' : 'HARD FAIL'} — confirmedFormat=${gwGate0Result.confirmedFormat}`);
      if (gwGate0Result.confirmedFormat) {
        gwJobSpec.order = gwJobSpec.order || {};
        gwJobSpec.order.confirmedSourceFormat = gwGate0Result.confirmedFormat;
      }
      if (!gwGate0Result.passed) {
        const reason = gwGate0Result.failReason || 'No confirmed source clip';
        console.error(`[gate-worker] Gate 0 HARD FAIL — pipeline stopped: ${reason}`);
        return res.status(422).json({ error: `Gate 0 failed: ${reason}`, gate: 'gate0', outcome: 'hard_fail' });
      }
    } catch (gwG0Err) {
      console.error(`[gate-worker] Gate 0 error — pipeline stopped: ${gwG0Err.message}`);
      return res.status(500).json({ error: `Gate 0 error: ${gwG0Err.message}`, gate: 'gate0', outcome: 'error' });
    }

    // Gate-to-gate handoff review: Gate 0 output must be valid for Gate 1 execution.
    try {
      const { saveOutput: saveHandoff } = require('./job_spec');
      const gate0ToGate1Preflight = preflightGateExecution({
        jobId,
        gate: 'gate1',
        fallbackJobSpec: {
          ...gwJobSpec,
          state: {
            ...(gwJobSpec.state || {}),
            gateResults: {
              ...(gwJobSpec.state?.gateResults || {}),
              gate0: gwGate0Result || { passed: true, outcome: 'pass' }
            }
          }
        }
      });
      const handoffReview = {
        gate: 'gate0',
        nextGate: 'gate1',
        reviewedAt: new Date().toISOString(),
        passed: !!gate0ToGate1Preflight.ready,
        issues: gate0ToGate1Preflight.reasons || [],
        softHeals: gate0ToGate1Preflight.softHeals || []
      };
      for (const targetId of [...new Set([jobId, semanticJobId].filter(Boolean))]) {
        try { await saveHandoff(targetId, 'gate0_handoff_review', handoffReview); } catch (_e) {}
      }
      if (!gate0ToGate1Preflight.ready) {
        return res.status(422).json({
          error: `Gate 0→1 handoff not ready: ${(gate0ToGate1Preflight.reasons || []).join('; ')}`,
          gate: 'gate0',
          outcome: 'handoff_blocked'
        });
      }
    } catch (handoffErr) {
      console.warn(`[gate-worker] Gate 0→1 handoff review warning: ${handoffErr.message}`);
    }

    // Scaffold generation — use pre-generated scaffold from jobSpec if available,
    // unless NBA long-form has Gemini timestamp rows (then rebuild so *_CLIP scenes embed the map).
    let gwScaffoldResult = null;
    try {
      const { generateScaffold } = require('./scaffold');
      const { saveOutput: gwSaveOutput } = require('./job_spec');

      const nbaClipTiming =
        type === 'nba' && Array.isArray(orderedClipUrls) && orderedClipUrls.length === items.length
          ? orderedClipUrls.map((u) => ({
              clipTimingTargets: u.clipTimingTargets || [],
              clipTimingFormat: u.clipTimingFormat || 'none'
            }))
          : undefined;
      const hasNbaTimingRows = !!(nbaClipTiming && nbaClipTiming.some((r) => (r.clipTimingTargets || []).length > 0));

      const scaffoldJobSpecBase = {
        ...gwJobSpec,
        ...(nbaClipTiming ? { nbaClipTiming } : {}),
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

      // Guard: if the pre-generated scaffold assumed a different clipsPerStreamer than the
      // post-analysis clip count, regenerate so the scaffold Gemini receives matches actual
      // data. Mismatch happens when the request was submitted with N clips/streamer but
      // twitch_source resolves/curates to a different count (expired clips, GQL failures, etc.).
      const preGenClipCount  = gwJobSpec?.designSpec?.sceneStructure?.expectedClipCount || 0;
      const actualClipsPerStreamer = (items.length > 0 && items[0]?.clips?.length > 0)
        ? items[0].clips.length
        : (req.body?.clipsPerStreamer || 2);
      const preGenClipsPerStreamer = items.length > 0 ? Math.round(preGenClipCount / items.length) : 0;
      const scaffoldClipMismatch   = preGenClipsPerStreamer > 0
        && preGenClipsPerStreamer !== actualClipsPerStreamer;

      if (gwJobSpec?.designSpec?.sceneStructure?.scaffold && !hasNbaTimingRows && !scaffoldClipMismatch) {
        gwScaffoldResult = {
          scaffold:           gwJobSpec.designSpec.sceneStructure.scaffold,
          sceneHeaders:       gwJobSpec.designSpec.sceneStructure.sceneHeaders,
          expectedSceneCount: gwJobSpec.designSpec.sceneStructure.expectedSceneCount,
          expectedClipCount:  gwJobSpec.designSpec.sceneStructure.expectedClipCount,
          templateId:         gwJobSpec.designSpec.sceneStructure.templateId || gwJobSpec.templateId
        };
        console.log(`[gate-worker] Using pre-generated scaffold from jobSpec (${gwScaffoldResult.expectedSceneCount} scenes, ${gwScaffoldResult.expectedClipCount} clips) — skipping re-generation`);
      } else {
        if (scaffoldClipMismatch) {
          console.warn(`[gate-worker] Scaffold clip mismatch: pre-gen assumed ${preGenClipsPerStreamer} clips/streamer but analysis resolved ${actualClipsPerStreamer} — regenerating scaffold to match`);
          // Rebuild scaffoldJobSpecBase with actual clipsPerStreamer so generateScaffold
          // produces the correct number of scenes.
          scaffoldJobSpecBase.order = {
            ...scaffoldJobSpecBase.order,
            inputs: { ...scaffoldJobSpecBase.order.inputs, clipsPerStreamer: actualClipsPerStreamer }
          };
        }
        gwScaffoldResult = generateScaffold(scaffoldJobSpecBase);
        console.log(
          hasNbaTimingRows
            ? `[gate-worker] Generated NBA scaffold with locked Timestamp | Narration maps in each *_CLIP scene (${gwScaffoldResult.expectedSceneCount} scenes)`
            : scaffoldClipMismatch
              ? `[gate-worker] Regenerated scaffold after clip count correction (${gwScaffoldResult.expectedSceneCount} scenes, ${actualClipsPerStreamer} clips/streamer)`
              : `[gate-worker] Generated scaffold at script-gen time (fallback — no pre-generated scaffold in jobSpec)`
        );
      }

      // Write scaffold results back to job spec as authoritative source of truth
      // All downstream gates read sceneHeaders + expectedClipCount from designSpec
      if (gwJobSpec && gwScaffoldResult) {
        gwJobSpec.designSpec = gwJobSpec.designSpec || {};
        // Build items[] — maps ITEM1/STORY1/GAME1 scene IDs to customer data
        // Used by assembly chrome burn to get sidebar card data without contentType branching
        const structureItems = items.map((item, i) => {
          const nbaMatchup = (item.away && item.home) ? `${item.away} vs ${item.home}` : null;
          return {
            sceneId:     `ITEM${i + 1}`,
            label:       item.displayName || item.streamer || item.name || item.title || nbaMatchup || `Item ${i + 1}`,
            category:    item.category || (nbaMatchup ? 'NBA GAME' : null) || gwJobSpec.designSpec?.chrome?.activeCategory || gwJobSpec.contentType?.toUpperCase() || 'ITEM',
            data: {
              displayName:  item.displayName || item.name || item.title || nbaMatchup || `Item ${i + 1}`,
              url:          item.url || item.pageUrl || item.videoUrl || item.clipUrl || '',
              fact:         item.fact || item.origin || item.description || '',
              imageUrl:     item.imageUrl || item.thumbnailUrl || item.profileImage || '',
              matchup:      nbaMatchup || item.teams || item.title || '',
              twitchUsername: item.username || item.streamer || item.twitchUsername || '',
              away:         item.away || '', home: item.home || '',
              awayAbbr:     item.awayAbbr || '', homeAbbr: item.homeAbbr || '',
              awayScore:    item.awayScore || null, homeScore: item.homeScore || null
            }
          };
        });

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

      try {
        await persistAndVerifyArtifacts({ scaffold: gwScaffoldResult });
      } catch (e) {
        console.error(`[artifact-persist] scaffold persistence failed: ${e.message}`);
        throw e;
      }
      console.log(`[gate-worker] Scaffold: ${gwScaffoldResult.expectedSceneCount} scenes, ${gwScaffoldResult.expectedClipCount} clips — job spec updated as authoritative source`);

      // Write voice + chrome creative config fields to jobSpec.designSpec so all downstream
      // gates read from job spec (single source of truth chain: c0.json → jobSpec → gates).
      // Skip if voice was already resolved at createJobSpec() time (pre-generate fix).
      const voiceAlreadyResolved = !!(gwJobSpec?.designSpec?.voice?.lockedOutro || gwJobSpec?.designSpec?.voice?.showName);
      if (voiceAlreadyResolved) {
        console.log(`[gate-worker] designSpec.voice already resolved at job creation — skipping re-resolution (showName: ${gwJobSpec.designSpec.voice.showName})`);
      } else {
      try {
        const { loadCustomerConfig } = require('./customerConfig');
        const custConfig = loadCustomerConfig(gwJobSpec.customerId || 'c0', 'long-form');
        const isShortType = type && type.includes('-short');
        const shortCustConfig = isShortType ? loadCustomerConfig(gwJobSpec.customerId || 'c0', 'short-form') : null;
        const activeCustConfig = isShortType ? shortCustConfig : custConfig;
        // Map content type to voice key: 'twitch'/'nba-short'/etc. → 'clips'/'sports'/'news'
        let voiceBaseType = (type || 'news').replace(/-short$/, '');
        if (['twitch', 'clips', 'streamer'].some(t => voiceBaseType.includes(t))) voiceBaseType = 'clips';
        if (['nba', 'sports', 'basketball'].some(t => voiceBaseType.includes(t))) voiceBaseType = 'sports';
        if (['news', 'world', 'global'].some(t => voiceBaseType.includes(t))) voiceBaseType = 'news';

        gwJobSpec.designSpec = gwJobSpec.designSpec || {};
        gwJobSpec.designSpec.voice = {
          lockedIntro: activeCustConfig?.designDefaults?.voice?.lockedIntro?.[voiceBaseType] || null,
          lockedOutro: activeCustConfig?.designDefaults?.voice?.lockedOutro || null,
          showName: activeCustConfig?.designDefaults?.voice?.showName?.[voiceBaseType] || null,
          categoryLabel: activeCustConfig?.designDefaults?.voice?.categoryLabel?.[voiceBaseType] || null
        };
        gwJobSpec.designSpec.chrome = gwJobSpec.designSpec.chrome || {};
        gwJobSpec.designSpec.chrome.caption = activeCustConfig?.designDefaults?.chrome?.caption || null;
        gwJobSpec.designSpec.chrome.showName = activeCustConfig?.designDefaults?.voice?.showName?.[voiceBaseType] || null;
        gwJobSpec.designSpec.chrome.categoryLabel = activeCustConfig?.designDefaults?.voice?.categoryLabel?.[voiceBaseType] || null;

        // Persist to DB
        try {
          const { updateJobSpec } = require('./job_spec');
          updateJobSpec(gwJobSpec.jobId, { designSpec: gwJobSpec.designSpec });
        } catch(e) { /* non-fatal */ }
        console.log(`[gate-worker] designSpec.voice + chrome written for ${type} (showName: ${gwJobSpec.designSpec.voice.showName})`);
      } catch (voiceErr) {
        console.warn(`[gate-worker] designSpec.voice write failed (non-fatal): ${voiceErr.message}`);
      }
      } // end if (!voiceAlreadyResolved)
    } catch (gwScaffoldErr) {
      console.warn(`[gate-worker] Scaffold error (non-blocking): ${gwScaffoldErr.message}`);
    }

    // ── Step 2: Build the full Claude prompt ─────────────────────────
    // CPD-997: scriptVariant 'top10' rides the twitch pipeline (same scene
    // machinery, gates, assembly) but swaps the system prompt for the
    // countdown persona and appends rank framing to the user prompt below.
    const scriptVariant = String(req.body.scriptVariant || '').toLowerCase() || null;
    const isTop10 = scriptVariant === 'top10' && type === 'twitch';
    const baseSystemPrompt = (isTop10 && FULL_SCRIPT_SYSTEM.top10)
      || FULL_SCRIPT_SYSTEM[type] || FULL_SCRIPT_SYSTEM.twitch;
    if (isTop10) console.log('[generate-full-script] scriptVariant=top10 — countdown framing active');
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
    let systemPrompt = baseSystemPrompt + refContext;
    if (type.includes('-short')) {
      const { buildYoutubeLanguagePromptBlock } = require('./youtube_language_policy');
      systemPrompt += buildYoutubeLanguagePromptBlock();
    }

    let userPrompt = '';
    if (type === 'nba' || type === 'nba-short') {
      const isShort = type === 'nba-short';
      if (isShort) {
        const g0 = items[0] || {};
        userPrompt = `Write a COMPLETE Other Side of the Pillow NBA Short script for ${dateStr}.

ONE GAME FOCUS:
Game: ${g0.away||'?'} @ ${g0.home||'?'} | Score: ${g0.awayScore||'?'}-${g0.homeScore||'?'} FINAL
Top performer: ${g0.leader||'Unknown'} — ${g0.leaderStat||'stats unavailable'}
${g0.injuries && g0.injuries.length ? 'Out: ' + g0.injuries.join(', ') : ''}
Gemini video analysis: ${analyses[0] || '⚠️ NO VIDEO ANALYSIS — write ONLY from stats/box score above. DO NOT invent specific plays, quotes, or moments not in the data.'}

🎬 REQUIRED STRUCTURE — use these EXACT 3 section headers in this exact order:

=== HOOK ===
type: avatar
spokenText: [1-2 lines max. Under 3 seconds. Immediately state the value, shock, or stakes. Player name + what's about to happen. No preamble, no "hey guys".]

=== CLIP ===
type: source_clip
spokenText:

=== REACTION ===
type: avatar
spokenText: [2-4 lines max. Fast-paced punchy commentary. Sharp emotional reaction or analysis that adds value BEYOND just restating what happened. The take, not the recap.]

CAPTION: [Max 6 words. Title Case. Slightly irreverent.]

⚠️ RULES:
- Use EXACTLY === HOOK ===, === CLIP ===, === REACTION === — no other section headers
- HOOK: 1-2 declarative lines, under 3 seconds (max ~15 words total), state the stakes
- CLIP: type: source_clip, spokenText: (leave empty — video plays here)
- REACTION: 2-4 lines, punchy commentary — emotional analysis, not a recap. Add the take.
- CAPTION: max 6 words, title case
- NO outro, NO sign-off, NO "Goodnight and good luck"
- NO brackets, NO placeholders in final output
Target: 50-80 words spoken total (HOOK + REACTION combined).`;
      } else {
        // Use the scaffold-defined structure as the authoritative contract.
        // This keeps prompt headers aligned with Gate 1 expectations.
        const sceneHeadersFromSpec = (gwJobSpec?.designSpec?.sceneStructure?.sceneHeaders || [])
          .map((h) => String(h || '').trim())
          .filter(Boolean);
        const sceneHeaders = sceneHeadersFromSpec.length
          ? sceneHeadersFromSpec.map((h) => `=== ${h} ===`)
          : ['=== INTRO ===', '=== OUTRO ==='];
        const expectedScenes = sceneHeaders.length;

        userPrompt = `Write the COMPLETE Other Side of the Pillow NBA Compilation script for ${dateStr}.

${items.length} game${items.length > 1 ? 's' : ''} total. ${items.length} [CLIP PLAYS HERE] markers required (one per game, inside each *_CLIP scene).

GAME DATA:
${items.map((g, i) => `
GAME ${i+1}: ${g.away || 'Away'} @ ${g.home || 'Home'}
Score: ${g.awayScore || '?'}-${g.homeScore || '?'} FINAL — ${g.away || 'away team'} scored ${g.awayScore || '?'}, ${g.home || 'home team'} scored ${g.homeScore || '?'}${(g.awayScore && g.homeScore) ? ' — WINNER: ' + (Number(g.awayScore) > Number(g.homeScore) ? (g.away || 'Away') : (g.home || 'Home')) : ''}
${g.clipHeadline ? 'Clip title (ESPN): "' + g.clipHeadline + '" — this tells you who won; write all scenes consistent with this result.' : ''}
${g.leader ? 'Top performer: ' + g.leader + (g.leaderStat ? ' — ' + g.leaderStat : '') : ''}
${g.injuries && g.injuries.length ? 'Out: ' + g.injuries.join(', ') : ''}
${g.awayRec || g.homeRec ? 'Records: ' + g.away + ' ' + (g.awayRec||'') + ' | ' + g.home + ' ' + (g.homeRec||'') : ''}
ESPN highlight clip duration: ${g.clipDuration ? Math.round(g.clipDuration) + 's' : 'unknown'}
CLIP intro word count: 50–80 words (Bobby G speaks BEFORE the clip plays — compact pre-clip callout, NOT overlay narration)
${g.playerContext && Object.keys(g.playerContext).length
  ? '⚠️ TEAM ROSTERS — do NOT mix up which player is on which team:\n' + Object.entries(g.playerContext).map(([t,ns]) => `  ${t} players: ${ns.join(', ')}`).join('\n') + '\nSCRIPT RULE: A player from the ' + Object.keys(g.playerContext)[0] + ' roster is NOT on the ' + (Object.keys(g.playerContext)[1] || '?') + ' team. If you are unsure which team a player in the Gemini analysis belongs to, cross-reference this roster list before naming them.'
  : '⚠️ PLAYER NAMES: Only use player names confirmed by Gemini video analysis — do NOT add names from your training data.'}
Gemini video analysis: ${analyses[i] || '⚠️ NO VIDEO ANALYSIS — write ONLY from box score/game data above. DO NOT invent specific plays, quotes, or moments not in the data.'}
`).join('')}

🎬 SCENE STRUCTURE — ${expectedScenes} SCENES REQUIRED:
Write the FULL SCRIPT using these === SCENE HEADERS === exactly:

${sceneHeaders.join('\n')}

⚠️ FIRST SCENE MUST BE === INTRO === — do NOT start with a GAME scene.
⚠️ EXACTLY ${expectedScenes} SCENES — use the header list exactly as written.
⚠️ COUNT your === HEADER === lines before submitting. Must equal ${expectedScenes}.

📝 WHAT EACH SCENE DOES:

=== INTRO ===
Bobby G on screen. 2-3 sentences. Episode intro, set the tone.

=== GAME#_[TEAMS]_INTRO ===
Bobby G on screen. 50–80 words. Introduce the matchup — teams, stakes, series context, who had momentum going in.
Do NOT describe specific plays — save that for the CLIP scene.
DO NOT pad with generic phrases — every sentence must add real context (series record, key injury, team trend).

=== GAME#_[TEAMS]_CLIP ===
Bobby G on screen. He delivers a COMPACT pre-clip callout — 50–80 words, STUART SCOTT CADENCE.
The clip plays AFTER Bobby G finishes speaking (sequential, not overlay).
Pick the 6–10 most dramatic moments from the Gemini timestamp analysis and call them out in present tense.
DO NOT narrate every row in the locked table — pick the sharpest moments only.
DO NOT pad with filler or generic phrases — if you're under 50 words, add one more specific play.
DO NOT exceed 80 words — if you're over, cut the weakest lines.

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
❌ BAD: "Philadelphia ball handler. Upcourt. Passes." — too vague, name the player and the play
❌ BAD: "P. H." or any abbreviation that Bobby G would never say out loud

Format exactly:
[narration text — Stuart Scott bursts, 50–80 words total, specific player names from Gemini analysis only]
[beat]
[CLIP PLAYS HERE]
[beat]

=== GAME#_[TEAMS]_NARRATION ===
Bobby G back on screen. 50–70 words. Factual post-game breakdown — final score (use digits: "114 to 98", not "one hundred fourteen"), key stat lines from the top performers, series status if applicable (e.g. "Knicks lead the series 4-0").
State facts only. No opinion. Bobby G delivers the scoreboard, not the analysis.
DO NOT spell out numbers — "thirty-two points" is wrong. "32 points" is correct.

=== GAME#_[TEAMS]_OUTRO ===
Bobby G on screen. EXACTLY 1 sentence. Flat deadpan Bobby G take on the game.
Do NOT recap. Just the observation. More alarming, not less.

=== OUTRO ===
1-2 sentences. Sign-off. Must end with "Appreciate you."

✅ VALIDATION:
- Total scenes: EXACTLY ${expectedScenes}
- Total [CLIP PLAYS HERE]: EXACTLY ${items.length} (one per *_CLIP scene)
- Each *_CLIP scene: present-tense, specific to Gemini analysis, correct word count, has [beat][CLIP PLAYS HERE][beat]
- Each *_NARRATION scene: 1-2 sentences, factual only, no opinion
- Each *_OUTRO scene: exactly 1 sentence, deadpan, no recap
- OUTRO ends with "Appreciate you"
- NEVER invent plays not in Gemini's video analysis`;
      }


    } else if (type === 'news' || type === 'news-short') {
      const isShort = type === 'news-short';
      if (isShort) {
        const s0 = items[0] || {};
        const isRedditDesk = !!(s0.postId || s0.redditPostId || s0.redditSource || s0.source === 'reddit');
        const threadCtx = s0.scriptContext || [
          s0.selftext ? `OP: ${s0.selftext}` : '',
          (s0.topComments || []).slice(0, 20).map((c) => `[${c.score}] u/${c.author}: ${(c.body || '').slice(0, 200)}`).join('\n'),
        ].filter(Boolean).join('\n\n');

        if (isRedditDesk) {
          userPrompt = `Write a COMPLETE Because the Light Was On SHORT — Reddit Desk (THE THREAD) for ${dateStr}.

SUBREDDIT: r/${s0.subreddit || 'unknown'}
Title: ${s0.title || 'Unknown'}
Permalink: ${s0.redditPermalink || s0.link || ''}
Score: ${s0.score || '?'} | Comments: ${s0.numComments || '?'}

THREAD CONTEXT (OP + top comments — fuel for HOOK and REACTION):
${threadCtx || 'No OP/comments — use title only.'}

Gemini video analysis: ${analyses[0] || 'Write from thread context only — do not invent visuals.'}

🎬 REQUIRED STRUCTURE — use these EXACT 3 section headers:

=== HOOK ===
type: avatar
spokenText: [Under 15 words. State the Reddit post premise — deadpan BTL, not Twitch Soup.]

=== CLIP ===
type: source_clip
spokenText:

=== REACTION ===
type: avatar
spokenText: [2-4 lines. Weave ONE top-comment angle + flat Bobby G take. NOT a pixel recap.]

CAPTION: [Max 6 words. Title Case. Deadpan chyron slightly wrong.]

Target: 50-80 words spoken (HOOK + REACTION).`;
        } else {
        userPrompt = `Write a COMPLETE Because the Light Was On Short script for ${dateStr}.

ONE STORY FOCUS:
Headline: ${s0.title || 'Unknown'}
Source: ${s0.source || 'Al Jazeera'}
Article text: ${s0.desc || 'No description available'}
Gemini analysis: ${analyses[0] || '⚠️ NO VIDEO ANALYSIS — write ONLY from article title/text above. DO NOT invent specific events, quotes, or details not in the article text.'}

🎬 REQUIRED STRUCTURE — use these EXACT 3 section headers in this exact order:

=== HOOK ===
type: avatar
spokenText: [1-2 lines max. Under 3 seconds. State the value or shock immediately. What IS this story in the fewest words. No setup, no "breaking news", no "hey guys".]

=== CLIP ===
type: source_clip
spokenText:

=== REACTION ===
type: avatar
spokenText: [2-4 lines max. Fast-paced punchy commentary. The absurd implication, the unspoken consequence, or the sharp take. Add value beyond restating the headline. Norm MacDonald meets a street corner shouter.]

CAPTION: [Max 6 words. Title Case. Slightly wrong — not AP wire copy.]

⚠️ RULES:
- Use EXACTLY === HOOK ===, === CLIP ===, === REACTION === — no other section headers
- HOOK: 1-2 lines, under 3 seconds (~15 words max total), state the fact immediately
- CLIP: type: source_clip, spokenText: (leave empty — video plays here)
- REACTION: 2-4 lines, punchy and fast — the take, the implication, not the recap
- CAPTION: max 6 words, title case, subtly absurd
- NO outro, NO sign-off, NO "Subscribe"
- NO brackets, NO placeholders in final output
Target: 50-80 words spoken total (HOOK + REACTION combined).`;
        }
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
        const phonetic0 = getPhonetic(c0.streamer);
        userPrompt = `Write a COMPLETE ClipzWorld News Twitch Short script for ${dateStr}.

ONE STREAMER / ONE CLIP:
ON-AIR NAME (use ONLY this name — never use the Twitch username): ${getDisplayName(c0.streamer||'')||c0.streamer||'Unknown'}
Twitch username (do NOT say this on air): ${c0.streamer||'Unknown'}
${phonetic0 ? `PRONUNCIATION: write the name as "${phonetic0}" in spoken text so the avatar pronounces it correctly` : ''}
${c0.notes ? 'Notes: ' + c0.notes : ''}
Clip title: "${clip0.title||'N/A'}" | ${clip0.views ? clip0.views.toLocaleString() + ' views' : ''} | ${clip0.game||''}
Gemini video analysis: ${anal0 || '⚠️ NO VIDEO ANALYSIS — write ONLY from clip title/game/category above. DO NOT invent specific quotes, plays, or moments not provided.'}

🎬 REQUIRED STRUCTURE — use these EXACT 3 section headers in this exact order:

=== HOOK ===
type: avatar
spokenText: [1-2 lines max. Under 3 seconds. State who this is and the shock/value immediately. Why should the viewer stop scrolling right now. No preamble.]

=== CLIP ===
type: source_clip
spokenText:

=== REACTION ===
type: avatar
spokenText: [2-4 lines max. Fast-paced punchy commentary. Sharp emotional take or internet-voice analysis. Add value — the observation a viewer who paused would make. Not just what happened.]

CAPTION: [Max 4 words. All caps. Internet speak. Emoji ok.]

⚠️ RULES:
- Use EXACTLY === HOOK ===, === CLIP ===, === REACTION === — no other section headers
- HOOK: 1-2 lines, under 3 seconds (~15 words max total), state who and why immediately
- The HOOK MUST say the streamer's ON-AIR NAME. NEVER "this streamer", "a Twitch streamer", or "this Twitch streamer" — the name is the hook.
- CLIP: type: source_clip, spokenText: (leave empty — video plays here)
- REACTION: 2-4 lines, punchy — the hot take, the meme reaction, the unfiltered observation
- CAPTION: max 4 words, all caps, internet speak (emoji ok)
- Use the ON-AIR NAME only — never the Twitch username on air
- NO outro, NO sign-off
- NO brackets, NO placeholders in final output
Target: 50-80 words spoken total (HOOK + REACTION combined).`;
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
          const phonetic = getPhonetic(c.streamer);
          return `STREAMER ${i+1}:
ON-AIR NAME (use this name ONLY — never use the Twitch username): ${displayName}
Twitch username (do NOT use this in spoken text): ${c.streamer||'Unknown'}
${phonetic ? `PRONUNCIATION: write the name as "${phonetic}" in spoken text so the avatar pronounces it correctly — never in parentheses\n` : ''}${notesStr}${clipLines}`;
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
[EXACTLY 2 sentences — not 1, not 3. First sentence: bridge from previous reaction. Second sentence: specific setup for clip 2. No [scene hold] — speak immediately like a streamer intro after a reaction pause.]
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

        // CPD-997: countdown framing — streamer order in `items` IS the countdown
        // order (first = lowest rank, last = NUMBER ONE). Additive block so the
        // tuned twitch prompt above stays untouched.
        if (isTop10) {
          const rankWords = ['one','two','three','four','five','six','seven','eight','nine','ten'];
          const rankLines = items.map((item, i) => {
            const rank = items.length - i;
            const name = getDisplayName(item.streamer);
            return `- ${name} is NUMBER ${String(rank).toUpperCase()} — their _INTRO scene MUST open with "Number ${rankWords[rank-1] || rank}." followed by [beat]`;
          }).join('\n');
          userPrompt += `

🏆 COUNTDOWN MODE — THIS IS A TOP ${items.length} RANKING SHOW:
The streamer sections above are in COUNTDOWN ORDER. Ranks are assigned as follows:
${rankLines}

COUNTDOWN RULES:
- Each streamer's _INTRO scene opens with the spelled-out rank announcement ("Number ${rankWords[items.length-1] || items.length}.") then [beat], then the 2-3 sentence intro.
- Numbers get smaller, sentences get shorter. Number one gets the flattest, most matter-of-fact read of the night.
- NEVER mention a later entry early. NEVER tease who is next. The list speaks for itself.
- The INTRO scene (locked) does not announce ranks — the first ranked entry does.`;
        }
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
    const MAX_INTERVENTIONS = 2;
    let script = '';
    let scriptQA = null;
    let geminiResult = null;
    let tokenUsage = { input: 0, output: 0 };
    let wordCount = 0;
    let estSecs = 0;
    let retryAttempt = 0;
    let interventionAttempt = 0;

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
      const redditItem = items[0] && (items[0].postId || items[0].redditSource);
      if (redditItem) {
        const beatCount = Number(items[0]?.beatCount || req.body?.beatCount || 5);
        expectedScenes = 1 + 1 + beatCount * 2 + 1 + 1;
      } else {
        expectedScenes = 1 + (items.length * 5) + 1;
      }
    }
    // Shorts and other types: expectedScenes remains 0 (no validation)

    async function runGate1WorkerQa(scriptInput) {
      const gate1 = require('./gates/gate1');
      const { saveGateResult: gwSaveG1Result } = require('./job_spec');
      const gwJobSpecWithScript = { ...gwJobSpec, filledScript: scriptInput };
      const g1Preflight = preflightGateExecution({ jobId, gate: 'gate1', fallbackJobSpec: gwJobSpecWithScript });
      if (g1Preflight.softHeals.length > 0) {
        console.log(`[gate-worker] Gate 1 preflight soft-heal: ${g1Preflight.softHeals.join('; ')}`);
      }
      if (!g1Preflight.ready) {
        console.warn(`[gate-worker] Gate 1 prerequisites warning: ${g1Preflight.reasons.join('; ')}`);
      }
      const g1RunSpec = g1Preflight.jobSpec || gwJobSpecWithScript;
      const g1Readiness = gate1.canProduce(g1RunSpec);
      if (g1Readiness.ready) {
        const gwG1Result = await gate1.run(g1RunSpec, scriptInput, gwGate0Result || {});
        try { await gwSaveG1Result(jobId, 'gate1', gwG1Result); } catch(e) {}
        console.log(`[gate-worker] Gate 1: ${gwG1Result.outcome} (score ${gwG1Result.score}/100)`);
        return {
          score:        gwG1Result.score,
          outcome:      gwG1Result.passed ? 'pass' : (gwG1Result.outcome === 'sendback' ? 'sendback' : 'fail'),
          outcomeLabel: gwG1Result.passed ? '✅ PASS' : (gwG1Result.outcome === 'sendback' ? '🔄 SENDBACK' : '❌ HARD FAIL'),
          passed:       gwG1Result.passed,
          deductions:   gwG1Result.deductions || [],
          fixDirective: gwG1Result.fixDirective || {},
          report:       gwG1Result.report || ''
        };
      }
      const preflightReason = `gate1Worker not ready at canProduce: ${g1Readiness.reasons.join('; ')}`;
      console.warn(`[gate-worker] Gate 1 canProduce not ready — hard failing: ${preflightReason}`);
      return {
        score: 0,
        outcome: 'fail',
        outcomeLabel: '❌ HARD FAIL (gate not ready)',
        passed: false,
        deductions: [{ points: -100, reason: preflightReason }],
        fixDirective: { structuralIssues: [preflightReason] },
        report: preflightReason
      };
    }

    // Retry loop: Generate script + run Gate 1 QA, retry on FAIL up to 3 times
    while (retryAttempt < MAX_RETRIES) {
      retryAttempt++;
      if (retryAttempt > 1) {
        try {
          pipelineBus.emit('pipeline:retry_attempt', {
            jobId,
            gate: 'gate1',
            stage: 'script_generation',
            attempt: retryAttempt,
            maxAttempts: MAX_RETRIES,
            contentType: type,
            customerId: gwJobSpec?.customerId || 'c0',
          });
        } catch (_e) { /* non-fatal */ }
      }
      const attemptLabel = retryAttempt > 1 ? ` (retry ${retryAttempt}/${MAX_RETRIES})` : '';
      console.log(`[generate-full-script] 📝 Generating script via Gemini${attemptLabel}...`);

      // Build feedback message if this is a retry
      let feedbackMsg = '';
      if (retryAttempt > 1 && scriptQA) {
        const fd = scriptQA.fixDirective || {};
        const parts = [];

        const hasInlineHeaders = script && /[^\n\r]===\s*[A-Z0-9_]+\s*===/.test(script);
        if (hasInlineHeaders || (scriptQA.deductions || []).some((d) => /found 0|found 0 scene|structure/i.test(String(d.reason || '')))) {
          parts.push(
            `🚨 INLINE SCENE HEADERS — HARD FAIL\n` +
            `Each === SCENE === header MUST be on its own line. Dialogue goes on the NEXT line.\n` +
            `WRONG: === INTRO ===Welcome to Twitch Soup...=== CINNA_INTRO ===First up...\n` +
            `RIGHT:\n=== INTRO ===\nWelcome to Twitch Soup...\n\n=== CINNA_INTRO ===\nFirst up...\n` +
            `Never concatenate headers onto the same line as spoken text or other headers.`
          );
        }

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

        // ── 2b. Gate 1 / video QA mismatches (e.g. commentary_accuracy) ───────
        if (fd.mismatches && fd.mismatches.length > 0) {
          parts.push(
            `🚨 QA MISMATCHES — MUST FIX\n` +
            fd.mismatches
              .map(
                (m) =>
                  `  • Field: ${m.field}\n    Issue: ${m.delivered}\n    Fix: ${m.fix || 'Correct per QA guidance'}`
              )
              .join('\n\n')
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
          `${fd.mismatches?.length || 0} mismatches, ` +
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
          const { normalizeScriptForGate1 } = require('./scaffold');
          const bareHeaders = (gwJobSpec?.designSpec?.sceneStructure?.sceneHeaders || [])
            .map((h) => String(h || '').trim())
            .filter(Boolean);
          script = normalizeScriptForGate1(script, bareHeaders);
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
              // No text before first game — scaffold bug, not something we patch here.
              // Log it so the scaffold team can investigate. Gate 1 will fail on missing INTRO.
              console.warn('[geminiScriptGeneration] ⚠️ Missing === INTRO === header and no intro text — scaffold should have pre-filled this. Gate 1 will catch it.');
            }
          }
        }
      } catch(e) {
        console.error(`[generate-full-script] Gemini script generation failed: ${e.message}`);
        script = `[ERROR: Gemini script generation failed: ${e.message}]`;
        // Force fail this attempt
        scriptQA = { score: 0, outcome: 'fail', passed: false, outcomeLabel: '❌ HARD FAIL', deductions: [{ points: 100, reason: `Gemini API error: ${e.message}` }], report: `Gemini script generation failed: ${e.message}` };
        console.log(`[generate-full-script] Gate 1 Script QA: ${scriptQA.outcomeLabel} (${scriptQA.score}/100)`);
        try {
          emitScriptGate1Bus(scriptQA, {
            jobId,
            customerId: gwJobSpec.customerId,
            contentType: type,
            retryAttempt,
            jobSpec: gwJobSpec
          });
        } catch (_e) { /* non-fatal */ }
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

      // ── Gate 1: Script QA — gate1Worker is the SOLE authoritative scorer (Gemini JSON QA in lib/gates/gate1.js).
      // clipsPerStreamer still derived for use in the claudeScriptFix retry path below (surgical text fix still uses Claude when triggered).
      const gate1ClipsPerStreamer = (items[0]?.clips?.length > 0 ? items[0].clips.length : null) ?? req.body.clipsPerStreamer ?? 2;

      // ── Pre-Gate-1 prohibited-word scrub ─────────────────────────────────────
      // Strip customer-specific prohibited words from the generated script before QA.
      // Gemini occasionally reuses a banned word despite the prompt instruction.
      // Replacing deterministically here prevents infinite sendback loops on a single word.
      try {
        const { getVoiceConfig } = require('./customerConfig');
        const _voiceCfg = getVoiceConfig(gwJobSpec.customerId || 'c0', gwJobSpec.templateId || 'long-form');
        const _banned = (_voiceCfg?.prohibitedWords || []);
        if (_banned.length > 0) {
          let _scrubbed = script;
          for (const _w of _banned) {
            // Replace whole-word occurrences (case-insensitive) with a neutral synonym
            const _synonyms = {
              wild: 'notable',
              incredible: 'significant',
              amazing: 'noteworthy',
              crazy: 'unusual'
            };
            const _replacement = _synonyms[_w.toLowerCase()] || 'notable';
            _scrubbed = _scrubbed.replace(new RegExp(`\\b${_w}\\b`, 'gi'), _replacement);
          }
          if (_scrubbed !== script) {
            console.log(`[generate-full-script] 🧹 Pre-Gate-1 scrub: replaced banned word(s) in script`);
            script = _scrubbed;
          }
        }
      } catch (_scrubErr) {
        console.warn(`[generate-full-script] Pre-Gate-1 scrub error (non-fatal): ${_scrubErr.message}`);
      }

      if (type.includes('-short')) {
        try {
          const { enforceShortScriptLanguage } = require('./youtube_language_policy');
          const lang = enforceShortScriptLanguage(script, type);
          if (lang.sanitized) {
            console.log('[generate-full-script] 🧹 YouTube language scrub: sanitized HOOK/REACTION/CAPTION');
          }
          if (lang.violations.length) {
            console.warn(`[generate-full-script] YouTube language note after scrub: ${lang.violations.join('; ')}`);
          }
          script = lang.script;
        } catch (_ytErr) {
          console.warn(`[generate-full-script] YouTube language scrub error (non-fatal): ${_ytErr.message}`);
        }
      }

      try {
        const { sanitizeScriptForHeyGen } = require('./heygen_spoken_sanitize');
        const cleaned = sanitizeScriptForHeyGen(script, { contentType: type });
        if (cleaned !== script) {
          console.log('[generate-full-script] 🧹 Phonetic scrub: removed parenthetical pronunciation guides');
          script = cleaned;
        }
      } catch (_phErr) {
        console.warn(`[generate-full-script] Phonetic scrub error (non-fatal): ${_phErr.message}`);
      }

      console.log(`[generate-full-script] 🔍 Running Gate 1 (gate1Worker — authoritative)...`);
      try {
        scriptQA = await runGate1WorkerQa(script);
      } catch (gwG1Err) {
        const errReason = `gate1Worker threw: ${gwG1Err.message}`;
        console.warn(`[gate-worker] Gate 1 error — hard failing: ${errReason}`);
        scriptQA = {
          score: 0,
          outcome: 'fail',
          outcomeLabel: '❌ HARD FAIL (gate error)',
          passed: false,
          deductions: [{ points: -100, reason: errReason }],
          fixDirective: { structuralIssues: [errReason] },
          report: errReason
        };
      }
      console.log(`[generate-full-script] Gate 1 Script QA: ${scriptQA.outcomeLabel} (${scriptQA.score}/100)`);
      try {
        emitScriptGate1Bus(scriptQA, {
          jobId,
          customerId: gwJobSpec.customerId,
          contentType: type,
          retryAttempt,
          jobSpec: gwJobSpec
        });
      } catch (_e) { /* non-fatal */ }

      try {
        const { appendGate1ScriptAttempt } = require('./job_spec');
        appendGate1ScriptAttempt(jobId, { attempt: retryAttempt, script });
        if (semanticJobId && semanticJobId !== jobId) {
          appendGate1ScriptAttempt(semanticJobId, { attempt: retryAttempt, script });
        }
      } catch (pe) {
        console.warn(`[artifact-persist] Gate 1 script snapshot: ${pe.message}`);
      }
      console.log(`[generate-full-script] Gate 1 Script QA: ${scriptQA.outcomeLabel} (${scriptQA.score}/100)`);

      // ── Gate 1 Auto-Action (Fix 5) ──────────────────────────────────
      const { action, directive, reason } = autoAction(1, scriptQA.score, {
        jobId,
        contentType: type,
        retryCount: retryAttempt - 1,
        gate1Passed: scriptQA.passed === true
      });
      logger.info({ gate: 1, score: scriptQA.score, action, directive, reason }, 'Gate 1 auto-action');
      try {
        recordWhyLedger({
          jobId,
          gate: 'gate1',
          kind: 'auto_action',
          passed: null,
          score: scriptQA.score,
          outcome: action,
          contentType: type,
          customerId: gwJobSpec.customerId || 'c0',
          failureClass: FAILURE_CLASS.UNKNOWN,
          interventionType: action === 'regenerate_script' ? INTERVENTION.AUTO_SCRIPT
            : action === 'manual_review' ? INTERVENTION.AGENT_OR_MANUAL
              : INTERVENTION.NONE,
          interventionOutcome: action,
          reasons: [reason],
          evidenceDigest: { directive: directive || null, retryAttempt },
          contractDigest: { scriptType: type, wordCount },
          source: 'lib/script_gen:gate1_auto_action'
        });
      } catch (_e) { /* non-fatal */ }

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
            try {
              emitScriptGate1Bus(scriptQA, {
                jobId,
                customerId: gwJobSpec.customerId,
                contentType: type,
                retryAttempt,
                jobSpec: gwJobSpec
              });
            } catch (_e) { /* non-fatal */ }
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

    // Automated intervention loop (owner/end-user invisible): when retries are exhausted
    // and Gate 1 still does not pass, run up to 2 Claude-assisted repairs before hard fail.
    while (scriptQA && scriptQA.outcome !== 'pass' && interventionAttempt < MAX_INTERVENTIONS) {
      interventionAttempt++;
      console.log(`[generate-full-script] 🛠 Gate 1 intervention ${interventionAttempt}/${MAX_INTERVENTIONS}...`);
      try {
        const fixResult = await claudeScriptFix(script, analyses, {
          contentType: type,
          streamers: (type === 'twitch' || type === 'twitch-short') ? items.map(s => ({ displayName: s.displayName || s.name || s, twitchUsername: s.username || s }))
               : (type === 'nba'    || type === 'nba-short')    ? items.map(g => ({ displayName: `${g.away} vs ${g.home}`, twitchUsername: g.gameId || '' }))
               : (type === 'news'   || type === 'news-short')   ? items.map(s => ({ displayName: s.title || s.link || '', twitchUsername: '' }))
               : [],
          clipsPerStreamer: (items[0]?.clips?.length > 0 ? items[0].clips.length : null) ?? req.body.clipsPerStreamer ?? 2,
          qaReport: scriptQA.claudeReport || scriptQA.report || '',
          jobId: `${type}_${dateStr}_${Date.now()}_intervention_${interventionAttempt}`
        });
        if (!fixResult.fixed || !fixResult.script) {
          console.warn(`[generate-full-script] Intervention ${interventionAttempt} returned no changes`);
          continue;
        }
        script = fixResult.script;
        const _bareHeaders = (gwJobSpec?.designSpec?.sceneStructure?.sceneHeaders || [])
          .map((h) => String(h || '').trim())
          .filter(Boolean);
        const { normalizeScriptForGate1 } = require('./scaffold');
        script = normalizeScriptForGate1(script, _bareHeaders);
        scriptQA = await runGate1WorkerQa(script);
        console.log(`[generate-full-script] Intervention ${interventionAttempt} Gate 1 result: ${scriptQA.outcomeLabel} (${scriptQA.score}/100)`);
        try {
          emitScriptGate1Bus(scriptQA, {
            jobId,
            customerId: gwJobSpec.customerId,
            contentType: type,
            retryAttempt: retryAttempt + interventionAttempt,
            jobSpec: gwJobSpec
          });
        } catch (_e) { /* non-fatal */ }
      } catch (interventionErr) {
        console.warn(`[generate-full-script] Intervention ${interventionAttempt} failed: ${interventionErr.message}`);
      }
    }

    // Scripts are plain-text === HEADER === format — no JSON directive processing needed.
    // Strip CAPTION: line before sending to HeyGen — it's metadata for overlay burn, not dialogue.
    // Bobby G should NOT speak the caption text aloud.
    let scriptForHeygen = script
      .replace(/^HOOK:\s*/mg, '')
      .replace(/^REACTION:\s*/mg, '')
      .replace(/^CAPTION:\s*.+$/mg, '')
      // Strip stage-direction markers — [pause], [PAUSE], [beat], [BEAT], [BEAT.] etc.
      // Bobby G must NOT speak these aloud; they are timing cues for the editor, not dialogue.
      .replace(/\[(?:pause|beat)[^\]]*\]/gi, '')
      .replace(/\n{3,}/g, '\n\n').trim();

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
          // Use best semantic match if score is reasonable; otherwise fall back to
          // the next unmatched pool item in original order so every story gets a clip.
          const MATCH_THRESHOLD = 0.1; // lowered from 0.2 — news titles are often short
          const useIdx = (bestMatch !== null && bestScore >= MATCH_THRESHOLD)
            ? bestMatch
            : pool.findIndex((_, pi) => !usedIndices.has(pi)); // sequential fallback

          if (useIdx >= 0) {
            usedIndices.add(useIdx);
            const matched = pool[useIdx];
            const isFallback = bestScore < MATCH_THRESHOLD;
            newOrderedClipUrls.push({
              url:        matched.url,
              clipUrl:    matched.url,
              pageUrl:    matched.item.link || matched.item.pageUrl || matched.item.url || '',
              label:      `STORY${block.slotNum}_CLIP`,
              streamer:   `story_${block.slotNum}`,
              title:      matched.item.title || `Story ${block.slotNum}`,
              storyIndex: block.slotNum - 1
            });
            console.log(`[news-clip-reorder] STORY${block.slotNum} → "${matched.item.title?.slice(0,40)}" (score ${(bestScore*100).toFixed(0)}%${isFallback ? ', sequential fallback' : ''})`);
          } else {
            newOrderedClipUrls.push({
              url: null, clipUrl: null, pageUrl: '',
              label: `STORY${block.slotNum}_CLIP`,
              streamer: `story_${block.slotNum}`,
              title: `Story ${block.slotNum} (no pool item)`,
              storyIndex: block.slotNum - 1
            });
            console.warn(`[news-clip-reorder] STORY${block.slotNum} — pool exhausted, no clip available`);
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
    let _preflightScenes = [];
    if (scriptQA.outcome === 'pass') {
      try {
        const transcriptBlocks = buildTranscriptBlocks(script, type);
        await persistAndVerifyArtifacts({
          filledScript: script,
          transcriptBlocks
        });

        const gate1ResultForHandoff = {
          gate: 'gate1',
          passed: scriptQA.passed === true,
          outcome: scriptQA.outcome,
          score: scriptQA.score ?? null,
          deductions: scriptQA.deductions || [],
          report: scriptQA.report || ''
        };
        const _handoffHeaders = (gwJobSpec?.designSpec?.sceneStructure?.sceneHeaders || [])
          .map((h) => String(h || '').trim())
          .filter(Boolean);
        const { normalizeScriptForGate1: _normHandoff } = require('./scaffold');
        script = _normHandoff(script, _handoffHeaders);
        scriptForHeygen = _normHandoff(scriptForHeygen, _handoffHeaders);
        const { review, heygenBlocks } = await runGateHandoffReview({
          jobId,
          semanticJobId,
          gate: 'gate1',
          nextGate: 'gate2',
          contentType: type,
          jobSpec: gwJobSpec,
          script,
          scriptForHeygen,
          gateResult: gate1ResultForHandoff
        });
        _preflightScenes = heygenBlocks.map((b) => ({
          name: b.sceneId,
          type: b.type,
          text: b.text
        }));
        if (!review.passed) {
          const reviewReason = `Gate 1 handoff review failed: ${review.issues.join('; ')}`;
          console.error(`[generate-full-script] ❌ ${reviewReason}`);
          scriptQA = {
            outcome: 'fail',
            score: 0,
            passed: false,
            deductions: [{ points: -100, reason: reviewReason }],
            fixDirective: { structuralIssues: review.issues },
            report: reviewReason
          };
        }
      } catch (e) {
        console.error(`[artifact-persist] filledScript/transcript persistence failed: ${e.message}`);
        throw e;
      }
    }
    if (scriptQA.outcome === 'pass' && !GATE_TEST_MODE) {
      // Pre-flight: verify parseScriptIntoScenes finds at least 1 avatar scene before burning HeyGen credits
      if (_preflightScenes.length === 0) {
        _preflightScenes = parseScriptIntoScenes(scriptForHeygen, { contentType: type });
      }
      const _avatarScenes = _preflightScenes.filter(s => s.type === 'avatar');
      if (_avatarScenes.length === 0) {
        console.error(`[generate-full-script] ❌ Pre-HeyGen validation failed — 0 avatar scenes parseable. Script lacks === HEADER === markers. Will retry script generation.`);
        scriptQA = { outcome: 'fail', score: 0, fixDirective: { structuralIssues: ['Script has no parseable scene headers — regenerate with correct === HEADER === format'] } };
        // Don't send to HeyGen — fall through to retry logic below
      } else if (req.jobSpec?.designSpec?.synthVerifyRequired && req.jobSpec?.designSpec?.synthVerified === false) {
        // Synth prebuild ran and failed for this chrome config — block HeyGen until overlay is fixed.
        // This only fires when it's a first-run chrome hash AND the synth assembly failed.
        const synthErr = req.jobSpec.designSpec.synthVerifyError || 'unknown error';
        const synthHash = req.jobSpec.designSpec.synthVerifyHash || '?';
        console.error(`[generate-full-script] 🚫 Synth prebuild FAILED for chrome hash ${synthHash} — blocking HeyGen to prevent credit burn. Error: ${synthErr}`);
        logError('HEYGEN_BLOCKED_SYNTH_FAIL', new Error(`Synth prebuild failed: ${synthErr}`), {
          jobId: req.jobSpec.jobId, contentType: type, synthHash
        });
        heygenResult = { error: `Synth prebuild failed for chrome hash ${synthHash}: ${synthErr}` };
        // Don't fall through to retry — this is a chrome/assembly issue, not a script issue
      } else {
      const isTwitchLong = String(type).includes('twitch') && !String(type).includes('-short');
      const holdBeforeHeygen = isTwitchLong
        ? req.body?.holdBeforeHeygen !== false
        : req.body?.holdBeforeHeygen === true;
      if (holdBeforeHeygen) {
        console.log(`[generate-full-script] ⏸ holdBeforeHeygen=true — Gate 1 PASSED but HeyGen auto-send is disabled — script held for manual review`);
        heygenResult = { held: true };
      } else {
      console.log(`[generate-full-script] 🎬 Gate 1 PASSED — ${_avatarScenes.length} avatar scenes validated — Auto-sending to HeyGen...`);
      try {
        const format = type.includes('-short') ? 'portrait' : 'landscape';
        heygenResult = await sendScriptToHeyGen(scriptForHeygen, {
          contentType: type,
          format,
          // Same jobId as Gate 0–5 + job card + poller — do not mint a parallel HeyGen-only id.
          jobId
        });
        console.log(`[generate-full-script] ✅ HeyGen video generation initiated: ${JSON.stringify(heygenResult.videoJobs?.map(j => j.video_id) || [heygenResult.video_id])}`);
      } catch(e) {
        console.error('[generate-full-script] ⚠️  HeyGen auto-send failed:', e.message);
        heygenResult = { error: e.message };
      }
      } // end holdBeforeHeygen else
      } // end else (_avatarScenes.length > 0)
    } else if (GATE_TEST_MODE && scriptQA.outcome === 'pass') {
      console.log('[generate-full-script] ⏸  GATE_TEST_MODE=true — Gate 1 PASSED but HeyGen auto-send is disabled for testing');
    } else {
      console.log(`[generate-full-script] ⏸  Gate 1 ${scriptQA.outcome.toUpperCase()} — Skipping HeyGen auto-send (${retryAttempt} attempt${retryAttempt>1?'s':''} made)`);
    }

    // ── Generate publish copy immediately after Gate 1 pass ───────────
    // Locks publishCopy (title, description, tags, thumbnail hook text) BEFORE
    // any HeyGen credits burn. Script is approved, items are known.
    // Runs regardless of GATE_TEST_MODE — no credits at risk here.
    let publishCopyResult = null;
    if (scriptQA.outcome === 'pass') {
      // Card row + job_spec must exist before saveOutput(publishCopy) — that runs before saveJobCard below.
      try {
        const db = require('./db');
        if (!db.getJobBySpec(jobId)) {
          db.saveJob(jobId, {
            jobId,
            scriptJobId: jobId,
            contentType: type,
            stage: 'script_ready',
            savedAt: new Date().toISOString()
          });
          db.seedJobSpecFromScript(jobId, gwJobSpec);
        }
      } catch (e) {
        console.warn(`[generate-full-script] pre-publish job_spec seed failed (non-fatal): ${e.message}`);
      }
      try {
        const { generatePublishCopyFromScript } = require('./publish');
        const publishItems = (items || []).map(item => ({
          title:    item.title    || item.displayName || item.name || item.matchup || item.teams || '',
          headline: item.headline || item.title       || '',
          url:      item.url      || item.pageUrl     || item.link || ''
        }));

        publishCopyResult = await generatePublishCopyFromScript({
          script,
          contentType: type,
          formType: type.includes('-short') ? 'short' : 'compilation',
          items: publishItems,
          jobId,
          platforms: ['youtube', 'tiktok', 'instagram'],
          designSpec: gwJobSpec?.designSpec || {}
        });

        if (publishCopyResult && !publishCopyResult.error) {
          // Write to job spec savedOutputs so assembly + Gate 5 read from here
          try {
            const { saveOutput: savePC } = require('./job_spec');
            await savePC(jobId, 'publishCopy', publishCopyResult);
          } catch(e) {}
          console.log(`[generate-full-script] 📝 Publish copy locked at Gate 1: "${publishCopyResult.youtube?.title || publishCopyResult.youtube?.titles?.[0] || 'n/a'}"`);
        }
      } catch(pcErr) {
        console.warn(`[generate-full-script] Publish copy generation failed (non-fatal): ${pcErr.message}`);
        publishCopyResult = null;
      }
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
      .addData('gate1RetryAttempts', retryAttempt)
      .addData('gate1InterventionAttempts', interventionAttempt);

    addStageMetrics(jobId, scriptGenTimer.end());
    finalizeJobMetrics(jobId);

    // ── Parse caption text + style for short-form videos ─────────────────────
    // CAPTION: line from the script becomes a burned-in text overlay in assembly.
    // Each show has its own font, color, background, and position per creative bible.
    let captionText = null;
    let captionStyle = null;
    if (type.includes('-short') && script) {
      const { enforceShortScriptLanguage } = require('./youtube_language_policy');
      const lang = enforceShortScriptLanguage(script, type);
      if (lang.captionText) {
        captionText = lang.captionText;
        console.log(`[generate-full-script] 📝 Caption parsed: "${captionText}"`);
      } else {
        const captionMatch = script.match(/^CAPTION:\s*(.+)$/m);
        if (captionMatch) {
          captionText = captionMatch[1].trim().replace(/^["']|["']$/g, '').trim();
          console.log(`[generate-full-script] 📝 Caption parsed: "${captionText}"`);
        }
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
          position:  'above-split',     // centered on split line between avatar/comment zone
          style:     'uppercase',       // Force all caps
          emojis:    true
        },
        nba: {
          font:      '/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf',
          fontsize:  68,
          fontcolor: '0x1CE8FF',        // Electric blue
          boxcolor:  '0x000000@0.75',
          boxborderw: 18,
          position:  'center-frame',    // centered overlay for split-screen comments
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

    const heygenVideoCount = Array.isArray(heygenResult?.videoJobs)
      ? heygenResult.videoJobs.length
      : (heygenResult?.video_id ? 1 : 0);
    nrPipelineEvent('ScriptGenerationComplete', {
      jobId,
      jobSpecId: req?.jobSpecId || null,
      customerId: req.body?.customerId || gwJobSpec?.customerId || 'c0',
      contentType: type,
      itemCount: items.length,
      wordCount,
      estSecs,
      gate1Outcome: scriptQA.outcome,
      gate1Score: scriptQA.score ?? null,
      gate1Passed: !!scriptQA.passed,
      gate1RetryAttempts: retryAttempt,
      gateTestMode: GATE_TEST_MODE,
      heygenSubmitAttempted: scriptQA.outcome === 'pass' && !GATE_TEST_MODE,
      heygenSubmitted: !!(scriptQA.outcome === 'pass' && !GATE_TEST_MODE && heygenResult && !heygenResult.error),
      heygenError: (heygenResult && heygenResult.error) ? String(heygenResult.error).slice(0, 500) : null,
      heygenVideoJobCount: heygenVideoCount
    });

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
        retryAttempts: retryAttempt,
        held:          !!(heygenResult && heygenResult.held === true)
      },
      // HeyGen auto-send result (only present if Gate 1 passed)
      heygen: heygenResult,
      // Short-form caption overlay — text + per-show style for FFmpeg burn
      captionText,
      captionStyle,
      // Include metrics in response for debugging + E2E watchers (semantic id for /job-spec polls)
      metricsJobId: jobId,
      scriptJobId: jobId,
      semanticJobId: req?.jobSpec?.jobId || req?.jobSpecId || null
    });

    // ── Save point 1: Persist job card whenever script generation completes ───
    // Pin for pass AND non-pass — operator must see the card to review / retry HeyGen.
    if (script) {
      const _saveHeaders = (gwJobSpec?.designSpec?.sceneStructure?.sceneHeaders || [])
        .map((h) => String(h || '').trim())
        .filter(Boolean);
      const { normalizeScriptForGate1: _normSave } = require('./scaffold');
      script = _normSave(script, _saveHeaders);
      const gate1Stage = scriptQA.outcome === 'pass'
        ? 'script_ready'
        : (scriptQA.outcome === 'manual_review' || scriptQA.outcome === 'sendback')
          ? 'gate1_review'
          : 'gate1_failed';
      const streamerNames = (type === 'twitch' || type === 'twitch-short')
        ? items.map(s => s.displayName || s.name || s).filter(Boolean)
        : [];
      const scriptScenesEarly = parseScriptIntoScenes(script, { contentType: type });
      saveJobCard(jobId, {
        jobId,
        scriptJobId: jobId,
        jobSpecId: req?.jobSpecId || null,
        stage: gate1Stage,
        contentType: type,
        queuePinned: true,
        queuePinnedAt: new Date().toISOString(),
        title: streamerNames.length
          ? ('TWITCH SOUP — ' + streamerNames.slice(0, 3).join(', '))
          : ((type || 'video').toUpperCase() + ' — ' + dateStr),
        scriptVariant: scriptVariant || null,
        repurposedFrom: req.body.repurposedFrom || null,
        date: dateStr,
        script: { raw: script, scenes: scriptScenesEarly },
        wordCount,
        estSecs,
        orderedClipUrls,
        gate1Score: scriptQA.score,
        gate1Outcome: scriptQA.outcome,
        gate1Passed: !!scriptQA.passed,
        gate1Summary: scriptQA.report ? String(scriptQA.report).slice(0, 500) : null,
        expectedClips: scriptQA.expectedClips ?? 0,
        captionText: captionText || null,
        captionStyle: captionStyle || null,
        streamers: type === 'twitch' ? items.map(s => ({ displayName: s.displayName || s.name || s, twitchUsername: s.username || s.streamer || s })) : [],
        newsItems: (type === 'news' || type === 'news-short') ? items.map(s => ({
          title:        s.title || '',
          source:       s.source || '',
          category:     s.category || 'WORLD NEWS',
          thumbnailUrl: s.thumbnailUrl || s.imageUrl || '',
          videoUrl:     s.videoUrl || s.clipUrl || '',
          link:         s.link || s.url || ''
        })) : [],
        nbaItems: (type === 'nba' || type === 'nba-short') ? items.map(s => ({
          title:   s.title || s.matchup || '',
          matchup: s.matchup || s.title || '',
          gameId:  s.gameId || null,
          category: 'NBA GAME'
        })) : [],
        designSpec: gwJobSpec?.designSpec || null,
        publishCopy: publishCopyResult || null,
        heygen: (heygenResult && !heygenResult.error) ? heygenResult : null
      });
      console.log(`[jobs] ✅ Job card saved (stage=${gate1Stage}, gate1=${scriptQA.outcome}): ${jobId}`);
      if (scriptQA.outcome === 'pass') {
        try {
          const { seedJobSpecFromScript } = require('./db');
          if (seedJobSpecFromScript(jobId, gwJobSpec)) {
            console.log(`[jobs] ✅ Seeded job_spec for /job-spec + gate persistence: ${jobId}`);
          }
        } catch (e) {
          console.warn(`[jobs] seedJobSpecFromScript failed (non-fatal): ${e.message}`);
        }
        const semanticEarly = req?.jobSpecId || req?.body?.jobSpecId;
        if (semanticEarly && semanticEarly !== jobId) {
          try {
            const { linkScriptJob } = require('./job_spec');
            await linkScriptJob(semanticEarly, jobId);
            console.log(`[job-spine] Linked ${semanticEarly} → ${jobId} (Gate 1 pass)`);
          } catch (e) {
            console.warn(`[job-spine] Early link failed: ${e.message}`);
          }
        }
      }
    }

    // ── Save point 2: Update job card to all_sent when HeyGen also succeeds ──
    // Dashboard calls GET /jobs on load to restore the job queue.
    if (scriptQA.outcome === 'pass' && heygenResult && !heygenResult.error) {
      // Parse script into scenes so saveJobCard can extract sourceClipSegments
      // and startup resume can rebuild segmentData after a server restart.
      let scriptScenes = parseScriptIntoScenes(script, { contentType: type });
      if (String(type).includes('twitch')) {
        const { mergeStreamerBlockHeyGenScenes } = require('./soup_intro_clip1_merge');
        scriptScenes = mergeStreamerBlockHeyGenScenes(scriptScenes, { contentType: type });
      }
      const jobCard = {
        jobId,
        scriptJobId: jobId,   // same value, explicit field for restore path
        jobSpecId: req?.jobSpecId || null,  // semantic job spec ID — links script job to full job spec in DB
        stage: 'all_sent',    // pipeline stage — used by /jobs filter and startup resume
        contentType: type,
        queuePinned: true,
        queuePinnedAt: new Date().toISOString(),
        avatarEngine: 'heygen',
        scriptVariant: scriptVariant || null,           // CPD-997
        repurposedFrom: req.body.repurposedFrom || null, // CPD-998
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
        newsItems: (type === 'news' || type === 'news-short') ? items.map(s => ({
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
        designSpec: gwJobSpec?.designSpec || null,
        publishCopy: publishCopyResult || null  // locked at Gate 1 — assembly skips regeneration if present
      };
      const manualWf = require('./manual_segment_workflow');
      const useManualImmediate = manualWf.useC0ImmediateManualHold(jobCard);
      if (useManualImmediate) {
        const prep = await manualWf.prepareC0ManualHoldAfterHeyGen(jobId, jobCard);
        jobCard.stage = 'awaiting_manual_segments';
        jobCard.manualSegments = prep.manualSegments;
        saveJobCard(jobId, jobCard);
        console.log(
          `[jobs] ✅ c0 immediate manual hold (HeyGen sent, no poll) — ${prep.manualSegments.manualDir} — resume POST /job/${jobId}/manual-segments/resume`
        );
      } else {
        saveJobCard(jobId, jobCard);
        console.log(`[jobs] ✅ Job card updated to all_sent: ${jobId}`);
      }

      // ── Job spine: link script_* jobId to semantic c0_* jobSpecId ──
      // Roo gate owners query gate results by job ID. Gate results are saved
      // under script_* IDs. If a c0_* semantic job spec exists, write the
      // script_* ID back to it so Roo can JOIN on script_job_id.
      const semanticJobIdLate = req?.jobSpecId || req?.body?.jobSpecId;
      if (semanticJobIdLate && semanticJobIdLate !== jobId) {
        try {
          const { linkScriptJob } = require('./job_spec');
          await linkScriptJob(semanticJobIdLate, jobId);
          console.log(`[job-spine] Linked ${semanticJobIdLate} → ${jobId}`);
        } catch(e) {
          console.warn(`[job-spine] Failed to link job IDs: ${e.message}`);
        }
      }

      // ── Auto-poll HeyGen → auto-assemble (skipped for c0 immediate manual hold) ──
      if (!useManualImmediate) {
        startHeyGenPoller(jobId, jobCard).catch(e => {
          console.error(`[heygen-poller:${jobId}] Poller startup error: ${e.message}`);
        });
      }
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
  enhanceDeliveryTags,
  geminiScriptGeneration,
  getVoiceGuide,
  scrapeArticleVideo,
  scrapeArticleOgImage,
  geminiAnalyzeClip,
  geminiAnalyzeThumbnail,
  prioritizeNewsStories,
  handleGenerateFullScript,
  matchStoryToAjVideo,
  rewriteJobScriptFromCard,
};

/**
 * Re-run Gate 1 QA on operator-edited script (feedback reserved for future Gemini rewrite).
 */
async function rewriteJobScriptFromCard(card, feedback) {
  const jobId = card?.jobId || card?.id;
  const script = card?.script?.raw;
  if (!script?.trim()) throw new Error('No script on job card');
  const contentType = card.contentType || 'twitch';
  const scriptQA = await claudeScriptQA(script, [], {
    contentType,
    jobId,
    feedback: feedback || undefined,
  });
  const next = {
    ...card,
    script: { ...(card.script || {}), raw: script },
    scriptQA,
    stage: scriptQA.outcome === 'pass' ? 'script_ready' : card.stage,
  };
  const { invalidateSceneOrderConfirm } = require('./scene_order_gate');
  return { card: invalidateSceneOrderConfirm(next), scriptQA, script };
}
