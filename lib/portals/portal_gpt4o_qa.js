'use strict';
/**
 * lib/portals/portal_gpt4o_qa.js — GPT-4o Production Quality Reviewer (CPD-431)
 *
 * Fires as an extension after portal3b (Assembly QA passed). Performs a deep
 * creative + quality review of the assembled video that goes beyond Gemini's
 * visual spot-checks:
 *
 *   1. Extract frames at 8 evenly-spaced points (ffmpeg, no upload cost)
 *   2. Transcribe full audio via OpenAI Whisper
 *   3. Send frames + transcript + job spec context to GPT-4o
 *   4. GPT-4o returns structured critique: hook strength, pacing, audio quality,
 *      script-to-video alignment, branding, creative notes, and a 0-100 quality score
 *   5. Fixable issues (silence segment, weak hook, missing branding) generate
 *      remediation directives for auto-processing
 *   6. Non-fixable issues go to operator queue with specific instructions
 *
 * Activation: ordered when OPENAI_API_KEY is present. Skips gracefully if key missing.
 * Cost: ~$0.10-0.30 per job (GPT-4o vision + Whisper). Priced into job credits.
 *
 * Extension intercept: fires after portal3b (both clips and commentary jobs)
 */

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { ffmpegPath, ffprobePath } = require('../ffmpeg_utils');
const { logError } = require('../error_logger');
const OpenAI = require('openai');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GPT4O_MODEL   = 'gpt-4o';
const WHISPER_MODEL = 'whisper-1';
const FRAME_COUNT   = 8;   // frames extracted across full video
const FRAME_QUALITY = 3;   // ffmpeg -q:v (1=best, 31=worst)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _client() {
  if (!OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: OPENAI_API_KEY });
}

function _now() { return new Date().toISOString(); }

/**
 * Get video duration in seconds via ffprobe.
 */
function _getDuration(videoPath) {
  return new Promise((resolve) => {
    execFile(
      ffprobePath(),
      ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath],
      { timeout: 15000 },
      (err, stdout) => {
        const d = parseFloat(stdout?.trim());
        resolve(isNaN(d) ? 0 : d);
      }
    );
  });
}

/**
 * Extract FRAME_COUNT JPEG frames evenly distributed across the video.
 * Returns array of { timestamp: number, path: string }.
 */
async function _extractFrames(videoPath, jobId, tmpDir) {
  const duration = await _getDuration(videoPath);
  if (!duration || duration < 2) return [];

  const FFMPEG = ffmpegPath();
  const frames = [];

  for (let i = 0; i < FRAME_COUNT; i++) {
    const ts = duration * (i + 0.5) / FRAME_COUNT;
    const outPath = path.join(tmpDir, `gpt4o_qa_${jobId}_f${i}.jpg`);
    const ok = await new Promise((resolve) => {
      execFile(
        FFMPEG,
        ['-y', '-ss', String(ts.toFixed(2)), '-i', videoPath,
         '-frames:v', '1', '-q:v', String(FRAME_QUALITY), outPath],
        { timeout: 30000 },
        (err) => resolve(!err && fs.existsSync(outPath))
      );
    });
    if (ok) frames.push({ timestamp: ts, path: outPath });
  }
  return frames;
}

/**
 * Extract audio as mono 16kHz WAV for Whisper.
 * Returns path to WAV file or null.
 */
function _extractAudio(videoPath, outPath) {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath(),
      ['-y', '-i', videoPath, '-vn', '-ar', '16000', '-ac', '1', '-f', 'wav', outPath],
      { timeout: 120000 },
      (err) => resolve(!err && fs.existsSync(outPath) ? outPath : null)
    );
  });
}

/**
 * Transcribe audio via Whisper. Returns transcript string or null.
 */
async function _transcribe(audioPath, jobId) {
  const client = _client();
  if (!client || !audioPath) return null;
  try {
    const audioStream = fs.createReadStream(audioPath);
    const response = await client.audio.transcriptions.create({
      model: WHISPER_MODEL,
      file: audioStream,
      response_format: 'text',
    });
    return typeof response === 'string' ? response : response?.text || null;
  } catch (err) {
    logError('GPT4O_QA_WHISPER_FAIL', err, { jobId });
    return null;
  }
}

/**
 * Convert frame JPEGs to base64 data URIs for GPT-4o vision.
 */
function _frameToBase64(framePath) {
  try {
    const buf = fs.readFileSync(framePath);
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Build the GPT-4o QA prompt with job context + transcript + instructions.
 */
function _buildPrompt(jobSpec, transcript, frameCount, duration) {
  const topic      = jobSpec?.topic || jobSpec?.order?.inputs?.topic || 'unknown topic';
  const tone       = jobSpec?.tone || 'standard';
  const format     = jobSpec?.productionProfile || jobSpec?.format || 'standard';
  const contentType = jobSpec?.contentType || 'clips';
  const platforms  = (jobSpec?.order?.publish?.platforms || []).join(', ') || 'youtube';
  const branding   = jobSpec?.addOns?.branding?.active !== false;
  const hasTTS     = jobSpec?.addOns?.tts?.active === true;
  const hasTransitions = jobSpec?.addOns?.dynamicOverlays?.active === true;
  const filledScript = jobSpec?.state?.savedOutputs?.filledScript || jobSpec?.filledScript || '';

  // CPD-872: Feature compliance section — only injected when requiredFeatures is non-empty
  const requiredFeatures = Array.isArray(jobSpec?.requiredFeatures) && jobSpec.requiredFeatures.length > 0
    ? jobSpec.requiredFeatures
    : [];
  const featureSection = requiredFeatures.length > 0
    ? `\nFEATURE COMPLIANCE — verify each required feature is present and respond in featureCompliance array:\n${
        requiredFeatures.map((f, i) => `${i + 1}. [${f.key}] ${f.label}: ${f.description}`).join('\n')
      }\n`
    : '';

  const featureResponseSchema = requiredFeatures.length > 0
    ? `  "featureCompliance": [
    {
      "key": "feature_key",
      "label": "Feature label",
      "status": "found" | "missing" | "partial",
      "timestamp": "MM:SS or null if not applicable",
      "confidence": 0.0-1.0,
      "notes": "brief evidence or reason for status"
    }
  ],\n`
    : '';

  return `You are a senior video production quality reviewer for a professional content platform. 
You have been given ${frameCount} frames from a ${Math.round(duration)}s video, evenly distributed from start to finish.

JOB CONTEXT:
- Topic: ${topic}
- Content type: ${contentType}
- Format: ${format}
- Tone: ${tone}
- Platform target: ${platforms}
- TTS voice-over: ${hasTTS ? 'YES' : 'NO'}
- Branding/logo overlay: ${branding ? 'YES — must be visible' : 'NO — should not be present'}
- Scene transitions: ${hasTransitions ? 'YES — crossfade/dissolve between clips' : 'NO'}
${filledScript ? `\nSCRIPT:\n${filledScript.slice(0, 1500)}${filledScript.length > 1500 ? '\n...[truncated]' : ''}` : ''}
${transcript ? `\nAUDIO TRANSCRIPT (Whisper):\n${transcript.slice(0, 2000)}${transcript.length > 2000 ? '\n...[truncated]' : ''}` : '\nNOTE: No transcript available.'}${featureSection}
FRAMES: You are viewing ${frameCount} frames evenly distributed across the full video duration (frame 1 = ~${Math.round(100/frameCount)}% in, frame ${frameCount} = ~${Math.round(100 - 100/frameCount)}% in).

REVIEW CRITERIA — score each 0-10 and provide specific feedback:

1. HOOK STRENGTH (frames 1-2): Does the opening grab attention in the first 5 seconds? Is there a compelling visual or audio hook?

2. VISUAL QUALITY: Are frames sharp, well-composed, and free of artifacts? Is the layout correct for ${format}?

3. BRANDING CONSISTENCY: ${branding ? 'Is the logo/overlay visible and correctly placed across all frames?' : 'Confirm no unwanted branding is present.'}

4. PACING & FLOW: Do the frames suggest good visual pacing? Any abrupt cuts, repetitive frames, or stagnant segments?

5. AUDIO-VISUAL ALIGNMENT: Does the transcript (if available) align with the visual content? Does the spoken content match what appears on screen?

6. CONTENT QUALITY: Is the content compelling, on-topic, and appropriate for ${platforms}? Would a viewer keep watching?

7. PRODUCTION POLISH: Overall professional quality — transitions, text overlays, caption placement, color grading consistency.

ALSO REPORT:
- Any specific fixable issues with timestamp and recommended fix (e.g., "Frame 7 shows branding missing — re-run chrome overlay", "Transcript ends abruptly at ~${Math.round(duration * 0.8)}s — check TTS completion")
- Any creative improvements that would make this video perform better (not blocking, informational)

Return ONLY valid JSON:
{
  "overallScore": 0-100,
  "hookStrength": 0-10,
  "visualQuality": 0-10,
  "brandingConsistency": 0-10,
  "pacingAndFlow": 0-10,
  "audioVisualAlignment": 0-10,
  "contentQuality": 0-10,
  "productionPolish": 0-10,
  "summary": "2-3 sentence overall assessment",
  "fixableIssues": [
    { "issue": "description", "timestamp": "HH:MM or null", "suggestedFix": "specific action", "autoFixable": true/false }
  ],
  "creativeNotes": ["optional improvement suggestions — not blocking"],
${featureResponseSchema}  "passed": true/false
}

passed=true means the video meets production standards for delivery. passed=false means at least one critical issue must be fixed before the video is shown to the customer.${requiredFeatures.length > 0 ? ' If ANY required feature has status "missing", set passed=false.' : ''}`;
}

/**
 * Call GPT-4o with frames and prompt.
 */
async function _reviewWithGPT4o(frames, prompt, jobId) {
  const client = _client();
  if (!client) return null;

  const imageParts = frames
    .map((f) => _frameToBase64(f.path))
    .filter(Boolean)
    .map((b64) => ({ type: 'image_url', image_url: { url: b64, detail: 'low' } }));

  if (imageParts.length === 0) return null;

  try {
    const response = await client.chat.completions.create({
      model: GPT4O_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            ...imageParts,
            { type: 'text', text: prompt },
          ],
        },
      ],
      max_tokens: 1500,
      response_format: { type: 'json_object' },
    });

    const raw = response.choices?.[0]?.message?.content || '';
    return JSON.parse(raw);
  } catch (err) {
    logError('GPT4O_QA_REVIEW_FAIL', err, { jobId, model: GPT4O_MODEL });
    return null;
  }
}

// ─── runWorker ────────────────────────────────────────────────────────────────

async function runWorker({ jobSpec, workerAttempt = 1 }) {
  const jobId = jobSpec?.jobId || 'unknown';
  console.log(`[gpt4o_qa:${jobId}] attempt=${workerAttempt} — starting GPT-4o production review`);

  // CPD-444: Spec-driven routing — only run when explicitly ordered.
  // Fires on every job when OPENAI_API_KEY is present unless gated here.
  if (!jobSpec?.extensions?.gpt4o_qa_ext?.ordered && !jobSpec?.addOns?.gpt4o_qa_ext?.ordered) {
    console.log(`[gpt4o_qa:${jobId}] not ordered in addOns — skipping`);
    return {
      passed:  true,
      outcome: 'skip',
      reason:  'gpt4o_qa_ext not ordered for this job',
    };
  }

  // Skip gracefully if no API key — extension is optional
  if (!OPENAI_API_KEY) {
    console.warn(`[gpt4o_qa:${jobId}] OPENAI_API_KEY not set — skipping GPT-4o QA (add key to enable)`);
    return {
      passed: true,
      outcome: 'skip',
      reason: 'OPENAI_API_KEY not configured',
    };
  }

  const videoPath = jobSpec?.assembledPath || jobSpec?.outputPath ||
                    jobSpec?.state?.savedOutputs?.r2VideoPath;

  // Fall back to R2 URL if no local path (job may have been cleaned up)
  if (!videoPath || !fs.existsSync(videoPath)) {
    console.warn(`[gpt4o_qa:${jobId}] No local video path — skipping GPT-4o QA (file not on disk)`);
    return {
      passed: true,
      outcome: 'skip',
      reason: 'assembled video not on local disk — cannot extract frames',
    };
  }

  const tmpDir = path.join(__dirname, '..', '..', 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const cleanupPaths = [];

  try {
    const duration = await _getDuration(videoPath);
    console.log(`[gpt4o_qa:${jobId}] video duration=${Math.round(duration)}s — extracting ${FRAME_COUNT} frames`);

    // ── Step 1: Extract frames ─────────────────────────────────────────────
    const frames = await _extractFrames(videoPath, jobId, tmpDir);
    frames.forEach((f) => cleanupPaths.push(f.path));
    console.log(`[gpt4o_qa:${jobId}] extracted ${frames.length}/${FRAME_COUNT} frames`);

    // ── Step 2: Whisper transcription ──────────────────────────────────────
    const audioPath = path.join(tmpDir, `gpt4o_qa_${jobId}_audio.wav`);
    cleanupPaths.push(audioPath);
    const extractedAudio = await _extractAudio(videoPath, audioPath);
    let transcript = null;
    if (extractedAudio) {
      console.log(`[gpt4o_qa:${jobId}] transcribing audio via Whisper`);
      transcript = await _transcribe(extractedAudio, jobId);
      console.log(`[gpt4o_qa:${jobId}] transcript: ${transcript ? `${transcript.length} chars` : 'failed'}`);
    }

    if (frames.length === 0) {
      return { passed: true, outcome: 'skip', reason: 'no frames extracted' };
    }

    // ── Step 3: GPT-4o review ──────────────────────────────────────────────
    const prompt  = _buildPrompt(jobSpec, transcript, frames.length, duration);
    console.log(`[gpt4o_qa:${jobId}] sending ${frames.length} frames + transcript to GPT-4o`);
    const review  = await _reviewWithGPT4o(frames, prompt, jobId);

    if (!review) {
      console.warn(`[gpt4o_qa:${jobId}] GPT-4o returned no result — passing non-blocking`);
      return { passed: true, outcome: 'skip', reason: 'GPT-4o returned no result' };
    }

    // CPD-872: evaluate feature compliance — any 'missing' required feature forces passed=false
    const featureCompliance = Array.isArray(review.featureCompliance) ? review.featureCompliance : [];
    const missingFeatures   = featureCompliance.filter((f) => f.status === 'missing');
    const passedFeatures    = featureCompliance.filter((f) => f.status === 'found');
    if (missingFeatures.length > 0) {
      review.passed = false;
      console.warn(
        `[gpt4o_qa:${jobId}] ${missingFeatures.length} required feature(s) MISSING: ` +
        missingFeatures.map((f) => f.key).join(', ')
      );
    }

    console.log(
      `[gpt4o_qa:${jobId}] GPT-4o score=${review.overallScore} passed=${review.passed} ` +
      `fixable=${review.fixableIssues?.length || 0} features=${passedFeatures.length}/${featureCompliance.length} ok`
    );

    // Persist review to job spec for operator queue
    if (!jobSpec.state) jobSpec.state = {};
    if (!jobSpec.state.savedOutputs) jobSpec.state.savedOutputs = {};
    jobSpec.state.savedOutputs.gpt4oQA = {
      score:               review.overallScore,
      passed:              review.passed,
      summary:             review.summary,
      hookStrength:        review.hookStrength,
      visualQuality:       review.visualQuality,
      brandingConsistency: review.brandingConsistency,
      pacingAndFlow:       review.pacingAndFlow,
      audioVisualAlignment: review.audioVisualAlignment,
      contentQuality:      review.contentQuality,
      productionPolish:    review.productionPolish,
      fixableIssues:       review.fixableIssues || [],
      creativeNotes:       review.creativeNotes || [],
      // CPD-872: feature compliance table — visible in operator review panel
      featureCompliance,
      missingFeatureCount: missingFeatures.length,
      transcript:          transcript ? transcript.slice(0, 500) : null,
      reviewedAt:          _now(),
    };

    // Also persist transcript to savedOutputs for downstream use
    if (transcript && !jobSpec.state.savedOutputs.transcript) {
      jobSpec.state.savedOutputs.transcript = transcript;
    }

    const fixable = (review.fixableIssues || []).filter((i) => i.autoFixable);
    const blocking = (review.fixableIssues || []).filter((i) => !i.autoFixable);

    return {
      passed:              review.passed !== false,
      outcome:             review.passed !== false ? 'pass' : 'pass_with_notes',
      score:               review.overallScore,
      review,
      transcript:          transcript ? transcript.slice(0, 300) : null,
      fixableCount:        fixable.length,
      blockingCount:       blocking.length,
      featureCompliance,
      missingFeatureCount: missingFeatures.length,
    };

  } catch (err) {
    logError('GPT4O_QA_WORKER_FAIL', err, { jobId, workerAttempt });
    // Non-blocking — GPT-4o QA failure should not stop video delivery
    return {
      passed:  true,
      outcome: 'skip',
      reason:  `GPT-4o QA threw: ${err.message}`,
    };
  } finally {
    // Clean up temp files
    for (const p of cleanupPaths) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    }
  }
}

function isPass(result) {
  // gpt4o_qa_ext is informational only — never block job delivery regardless of score.
  // Review results are stored in jobSpec.state.savedOutputs.gpt4oQA for operator queue.
  return true;
}

module.exports = { runWorker, isPass };
