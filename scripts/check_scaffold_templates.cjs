#!/usr/bin/env node
'use strict';

const { createJobSpec } = require('../lib/job_spec');
const gate1 = require('../lib/gates/gate1');

function sampleItemsFor(contentType) {
  if (contentType === 'news' || contentType === 'news-short') {
    return [
      { title: 'Story A', description: 'A', videoUrl: 'https://example.com/a.mp4' },
      { title: 'Story B', description: 'B', videoUrl: 'https://example.com/b.mp4' },
      { title: 'Story C', description: 'C', videoUrl: 'https://example.com/c.mp4' }
    ];
  }
  if (contentType === 'twitch' || contentType === 'twitch-short') {
    return [
      { displayName: 'Jason', streamer: 'jasontheween', clipUrl: 'https://example.com/j.mp4' },
      { displayName: 'Maya', streamer: 'maya', clipUrl: 'https://example.com/m.mp4' }
    ];
  }
  if (contentType === 'nba' || contentType === 'nba-short') {
    return [
      { away: 'Los Angeles Lakers', home: 'Boston Celtics', clipUrl: 'https://example.com/lal-bos.mp4' },
      { away: 'New York Knicks', home: 'Miami Heat', clipUrl: 'https://example.com/nyk-mia.mp4' }
    ];
  }
  return [{ title: 'Item A', clipUrl: 'https://example.com/a.mp4' }];
}

function summarize(result) {
  return {
    contentType: result.contentType,
    ok: result.ok,
    expectedScenes: result.expectedScenes,
    foundScenes: result.foundScenes,
    expectedClips: result.expectedClips,
    hasFakeHeader: result.hasFakeHeader,
    issues: result.issues
  };
}

function runForType(contentType) {
  const items = sampleItemsFor(contentType);
  const jobSpec = createJobSpec({
    customerId: 'c0',
    contentType,
    items
  });
  const scaffold = jobSpec?.designSpec?.sceneStructure?.scaffold || '';
  if (!scaffold) {
    return {
      contentType,
      ok: false,
      expectedScenes: 0,
      foundScenes: 0,
      expectedClips: 0,
      hasFakeHeader: false,
      issues: ['scaffold missing from job spec']
    };
  }
  const check = gate1.__test_validateStructureAgainstJobSpec(scaffold, jobSpec);
  const expectedHeaders = gate1.__test_expectedSceneHeaders(jobSpec);
  const hasFakeHeader = expectedHeaders.includes('HEADER');
  return {
    contentType,
    ok: check.issues.length === 0 && !hasFakeHeader,
    expectedScenes: expectedHeaders.length,
    foundScenes: check.foundHeaders.length,
    expectedClips: check.expectedClipCount,
    hasFakeHeader,
    issues: check.issues
  };
}

function main() {
  const types = ['news', 'news-short', 'twitch', 'twitch-short', 'nba', 'nba-short'];
  const results = types.map(runForType);
  const failed = results.filter((r) => !r.ok);

  console.log('Scaffold -> Gate1 structure audit');
  for (const r of results) {
    console.log(JSON.stringify(summarize(r)));
  }

  if (failed.length > 0) {
    console.error('\nFAIL: one or more content types have scaffold/contract mismatches.');
    process.exit(1);
  }
  console.log('\nPASS: all scaffold templates satisfy Gate 1 structure contract.');
}

main();
