'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Mirror of normalizeOutboundSmsNumber in admin_seed.js (keep in sync)
function normalizeOutboundSmsNumber(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (raw.startsWith('+')) {
    const digits = raw.replace(/\D/g, '');
    return digits ? `+${digits}` : null;
  }
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

test('normalizeOutboundSmsNumber handles US 10-digit and E.164', () => {
  assert.equal(normalizeOutboundSmsNumber('5714208749'), '+15714208749');
  assert.equal(normalizeOutboundSmsNumber('+1 (571) 420-8749'), '+15714208749');
  assert.equal(normalizeOutboundSmsNumber('15714208749'), '+15714208749');
  assert.equal(normalizeOutboundSmsNumber(''), null);
});
