'use strict';

/**
 * vidIQ MCP adapter — read-only YouTube/Instagram intelligence via https://mcp.vidiq.com/mcp
 * Credential only: VIDIQ_MCP_API_KEY (Bearer). Does not use YouTube Data API quota.
 */

const DEFAULT_MCP_URL = 'https://mcp.vidiq.com/mcp';

function parseSseJson(text) {
  const lines = String(text || '').split('\n');
  let lastPayload = null;
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = JSON.parse(line.slice(6));
    lastPayload = payload;
    if (payload.error) {
      const msg = payload.error.message || JSON.stringify(payload.error);
      throw new Error(msg);
    }
  }
  if (!lastPayload || lastPayload.result === undefined) {
    throw new Error('No SSE data in MCP response');
  }
  return lastPayload.result;
}

function normalizeToolResult(result) {
  if (!result) return null;
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const texts = (result.content || [])
    .filter((c) => c && c.type === 'text' && c.text)
    .map((c) => c.text);
  for (const t of texts) {
    try {
      return JSON.parse(t);
    } catch (_) { /* try next */ }
  }
  return { raw: texts.join('\n'), content: result.content || [] };
}

async function mcpRequest(method, params = {}, opts = {}) {
  const apiKey = opts.apiKey || process.env.VIDIQ_MCP_API_KEY;
  if (!apiKey) throw new Error('VIDIQ_MCP_API_KEY not set');
  const url = opts.url || DEFAULT_MCP_URL;
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: opts.id || Date.now(),
      method,
      params,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`vidIQ MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return parseSseJson(text);
}

async function listTools(opts = {}) {
  const result = await mcpRequest('tools/list', {}, opts);
  return result?.tools || [];
}

async function callTool(name, args = {}, opts = {}) {
  const result = await mcpRequest('tools/call', { name, arguments: args }, opts);
  return normalizeToolResult(result);
}

async function getCreditsBalance(opts = {}) {
  return callTool('vidiq_balance', {}, opts);
}

function isConfigured() {
  return !!String(process.env.VIDIQ_MCP_API_KEY || '').trim();
}

module.exports = {
  DEFAULT_MCP_URL,
  parseSseJson,
  normalizeToolResult,
  mcpRequest,
  listTools,
  callTool,
  getCreditsBalance,
  isConfigured,
};
