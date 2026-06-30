'use strict';

/**
 * Dashboard refresh buttons — handler registry + API smoke tests.
 * Run: node --test test/dashboard_refresh_audit.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');

/** Buttons wired in cwn_production.html — handler must exist on window at runtime. */
const REFRESH_BUTTONS = [
  { page: 'Generate', label: 'Sports categories', handler: 'loadSportsCategories', args: 'true' },
  { page: 'Generate', label: 'Composer preview', handler: 'refreshGenerateComposer', args: 'true' },
  { page: 'Generate', label: 'Scene list', handler: 'refreshSceneOrderPanel', args: '' },
  { page: 'Broadcast', label: 'Refresh all', handler: 'broadcastRefreshAll', args: '' },
  { page: 'Broadcast', label: 'Live show pack', handler: 'liveShowPackRefresh', args: '' },
  { page: 'Broadcast', label: 'Grid fleet', handler: 'liveGridRefresh', args: '' },
  { page: 'Broadcast', label: 'Encoder refresh', handler: 'liveGridMasterRefresh', args: '' },
  { page: 'Broadcast', label: 'YouTube SEO', handler: 'liveGridRefreshLiveSeo', args: '' },
  { page: 'Broadcast', label: 'Prepared SEO', handler: 'liveGridRefreshPrepared', args: '' },
  { page: 'Post-live', label: 'Episodes', handler: 'postLiveLoadPublishedJobs', args: '' },
  { page: 'Post-live', label: 'Lives', handler: 'postLiveLoadVods', args: 'true' },
  { page: 'Stats', label: 'Channel stats', handler: 'loadChannelStats', args: 'true' },
  { page: 'Queue', label: 'Status', handler: 'refreshQueue', args: '' },
  { page: 'Calendar', label: 'Month plan', handler: 'calendarRefresh', args: 'true' },
];

function httpGet(urlPath, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:3000${urlPath}`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

describe('dashboard refresh audit', () => {
  it('every refresh button onclick target is declared in dashboard JS', () => {
    const html = fs.readFileSync(path.join(ROOT, 'cwn_production.html'), 'utf8');
    const jsFiles = [
      'cwn_production.html',
      'assets/calendar_dashboard.js',
      'assets/broadcast_dashboard.js',
    ].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

    for (const btn of REFRESH_BUTTONS) {
      const pattern = new RegExp(`(function ${btn.handler}|window\\.${btn.handler}\\s*=)`);
      assert.match(jsFiles, pattern, `${btn.page} "${btn.label}" → ${btn.handler}() not defined`);
      const onclickNeedle = btn.args
        ? `${btn.handler}(${btn.args})`
        : `${btn.handler}()`;
      if (btn.handler !== 'broadcastRefreshAll') {
        assert.ok(html.includes(onclickNeedle) || html.includes(`${btn.handler}(`),
          `HTML missing onclick for ${btn.handler}`);
      }
    }
  });

  it('refresh API endpoints respond (localhost)', async () => {
    const fast = [
      '/jobs?restore=1',
      '/live-show/rundown',
      '/live-grid/status',
      '/post-live/published-jobs?limit=3',
      '/calendar/month?year=2026&month=6',
    ];
    for (const ep of fast) {
      const res = await httpGet(ep, 30_000);
      assert.equal(res.status, 200, `${ep} HTTP ${res.status}`);
      const json = JSON.parse(res.body);
      assert.notEqual(json.ok, false, `${ep} returned ok:false`);
    }
  });

  it('slow refresh endpoints respond within budget (optional)', { timeout: 180_000 }, async () => {
    const slow = [
      '/calendar/month?year=2026&month=6&refreshYoutube=1&refresh=1',
      '/post-live/vods?limit=3',
    ];
    for (const ep of slow) {
      const res = await httpGet(ep, 120_000);
      assert.equal(res.status, 200, `${ep} HTTP ${res.status}`);
      const json = JSON.parse(res.body);
      assert.notEqual(json.ok, false, `${ep} returned ok:false`);
    }
  });
});
