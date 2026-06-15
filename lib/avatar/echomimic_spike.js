'use strict';
/**
 * CPD-881 spike-validated EchoMimic profile — single source of truth.
 * Matches spike/cpd881/control.sh infer_flash invocation exactly.
 * Confluence HOW 31555587 — do not drift without re-scoring gate2 A/B/C.
 */

/** Validated spike prompt (control.sh line 126). */
const SPIKE_PROMPT = (
  'A bearded man in a tan blazer over a black t-shirt sits at a desk in a '
  + 'streaming studio, a purple neon world map glowing on the wall behind him, '
  + 'a broadcast microphone on an arm at frame left. He speaks naturally to the '
  + 'camera. Hand and body movements are minimal and consistent with a natural '
  + 'speaking posture. Don\'t blink too often. Preserve background integrity '
  + 'matching the reference image\'s spatial configuration, lighting conditions, '
  + 'and color temperature.'
);

/** infer_flash.py default negative (official EchoMimic V3 Flash). */
const SPIKE_NEGATIVE_PROMPT = (
  'Gesture is bad. Gesture is unclear. Strange and twisted hands. Bad hands. '
  + 'Bad fingers. Unclear and blurry hands. Unclear gestures, broken hands, '
  + 'fused fingers. 手指融合，'
);

const SPIKE_PORTRAIT_KEY = 'spike/cpd881/inputs/bobbyg_studio.png';

const SPIKE_INFERENCE = {
  guidanceScale: 4.5,
  audioGuidanceScale: 2.0,
  audioScale: 1.0,
  seed: 43,
  numSkipStartSteps: 5,
  teacacheThreshold: 0.1,
  useDynamicCfg: false,
  useDynamicAcfg: false,
  negScale: 1.0,
  negSteps: 0,
  prompt: SPIKE_PROMPT,
  negativePrompt: SPIKE_NEGATIVE_PROMPT
};

const SPIKE_STEPS = 8;
const SPIKE_SAMPLE_SIZE = 768;
const SPIKE_MAX_FRAMES = 81;

/** Gate2 validation lines — same audio keys as launch_spike.py on R2. */
const GATE2_LINES = {
  A_short_hook: {
    audioKey: 'spike/cpd881/inputs/audio_A.wav',
    heygenRefKey: 'spike/cpd881/inputs/heygen_ref_A_3s.mp4',
    label: 'A_short_hook'
  },
  B_vod_intro: {
    audioKey: 'spike/cpd881/inputs/audio_B.wav',
    heygenRefKey: 'spike/cpd881/inputs/heygen_ref_B_3s.mp4',
    label: 'B_vod_intro'
  },
  C_emotional_read: {
    audioKey: 'spike/cpd881/inputs/audio_C.wav',
    heygenRefKey: 'spike/cpd881/inputs/heygen_ref_C_3s.mp4',
    label: 'C_emotional_read'
  }
};

/** Pass bar from spike gate2_scores — B_vod_intro hit 9/10 broadcast-ready. */
const GATE2_PASS_BROADCAST_READY = 9;

function spikeProfileActive() {
  const p = String(process.env.ECHOMIMIC_PROFILE || 'spike').toLowerCase();
  return p === 'spike' || p === 'cpd881';
}

function resolveSpikePortraitKey() {
  // Spike path always uses bobbyg_studio — ignore Doppler ECHOMIMIC_IMAGE_KEY drift.
  if (process.env.ECHOMIMIC_SPIKE_IMAGE_KEY) return process.env.ECHOMIMIC_SPIKE_IMAGE_KEY;
  return SPIKE_PORTRAIT_KEY;
}

module.exports = {
  SPIKE_PROMPT,
  SPIKE_NEGATIVE_PROMPT,
  SPIKE_PORTRAIT_KEY,
  SPIKE_INFERENCE,
  SPIKE_STEPS,
  SPIKE_SAMPLE_SIZE,
  SPIKE_MAX_FRAMES,
  GATE2_LINES,
  GATE2_PASS_BROADCAST_READY,
  spikeProfileActive,
  resolveSpikePortraitKey
};
