'use strict';

const fs = require('fs');
const path = require('path');
const {
  runOfflinePromptReplay,
  writePromptReplayReport,
  digestPrompt,
  syntheticNewsScenario,
} = require('../lib/ai_prompt_replay');
const gate1 = require('../lib/gates/gate1');

describe('ai_prompt_replay (offline)', () => {
  test('runOfflinePromptReplay returns Gate 1 + Gate 3a Gemini digests per scenario', () => {
    const report = runOfflinePromptReplay();
    expect(report.scenarios.length).toBeGreaterThanOrEqual(2);
    const news = report.scenarios.find((s) => s.name === 'news_longform');
    expect(news).toBeTruthy();
    expect(news.gate1.promptLen).toBeGreaterThan(500);
    expect(news.gate1.promptHash).toHaveLength(64);
    expect(Object.keys(news.gemini).sort()).toEqual([
      'gate3a_early',
      'gate3a_late',
      'gate3a_middle',
    ]);
    for (const g of Object.values(news.gemini)) {
      expect(g.promptLen).toBeGreaterThan(800);
      expect(g.promptHash).toHaveLength(64);
    }
  });

  test('Gate 1 builder is idempotent for same inputs', () => {
    const { jobSpec, script, gate0 } = syntheticNewsScenario();
    const a = gate1.buildGate1StyleQaPrompt(jobSpec, script, gate0);
    const b = gate1.buildGate1StyleQaPrompt(jobSpec, script, gate0);
    expect(a.qaPrompt).toBe(b.qaPrompt);
  });

  test('writePromptReplayReport writes json and markdown', () => {
    const tmp = path.join(__dirname, '..', 'tmp', `prompt_replay_test_${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    const report = runOfflinePromptReplay();
    const { jsonPath, mdPath } = writePromptReplayReport(report, tmp);
    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.existsSync(mdPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    expect(parsed.scenarios[0].gate1.gate).toBe('gate1');
    const md = fs.readFileSync(mdPath, 'utf8');
    expect(md).toContain('Gemini Gate 1');
    try {
      fs.unlinkSync(jsonPath);
    } catch (_e) {
      /* ignore */
    }
    try {
      fs.unlinkSync(mdPath);
    } catch (_e) {
      /* ignore */
    }
    try {
      fs.rmdirSync(tmp);
    } catch (_e) {
      /* ignore */
    }
  });

  test('digestPrompt is stable for empty string', () => {
    const d = digestPrompt('');
    expect(d.promptLen).toBe(0);
    expect(d.promptHash).toHaveLength(64);
  });
});
