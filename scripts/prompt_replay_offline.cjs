#!/usr/bin/env node
'use strict';

/**
 * Offline prompt replay: writes JSON + Markdown digests of Claude (Gate 1) and
 * Gemini (Gate 3a) user prompts — no API keys or network required.
 *
 * Usage: node scripts/prompt_replay_offline.cjs
 */

const path = require('path');
const { runOfflinePromptReplay, writePromptReplayReport } = require('../lib/ai_prompt_replay');

const outDir = path.join(__dirname, '..', 'output');
const report = runOfflinePromptReplay();
const { jsonPath, mdPath } = writePromptReplayReport(report, outDir);

console.log(`[prompt-replay-offline] Wrote:\n  ${jsonPath}\n  ${mdPath}`);
