'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, '../data/test_operator_draft.db');

describe('operator draft lineup', () => {
  before(() => {
    process.env.CWN_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    require('../lib/db').initDb();
  });

  after(() => {
    require('../lib/db').closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    delete process.env.CWN_DB_PATH;
  });

  it('save and load draft payload', () => {
    const { saveOperatorDraft, getOperatorDraft } = require('../lib/operator_draft');
    const draft = {
      version: 1,
      clipCount: 2,
      twitchPickerStreamers: [{ name: 'lacy', clips: [{ url: 'https://clips.twitch.tv/A', selected: true }] }],
    };
    const saved = saveOperatorDraft(draft);
    assert.ok(saved.ok);
    assert.ok(saved.updatedAt > 0);
    const loaded = getOperatorDraft();
    assert.equal(loaded.draft.clipCount, 2);
    assert.equal(loaded.draft.twitchPickerStreamers[0].name, 'lacy');
  });
});
