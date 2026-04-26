'use strict';

describe('readAutoPublishPlatformsEnv', () => {
  const { readAutoPublishPlatformsEnv } = require('../lib/auto_publish_env');

  const orig = process.env.AUTO_PUBLISH_PLATFORMS;

  afterEach(() => {
    if (orig === undefined) delete process.env.AUTO_PUBLISH_PLATFORMS;
    else process.env.AUTO_PUBLISH_PLATFORMS = orig;
  });

  test('returns null when env unset', () => {
    delete process.env.AUTO_PUBLISH_PLATFORMS;
    expect(readAutoPublishPlatformsEnv()).toBeNull();
  });

  test('none → empty array', () => {
    process.env.AUTO_PUBLISH_PLATFORMS = 'none';
    expect(readAutoPublishPlatformsEnv()).toEqual([]);
  });

  test('comma list', () => {
    process.env.AUTO_PUBLISH_PLATFORMS = ' youtube , tiktok ';
    expect(readAutoPublishPlatformsEnv()).toEqual(['youtube', 'tiktok']);
  });
});
