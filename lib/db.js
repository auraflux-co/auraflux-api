'use strict';
/**
 * lib/db.js — Database adapter (PostgreSQL only)
 *
 * All persistence now uses PostgreSQL via lib/db/postgres.js.
 * SQLite (better-sqlite3) has been removed.
 *
 * Every function exported here is async. Call sites must await reads;
 * writes may be fire-and-forget with .catch(err => console.error(...)).
 */
module.exports = require('./db/postgres');
