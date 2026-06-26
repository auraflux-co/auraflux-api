'use strict';
/**
 * Streamer Content Library (CPD-1098).
 * HOW: https://aurafluxco.atlassian.net/wiki/spaces/CP/pages/38928386
 */

const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = 7;
const DEFAULT_ROSTER_PATH = path.join(__dirname, '../../config/content_library_roster.json');

function loadRoster(rosterPath = process.env.CONTENT_LIBRARY_ROSTER || DEFAULT_ROSTER_PATH) {
  const raw = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
  const list = raw.streamers || [];
  return list.map((s) => ({
    login: String(s.login || '').toLowerCase(),
    displayName: s.displayName || s.login,
    platform: s.platform || 'twitch',
    handle: s.handle || null,
  })).filter((s) => s.login);
}

module.exports = {
  RETENTION_DAYS,
  DEFAULT_ROSTER_PATH,
  loadRoster,
};
