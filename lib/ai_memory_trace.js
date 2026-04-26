'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRACE_DIR = path.join(__dirname, '..', 'logs');
const TRACE_FILE = path.join(TRACE_DIR, 'ai_memory_trace.jsonl');

function traceEnabled() {
  return String(process.env.AI_MEMORY_TRACE_ENABLED || '').toLowerCase() === 'true';
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function redactLarge(value, maxLen = 240) {
  const s = String(value == null ? '' : value);
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}...[truncated ${s.length - maxLen} chars]`;
}

function summarizeInputs(inputs) {
  if (!inputs || typeof inputs !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (v == null) {
      out[k] = v;
    } else if (typeof v === 'string') {
      out[`${k}Len`] = v.length;
      out[`${k}Hash`] = hashText(v);
      out[`${k}Preview`] = redactLarge(v, 160);
    } else if (Array.isArray(v)) {
      out[`${k}Count`] = v.length;
      out[k] = v.slice(0, 8);
    } else if (typeof v === 'object') {
      out[k] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function writeTrace(event) {
  try {
    if (!fs.existsSync(TRACE_DIR)) fs.mkdirSync(TRACE_DIR, { recursive: true });
    fs.appendFileSync(TRACE_FILE, `${JSON.stringify(event)}\n`, 'utf8');
  } catch (_e) {
    // Non-fatal: tracing must never block pipeline execution.
  }
}

function captureAIMemoryTrace({
  provider,
  model,
  gate,
  jobId,
  stage,
  prompt,
  inputs,
  metadata
}) {
  if (!traceEnabled()) return null;
  const promptText = String(prompt || '');
  const event = {
    ts: new Date().toISOString(),
    provider: provider || 'unknown',
    model: model || 'unknown',
    gate: gate || null,
    jobId: jobId || 'unknown',
    stage: stage || 'unknown',
    promptLen: promptText.length,
    promptHash: hashText(promptText),
    promptPreview: redactLarge(promptText, 500),
    inputs: summarizeInputs(inputs),
    metadata: metadata || {}
  };
  writeTrace(event);
  return event;
}

module.exports = {
  captureAIMemoryTrace,
  traceEnabled,
  hashText
};

