'use strict';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePublishSeoContext,
  resolvePublishContentType,
} = require('../lib/publish_seo_context');
const { buildPublishCopySystemPrompt } = require('../lib/publish');
const { resolveClipCompPublishContentType } = require('../lib/clip_comp');

test('YouTube clip URL → source-video without any Compose preset', () => {
  const ctx = resolvePublishSeoContext({
    contentType: 'twitch-short',
    orderedClipUrls: [{
      pageUrl: 'https://www.youtube.com/watch?v=abc123',
      displayName: 'Nene Royal',
      vodPeakWindow: true,
    }],
    streamers: [{ displayName: 'Nene Royal' }],
  });
  assert.equal(ctx.seoKind, 'source-video');
  assert.equal(ctx.sourcePlatform, 'youtube');
  assert.equal(ctx.sourceVideo, true);
});

test('YouTube-only streamer registry → source-video', () => {
  const ctx = resolvePublishSeoContext({
    contentType: 'twitch-short',
    streamers: ['neneroyal'],
  });
  assert.equal(ctx.sourcePlatform, 'youtube');
  assert.equal(ctx.seoKind, 'source-video');
});

test('resolvePublishContentType returns youtube-short for YouTube sources', () => {
  const ct = resolvePublishContentType({
    jobContentType: 'twitch-short',
    orderedClipUrls: [{ url: 'https://www.youtube.com/watch?v=xyz' }],
  });
  assert.equal(ct, 'youtube-short');
});

test('resolveClipCompPublishContentType uses source signals not preset', () => {
  const ct = resolveClipCompPublishContentType('twitch-short', {
    orderedClipUrls: [{ pageUrl: 'https://www.youtube.com/watch?v=abc' }],
  });
  assert.equal(ct, 'youtube-short');
});

test('source-video Short forbids Twitch stream copy in prompt', () => {
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
      pageUrl: 'https://www.youtube.com/watch?v=abc',
      observation: 'A singer performs on the AGT stage; judges lean forward as the chorus hits.',
    }],
  };
  const seoContext = resolvePublishSeoContext({
    contentType: 'youtube-short',
    clipCompBrief,
    orderedClipUrls: [{ pageUrl: 'https://www.youtube.com/watch?v=abc' }],
  });
  const out = buildPublishCopySystemPrompt({
    cc,
    cd: 'YouTube Short featuring Nene Royal',
    date: 'today',
    isShort: true,
    scriptExcerpt: 'GEMINI CREATIVE BRIEF...',
    contentType: 'youtube',
    clipCompBrief,
    seoContext,
  });
  assert.match(out, /NOT TWITCH/);
  assert.match(out, /GEMINI VIDEO OBSERVATIONS/);
  assert.match(out, /AGT stage/);
  assert.doesNotMatch(out, /TWITCH CLIP COMP YOUTUBE TITLE RULES/);
});
