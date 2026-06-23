'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  loadHookPlaybook,
  buildPlaybookPromptBlock,
  buildPlaybookQaChecklist,
} = require('../lib/hook_training/playbook');
const { HOOK_MASTER_SOURCES, PASS_FOCUS } = require('../lib/hook_training/sources');
const { buildHookMachinePrompt } = require('../lib/clip_hook_machine');

test('loadHookPlaybook returns psychology and formulas', () => {
  const pb = loadHookPlaybook();
  assert.ok(pb.psychology.length >= 3);
  assert.ok(pb.formulas.length >= 3);
  assert.ok(pb.antiPatterns.length >= 2);
});

test('buildPlaybookPromptBlock includes formulas and psychology', () => {
  const block = buildPlaybookPromptBlock();
  assert.match(block, /HOOK MASTER PLAYBOOK/);
  assert.match(block, /Contrarian|Curiosity|Pattern interrupt/i);
});

test('buildHookMachinePrompt includes playbook block', () => {
  const prompt = buildHookMachinePrompt(
    { streamer: 'Test', title: 'clip title' },
    'Three friends read a height DM and laugh on the couch while one covers his face.',
  );
  assert.match(prompt, /HOOK MASTER PLAYBOOK/);
  assert.match(prompt, /3-SECOND RULE/);
});

test('buildPlaybookQaChecklist adds mute-first check', () => {
  const checklist = buildPlaybookQaChecklist();
  assert.match(checklist, /mute-first/i);
});

test('HOOK_MASTER_SOURCES lists 7 references', () => {
  assert.equal(HOOK_MASTER_SOURCES.length, 7);
  assert.equal(PASS_FOCUS.length, 5);
});
