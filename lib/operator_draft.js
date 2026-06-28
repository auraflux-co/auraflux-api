'use strict';

const { getDb } = require('./db');

const DEFAULT_DRAFT_ID = 'c0';

function ensureTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS operator_drafts (
      id         TEXT PRIMARY KEY,
      payload    JSON    NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function getOperatorDraft(draftId = DEFAULT_DRAFT_ID) {
  ensureTable();
  const row = getDb()
    .prepare('SELECT payload, updated_at FROM operator_drafts WHERE id = ?')
    .get(draftId);
  if (!row) return { ok: true, draft: null, updatedAt: null };
  let draft = null;
  try {
    draft = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  } catch (_e) {
    draft = null;
  }
  return { ok: true, draft, updatedAt: row.updated_at };
}

function saveOperatorDraft(payload, draftId = DEFAULT_DRAFT_ID) {
  ensureTable();
  const now = Date.now();
  getDb()
    .prepare(`
      INSERT INTO operator_drafts (id, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `)
    .run(draftId, JSON.stringify(payload || {}), now);
  return { ok: true, updatedAt: now };
}

module.exports = {
  DEFAULT_DRAFT_ID,
  getOperatorDraft,
  saveOperatorDraft,
};
