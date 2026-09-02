'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'cwn_production.html'), 'utf8');

describe('library import source mode', () => {
  it('does not call setLibrarySourceMode with generate pillars', () => {
    assert.ok(!/setLibrarySourceMode\(\s*['"]twitch['"]\s*\)/.test(html));
    assert.ok(!/setLibrarySourceMode\(\s*['"]sports['"]\s*\)/.test(html));
    assert.ok(!/setLibrarySourceMode\(\s*['"]news['"]\s*\)/.test(html));
  });

  it('guards invalid library modes back to streamers', () => {
    assert.ok(html.includes("mode !== 'streamers' && mode !== 'reddit' && mode !== 'wire'"));
    assert.ok(html.includes("setLibrarySourceMode('streamers')"));
  });

  it('keeps imports on library (nav library) before COMPOSE', () => {
    const fnStart = html.indexOf('function openStagedImportInComposer');
    const fnEnd = html.indexOf('function importLocalMp4ToCompose');
    assert.ok(fnStart > 0 && fnEnd > fnStart);
    const body = html.slice(fnStart, fnEnd);
    assert.ok(body.includes("nav('library')"));
    assert.ok(!/nav\(\s*['"]generate['"]\s*\)/.test(body));
  });
});
