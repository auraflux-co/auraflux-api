'use strict';
/**
 * CPD-1316 — Composer session on disk so the operator dashboard can restore
 * looks saved from another browser (agent session).
 */

const fs = require('fs');
const path = require('path');

const SESSION_PATH = path.join(__dirname, '..', 'data', 'composer_operator_session.json');
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function sessionPath() {
  return SESSION_PATH;
}

function readOperatorComposerSession() {
  try {
    if (!fs.existsSync(SESSION_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
    if (!data || data.version !== 1) return null;
    if (data.savedAt && (Date.now() - Number(data.savedAt)) > MAX_AGE_MS) return null;
    const hasContent = (data.streamers && data.streamers.length)
      || (data.redditThreads && data.redditThreads.length)
      || (data.wireStories && data.wireStories.length)
      || data.vodSegment;
    if (!hasContent) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function writeOperatorComposerSession(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('composer session payload required');
  }
  const next = Object.assign({}, payload, {
    version: 1,
    savedAt: Date.now(),
  });
  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
  fs.writeFileSync(SESSION_PATH, JSON.stringify(next, null, 2));
  return next;
}

function clearOperatorComposerSession() {
  try {
    if (fs.existsSync(SESSION_PATH)) fs.unlinkSync(SESSION_PATH);
  } catch (_) { /* ignore */ }
}

module.exports = {
  SESSION_PATH,
  MAX_AGE_MS,
  sessionPath,
  readOperatorComposerSession,
  writeOperatorComposerSession,
  clearOperatorComposerSession,
};
