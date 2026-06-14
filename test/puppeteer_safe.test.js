'use strict';

const {
  assertNumericGameId,
  resolveAllowedHtmlTemplate,
  localFileUrl,
} = require('../lib/puppeteer_safe');
const path = require('path');

describe('puppeteer_safe', () => {
  test('assertNumericGameId accepts ESPN-style IDs', () => {
    expect(assertNumericGameId('401584893')).toBe('401584893');
    expect(assertNumericGameId('abc')).toBeNull();
    expect(assertNumericGameId('12')).toBeNull();
  });

  test('resolveAllowedHtmlTemplate blocks path escape', () => {
    const dir = path.join(__dirname, '..', 'templates');
    expect(() => resolveAllowedHtmlTemplate('../server.js', dir)).toThrow(/outside allowed/);
  });

  test('localFileUrl uses file scheme only', () => {
    const p = path.join('/tmp', 'foo.html');
    expect(localFileUrl(p)).toBe('file:///tmp/foo.html');
  });
});
