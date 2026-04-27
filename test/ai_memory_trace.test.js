'use strict';

const fs = require('fs');
const path = require('path');

const tracePath = path.join(__dirname, '..', 'logs', 'ai_memory_trace.jsonl');

describe('ai_memory_trace', () => {
  const prev = process.env.AI_MEMORY_TRACE_ENABLED;

  beforeEach(() => {
    if (fs.existsSync(tracePath)) fs.unlinkSync(tracePath);
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.AI_MEMORY_TRACE_ENABLED;
    else process.env.AI_MEMORY_TRACE_ENABLED = prev;
  });

  test('does not write when trace is disabled', () => {
    process.env.AI_MEMORY_TRACE_ENABLED = 'false';
    const { captureAIMemoryTrace } = require('../lib/ai_memory_trace');
    const event = captureAIMemoryTrace({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      gate: 'gate1',
      jobId: 'job_disabled',
      stage: 'unit',
      prompt: 'test prompt',
      inputs: { script: 'hello' },
    });
    expect(event).toBeNull();
    expect(fs.existsSync(tracePath)).toBe(false);
  });

  test('writes hash/preview payload when trace is enabled', () => {
    process.env.AI_MEMORY_TRACE_ENABLED = 'true';
    const { captureAIMemoryTrace } = require('../lib/ai_memory_trace');

    const event = captureAIMemoryTrace({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      gate: 'gate3a',
      jobId: 'job_trace_1',
      stage: 'gate3a_early',
      prompt: 'This is a synthetic QA prompt for testing memory capture.',
      inputs: {
        script: '=== INTRO ===\nHello world',
        orderedItemCount: 2,
        sceneHeaders: ['INTRO', 'STORY1_CLIP'],
      },
      metadata: { source: 'unit-test' },
    });

    expect(event).toBeTruthy();
    expect(event.promptLen).toBeGreaterThan(10);
    expect(typeof event.promptHash).toBe('string');
    expect(event.inputs.scriptLen).toBeGreaterThan(5);
    expect(event.inputs.sceneHeadersCount).toBe(2);
    expect(fs.existsSync(tracePath)).toBe(true);

    const rows = fs.readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean);
    expect(rows.length).toBe(1);
    const parsed = JSON.parse(rows[0]);
    expect(parsed.jobId).toBe('job_trace_1');
    expect(parsed.gate).toBe('gate3a');
    expect(parsed.metadata.source).toBe('unit-test');
  });
});
