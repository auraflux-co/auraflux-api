'use strict';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolvePublishSeoContext } = require('../lib/publish_seo_context');
const { buildPublishCopySystemPrompt } = require('../lib/publish');

test('reaction_short preset → reaction seo kind', () => {
  const ctx = resolvePublishSeoContext({
    contentType: 'twitch-short',
    compCreative: { preset: 'reaction_short' },
    streamers: [{ displayName: 'Nene Royal' }],
  });
  assert.equal(ctx.seoKind, 'reaction');
  assert.equal(ctx.isReactionShort, true);
});

test('YouTube-only clip URLs → reaction without twitch', () => {
  const ctx = resolvePublishSeoContext({
    contentType: 'twitch-short',
    clipCompBrief: {
      leadStreamer: 'Nene Royal',
      clips: [{
        platform: 'youtube',
        pageUrl: 'https://www.youtube.com/watch?v=abc123',
        observation: 'She performs an emotional ballad on stage under golden lights while the crowd reacts.',
      }],
    },
  });
  assert.equal(ctx.sourcePlatform, 'youtube');
  assert.equal(ctx.seoKind, 'reaction');
  assert.equal(ctx.hasGeminiObservations, true);
});

test('reaction Short forbids Twitch stream copy and includes Gemini observations', () => {
  const cc = {
    showName: 'Twitch Soup',
    handle: '@clipzworldnews',
    host: 'Bobby G',
    youtubeUrl: 'https://www.youtube.com/@clipzworldnews',
    tiktokUrl: 'https://www.tiktok.com/@clipzworldstreams',
    instagramUrl: 'https://www.instagram.com/clipzworldnews/',
  };
  const clipCompBrief = {
    leadStreamer: 'Nene Royal',
    leadTitleDraft: "Nene Royal's AGT Moment Stuns Judges",
    clips: [{
      platform: 'youtube',
      observation: 'A singer performs on the AGT stage; judges lean forward as the chorus hits.',
      hook: 'Wait For It',
    }],
  };
  const seoContext = resolvePublishSeoContext({
    contentType: 'reaction-short',
    compCreative: { preset: 'reaction_short' },
    clipCompBrief,
  });
  const out = buildPublishCopySystemPrompt({
    cc,
    cd: 'Reaction Short featuring Nene Royal',
    date: 'today',
    isShort: true,
    scriptExcerpt: 'GEMINI CREATIVE BRIEF...',
    contentType: 'reaction',
    clipCompBrief,
    compCreative: { preset: 'reaction_short' },
    seoContext,
  });
  assert.match(out, /NOT TWITCH/);
  assert.match(out, /GEMINI VIDEO OBSERVATIONS/);
  assert.match(out, /AGT stage/);
  assert.doesNotMatch(out, /TWITCH CLIP COMP YOUTUBE TITLE RULES/);
});
