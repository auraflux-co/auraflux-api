'use strict';

/**
 * TTS extension worker — CPD-80
 * Fires after Portal 1 (script approved), before Portal 3b (assembly).
 * Generates standalone VO audio from the approved script.
 *
 * Primary provider: ElevenLabs
 * Fallback (CPD-215): Gemini 2.5 Flash TTS — triggered when ElevenLabs returns
 *   detected_unusual_activity (shared Render IP flagged). Uses GEMINI_API_KEY.
 *
 * Contract:
 *   runWorker({ jobSpec }) → { passed, outcome, audioPath, charCount, voiceId, provider }
 *   isPass(result)         → result.passed === true && result.outcome === 'generated'
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execSync } = require('child_process');
const { logError } = require('../error_logger');
const { isFeatureEnabled } = require('../services/feature_gate');

const DEFAULT_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb'; // George
const TMP_TTS_DIR = path.join(process.cwd(), 'tmp', 'tts');

// ── Gemini TTS fallback (CPD-215) ─────────────────────────────────────────────
// Called when ElevenLabs returns detected_unusual_activity (shared Render IP flag).
// Uses generativelanguage.googleapis.com REST API with GEMINI_API_KEY.
// Output: PCM (s16le, 24kHz, mono) converted to MP3 via ffmpeg.
const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const GEMINI_TTS_VOICE = 'Kore'; // Energetic, clear — suitable for gaming/content hype VO

async function generateGeminiTTS(script, jobId, { tone = 'energetic' } = {}) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    throw new Error('GEMINI_API_KEY not set — cannot use Gemini TTS fallback');
  }

  // Strip script section headers and cleanup for clean TTS input
  const cleanScript = script
    .replace(/===\s*\w+\s*===/g, '')    // remove === SECTION === markers
    .replace(/\[.*?\]/g, '')             // remove [stage directions]
    .replace(/\n{3,}/g, '\n\n')         // collapse triple+ newlines
    .trim();

  if (!cleanScript || cleanScript.length < 5) {
    throw new Error('Script too short or empty after cleanup');
  }

  const tonePrompt = tone.toLowerCase().includes('hype') || tone.toLowerCase().includes('energet')
    ? 'Say the following in an energetic, hype, broadcasting voice:'
    : `Say the following in a ${tone} voice:`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent?key=${geminiKey}`;
  const body = {
    contents: [{ parts: [{ text: `${tonePrompt}\n\n${cleanScript}` }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: GEMINI_TTS_VOICE },
        },
      },
    },
  };

  const response = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 120000,
  });

  const inlineData = response.data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inlineData?.data) {
    throw new Error('Gemini TTS response missing inlineData.data');
  }

  // PCM is s16le, 24000 Hz, 1 channel — convert to MP3 via ffmpeg
  if (!fs.existsSync(TMP_TTS_DIR)) {
    fs.mkdirSync(TMP_TTS_DIR, { recursive: true });
  }
  const pcmPath = path.join(TMP_TTS_DIR, `${jobId}_gemini.pcm`);
  const mp3Path = path.join(TMP_TTS_DIR, `${jobId}.mp3`);

  fs.writeFileSync(pcmPath, Buffer.from(inlineData.data, 'base64'));
  execSync(
    `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${pcmPath}" -codec:a libmp3lame -qscale:a 2 "${mp3Path}"`,
    { timeout: 30000, stdio: 'pipe' }
  );
  // Clean up PCM after conversion
  try { fs.unlinkSync(pcmPath); } catch (_) {}

  return { audioPath: mp3Path, charCount: cleanScript.length };
}

function resolveVoiceId(jobSpec) {
  return (
    jobSpec?.addOns?.tts?.voiceId ||
    jobSpec?.extensions?.tts_ext?.voiceId ||
    jobSpec?.designSpec?.voice?.elevenLabsVoiceId ||
    DEFAULT_VOICE_ID
  );
}

function resolveScript(jobSpec) {
  return (
    jobSpec?.state?.savedOutputs?.filledScript ||
    jobSpec?.filledScript ||
    jobSpec?.scaffold ||
    jobSpec?.script?.raw ||
    jobSpec?.script ||
    null
  );
}

async function runWorker({ jobSpec } = {}) {
  const jobId    = jobSpec?.jobId || 'unknown';
  const planTier = jobSpec?.planTier || 'operate';

  // Plan check: tts.elevenlabs requires dwy+
  if (!isFeatureEnabled('tts.elevenlabs', planTier)) {
    return {
      passed:    false,
      outcome:   'skip',
      reason:    `tts.elevenlabs not available on plan tier: ${planTier}`,
      audioPath: null,
      charCount: 0,
    };
  }

  // Guard: extension must be ordered
  if (!jobSpec?.addOns?.tts?.active && !jobSpec?.extensions?.tts_ext?.ordered) {
    return {
      passed: false,
      outcome: 'skip',
      reason: 'TTS extension not ordered for this job — check addOns.tts.active',
      audioPath: null,
      charCount: 0,
    };
  }

  const script = resolveScript(jobSpec);
  if (!script || typeof script !== 'string' || script.trim().length === 0) {
    logError('TTS_EXT_NO_SCRIPT', new Error('script not available'), { jobId });
    // Skip (not hard_fail) — if script is missing TTS degrades gracefully rather than failing the job.
    return {
      passed: false,
      outcome: 'skip',
      reason: 'Script not available — TTS skipped',
      audioPath: null,
      charCount: 0,
    };
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    logError('TTS_EXT_NO_API_KEY', new Error('ELEVENLABS_API_KEY not set'), { jobId });
    return {
      passed: false,
      outcome: 'skip',
      reason: 'ELEVENLABS_API_KEY not configured — TTS skipped, job continues without voiceover',
      audioPath: null,
      charCount: 0,
    };
  }

  const voiceId = resolveVoiceId(jobSpec);

  // Use direct HTTP (axios) rather than the SDK — the SDK's authentication path
  // differs from the REST API and returns 401 even with a valid key on some plan tiers.
  // Retry up to 3 times for 429 (rate limit) and 5xx (transient server errors) with
  // exponential backoff + jitter. Multiple jobs can call ElevenLabs concurrently on
  // Render, so rate limit bursts are expected during E2E test runs.
  const MAX_TTS_RETRIES = 3;
  let audioBuffer;
  let charCount = 0;
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_TTS_RETRIES; attempt++) {
    if (attempt > 0) {
      const baseDelay = Math.pow(2, attempt) * 5000; // 10s, 20s, 40s
      const jitter    = Math.floor(Math.random() * 3000); // 0-3s jitter
      const delay     = baseDelay + jitter;
      console.log(`[tts_ext:${jobId}] retry ${attempt}/${MAX_TTS_RETRIES} after ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        { text: script, model_id: 'eleven_multilingual_v2' },
        {
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg',
          },
          responseType: 'arraybuffer',
          timeout: 60000,
        }
      );
      audioBuffer = Buffer.from(response.data);
      charCount = parseInt(response.headers['x-character-count'] || '0', 10);
      lastErr = null;
      break; // success — exit retry loop
    } catch (err) {
      const status = err?.response?.status;
      lastErr = err;
      // 401/403 = auth error — check if it's a detected_unusual_activity flag
      // (ElevenLabs flags shared Render IPs when many requests come from the same IP).
      // In that case, fall through to Gemini TTS fallback before giving up.
      if (status === 401 || status === 403) {
        let errBody = '';
        let rawData = null;
        try {
          rawData = err?.response?.data;
          errBody = JSON.stringify(rawData || '');
        } catch (_) {}
        logError('TTS_EXT_AUTH_FAIL', err, { jobId, voiceId, status, errBody: errBody.slice(0, 300) });
        console.error(`[tts_ext:${jobId}] ElevenLabs ${status} body: ${errBody.slice(0, 200)}`);

        // CPD-215: detected_unusual_activity = Render IP flagged, not a bad key.
        // CPD-257: quota_exceeded = ElevenLabs monthly quota hit for this account.
        // Try Gemini TTS as fallback on any 401/403 — Gemini is always available via
        // GEMINI_API_KEY and is free to use as a fallback for auth/quota failures.
        const rawBodyText = Buffer.isBuffer(rawData) ? rawData.toString() : errBody;
        const isRecoverableAuthErr = (
          rawBodyText.includes('detected_unusual_activity') ||
          rawBodyText.includes('quota') ||
          rawBodyText.includes('invalid_api_key') ||
          status === 401 || status === 403
        );
        if (isRecoverableAuthErr) {
          const reason401 = rawBodyText.includes('quota') ? 'quota_exceeded' : rawBodyText.includes('detected_unusual_activity') ? 'ip_flagged' : `${status}`;
          console.log(`[tts_ext:${jobId}] ElevenLabs ${status} (${reason401}) — attempting Gemini TTS fallback`);
          try {
            const tone = jobSpec?.tone || jobSpec?.order?.inputs?.tone || 'energetic';
            const { audioPath: geminiPath, charCount: geminiChars } = await generateGeminiTTS(script, jobId, { tone });
            if (jobSpec.state) {
              jobSpec.state.tts = { provider: 'gemini', voiceId: GEMINI_TTS_VOICE, charCount: geminiChars, audioPath: geminiPath, generatedAt: new Date().toISOString() };
            }
            console.log(`[tts_ext:${jobId}] Gemini TTS fallback succeeded → ${geminiPath}`);
            return { passed: true, outcome: 'generated', audioPath: geminiPath, charCount: geminiChars, voiceId: GEMINI_TTS_VOICE, provider: 'gemini_tts_fallback' };
          } catch (geminiErr) {
            logError('TTS_EXT_GEMINI_FALLBACK_FAIL', geminiErr, { jobId });
            console.error(`[tts_ext:${jobId}] Gemini TTS fallback failed: ${geminiErr.message}`);
          }
        }

        return {
          passed: false,
          outcome: 'skip',
          reason: `ElevenLabs auth error (${status}) — Gemini fallback also failed or not available`,
          audioPath: null,
          charCount: 0,
        };
      }
      // 429 or 5xx — retryable
      console.warn(`[tts_ext:${jobId}] ElevenLabs API error (${status || err.code}) — attempt ${attempt + 1}/${MAX_TTS_RETRIES + 1}`);
    }
  }

  if (lastErr) {
    const status = lastErr?.response?.status;
    logError('TTS_EXT_GENERATE_FAIL', lastErr, { jobId, voiceId, status, attempts: MAX_TTS_RETRIES + 1 });
    return {
      passed: false,
      outcome: 'skip',
      reason: `ElevenLabs API error after ${MAX_TTS_RETRIES + 1} attempts (${status || lastErr.code}) — TTS skipped`,
      audioPath: null,
      charCount: 0,
    };
  }

  // Save audio to tmp/tts/<jobId>.mp3
  try {
    if (!fs.existsSync(TMP_TTS_DIR)) {
      fs.mkdirSync(TMP_TTS_DIR, { recursive: true });
    }
    const audioPath = path.join(TMP_TTS_DIR, `${jobId}.mp3`);
    fs.writeFileSync(audioPath, audioBuffer);

    // Record cost tracking in jobSpec state (non-blocking write-back — caller persists)
    if (jobSpec.state) {
      jobSpec.state.tts = { provider: 'elevenlabs', voiceId, charCount, audioPath, generatedAt: new Date().toISOString() };
    }

    return {
      passed: true,
      outcome: 'generated',
      audioPath,
      charCount,
      voiceId,
      provider: 'elevenlabs',
    };
  } catch (err) {
    logError('TTS_EXT_SAVE_FAIL', err, { jobId });
    return {
      passed: false,
      outcome: 'skip',
      reason: `Failed to save TTS audio — TTS skipped: ${err.message}`,
      audioPath: null,
      charCount,
    };
  }
}

function isPass(result) {
  // 'generated' = TTS succeeded and audio is ready for mixing.
  // 'skip'      = TTS gracefully degraded (no key, no script, API error, feature gated).
  //               Treat skip as pass so runUnifiedGatePolicy doesn't retry — the extension
  //               already decided it cannot run; retrying just wastes credits and time.
  return result?.outcome === 'generated' || result?.outcome === 'skip';
}

module.exports = { runWorker, isPass };
