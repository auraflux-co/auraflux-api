'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSseJson,
  normalizeToolResult,
} = require('../lib/intelligence/adapters/vidiq_mcp');
const { listScenarios, runScenario } = require('../lib/intelligence/vidiq_compare');

describe('vidiq_mcp adapter', () => {
  it('parses SSE JSON-RPC payload', () => {
    const text = 'event: message\ndata: {"result":{"score":88},"jsonrpc":"2.0","id":1}\n\n';
    assert.deepEqual(parseSseJson(text), { score: 88 });
  });

  it('normalizes structuredContent from tool result', () => {
    const out = normalizeToolResult({
      structuredContent: { score: 77 },
      content: [{ type: 'text', text: '{"score":77}' }],
    });
    assert.equal(out.score, 77);
  });

  it('parses JSON from text content fallback', () => {
    const out = normalizeToolResult({
      content: [{ type: 'text', text: '{"totalCredits":10}' }],
    });
    assert.equal(out.totalCredits, 10);
  });
});

describe('vidiq_compare', () => {
  it('lists benchmark scenarios', () => {
    const scenarios = listScenarios();
    assert.ok(scenarios.length >= 4);
    assert.ok(scenarios.some((s) => s.id === 'optimize_title'));
  });

  it('runs C0 side without vidIQ key', async () => {
    const prev = process.env.VIDIQ_MCP_API_KEY;
    delete process.env.VIDIQ_MCP_API_KEY;
    try {
      const row = await runScenario('optimize_title', {
        title: 'Test Short Title For Benchmark',
        type: 'short',
      });
      assert.equal(row.scenarioId, 'optimize_title');
      assert.ok(row.c0 && row.c0.score >= 0);
      assert.ok(row.notes.some((n) => n.includes('VIDIQ')));
    } finally {
      if (prev) process.env.VIDIQ_MCP_API_KEY = prev;
    }
  });
});
