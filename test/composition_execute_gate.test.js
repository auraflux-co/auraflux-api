'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isComposerPreviewTrusted, canComposerExecute } = require('../lib/composition_execute_gate');

describe('composition_execute_gate', () => {
  it('trusts ffmpeg and assembled previews only', () => {
    assert.equal(isComposerPreviewTrusted('ffmpeg'), true);
    assert.equal(isComposerPreviewTrusted('assembled'), true);
    assert.equal(isComposerPreviewTrusted('mock'), false);
    assert.equal(isComposerPreviewTrusted('loading'), false);
  });

  it('blocks EXECUTE on mock preview', () => {
    const r = canComposerExecute({ validationOk: true, previewMode: 'mock' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /mock/i.test(e)));
  });

  it('allows EXECUTE when validated + ffmpeg preview', () => {
    const r = canComposerExecute({ validationOk: true, previewMode: 'ffmpeg' });
    assert.equal(r.ok, true);
  });

  it('allows layout editor reassemble without preview trust', () => {
    const r = canComposerExecute({ validationOk: false, previewMode: 'mock', layoutEditorMode: true });
    assert.equal(r.ok, true);
  });
});
