'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_VOICE_PATH = path.join(__dirname, '../../config/clipzworld_hook_voice.json');

function loadChannelVoice(voicePath = process.env.CLIPZWORLD_HOOK_VOICE_PATH || DEFAULT_VOICE_PATH) {
  try {
    const raw = fs.readFileSync(voicePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      channel: parsed.channel || 'ClipzWorld News',
      niche: parsed.niche || '',
      audience: parsed.audience || '',
      platform: parsed.platform || 'YouTube Shorts',
      brandVoice: Array.isArray(parsed.brandVoice) ? parsed.brandVoice : [],
      never: Array.isArray(parsed.never) ? parsed.never : [],
      approvedExamples: Array.isArray(parsed.approvedExamples) ? parsed.approvedExamples : [],
      rejectedExamples: Array.isArray(parsed.rejectedExamples) ? parsed.rejectedExamples : [],
    };
  } catch (_) {
    return {
      channel: 'ClipzWorld News',
      niche: 'Twitch clip Shorts',
      audience: 'Shorts scrollers',
      platform: 'YouTube Shorts burned text',
      brandVoice: ['Specific curiosity gap, TV-clean, no streamer name'],
      never: ['Generic chaos filler', 'Outcome spoilers'],
      approvedExamples: [],
      rejectedExamples: [],
    };
  }
}

function buildChannelVoiceBlock(voice = null) {
  const v = voice || loadChannelVoice();
  const lines = [
    'CLIPZWORLD CHANNEL BLOCK (Shorts burned hooks — fill every candidate against this):',
    `Channel: ${v.channel}`,
    `Niche: ${v.niche}`,
    `Audience: ${v.audience}`,
    `Platform: ${v.platform}`,
    'Brand voice:',
    ...v.brandVoice.map((b) => `- ${b}`),
    'Never:',
    ...v.never.map((n) => `- ${n}`),
  ];
  if (v.approvedExamples.length) {
    lines.push('Approved on-channel energy (match structure, not exact words):');
    v.approvedExamples.slice(0, 6).forEach((ex, i) => {
      const tag = ex.formula ? `[${ex.formula}] ` : '';
      lines.push(`${i + 1}. ${tag}"${ex.hook}" — ${ex.why || 'strong'}`);
    });
  }
  if (v.rejectedExamples.length) {
    lines.push('Rejected patterns (do NOT mimic):');
    v.rejectedExamples.slice(0, 4).forEach((ex) => {
      lines.push(`- "${ex.hook}" — ${ex.why || 'weak'}`);
    });
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_VOICE_PATH,
  loadChannelVoice,
  buildChannelVoiceBlock,
};
