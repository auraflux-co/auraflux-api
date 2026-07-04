const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeChapterBlock,
  extractChaptersFromDescription,
  mergeChaptersIntoYoutubeDescription,
  applyChaptersToPublishCopy,
  resolveChaptersForJob,
} = require('../lib/youtube_chapters');

test('normalizeChapterBlock keeps timestamp lines only', () => {
  const raw = '0:00 Intro\n\n2:04 Cinna\nnoise\n3:44 ExtraEmily';
  assert.equal(normalizeChapterBlock(raw), '0:00 Intro\n2:04 Cinna\n3:44 ExtraEmily');
});

test('mergeChaptersIntoYoutubeDescription appends CHAPTERS block', () => {
  const desc = 'Welcome to Twitch Soup.\n\nSubscribe!';
  const merged = mergeChaptersIntoYoutubeDescription(desc, '0:00 Intro\n2:04 Cinna');
  assert.match(merged, /CHAPTERS:\n0:00 Intro\n2:04 Cinna/);
  assert.match(merged, /^Welcome to Twitch Soup/);
});

test('merge replaces existing CHAPTERS block', () => {
  const desc = 'Hook\n\nCHAPTERS:\n0:00 Old\n\nFooter';
  const merged = mergeChaptersIntoYoutubeDescription(desc, '0:00 Intro\n5:00 Cinna');
  assert.doesNotMatch(merged, /0:00 Old/);
  assert.match(merged, /0:00 Intro\n5:00 Cinna/);
});

test('extractChaptersFromDescription reads CHAPTERS block', () => {
  const desc = 'Intro text\n\nCHAPTERS:\n0:00 Intro\n2:04 Cinna\n\nSubscribe';
  assert.equal(extractChaptersFromDescription(desc), '0:00 Intro\n2:04 Cinna');
});

test('applyChaptersToPublishCopy updates youtube fields', () => {
  const pc = { youtube: { description: 'Show hook', title: 'Ep4' } };
  const out = applyChaptersToPublishCopy(pc, '0:00 Intro\n2:04 Cinna');
  assert.equal(out.youtube.chapters, '0:00 Intro\n2:04 Cinna');
  assert.match(out.youtube.description, /CHAPTERS:/);
});

test('resolveChaptersForJob prefers publishCopy.youtube.chapters', () => {
  const job = {
    publishCopy: { youtube: { chapters: '0:00 Intro\n1:00 Part 2' } },
    manualChapters: '0:00 Other',
  };
  assert.equal(resolveChaptersForJob(job), '0:00 Intro\n1:00 Part 2');
});

test('computeChaptersFromAssemblyGroups reads group MP4s', () => {
  const asmId = 'asm_script_twitch_1782857743249_r34';
  const { computeChaptersFromAssemblyGroups } = require('../lib/youtube_chapters');
  const r = computeChaptersFromAssemblyGroups({ assemblyId: asmId });
  assert.ok(r.chapters.includes('0:00 Intro'));
  assert.ok(r.bodySec > 400);
  assert.match(r.chapters, /Cinna/);
});
