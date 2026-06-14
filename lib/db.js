'use strict';
/**
 * lib/db.js — Database adapter (PostgreSQL only)
 *
 * All persistence uses PostgreSQL via lib/db/postgres.js.
 * Every function exported here is async. Call sites must await reads;
 * writes may be fire-and-forget with .catch(err => console.error(...)).
 */
module.exports = require('./db/postgres');
