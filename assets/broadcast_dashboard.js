/**
 * Broadcast Control Center — CPD-1026/1027/1028
 * Requires liveGrid* / liveTv* helpers from cwn_production.html
 */
(function () {
  const BC_BASE = (typeof CFG !== 'undefined' && CFG.ffmpegUrl) || 'http://localhost:3000';
  let _bcOps = null;
  let _bcProgram = null;
  let _bcSched = null;
  let _bcAnalytics = null;
  let _bcAllowlist = null;
  let _bcFiles = null;
  let _bcDiscovery = { merged: null, follows: null };
  let _bcPoll = null;

  function g(id) { return document.getElementById(id); }

  function fmtWindow(w) {
    if (!w) return 'off';
    const f = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return `${f(w.start)}–${f(w.end)} ET`;
  }

  function fmtHour(h) {
    if (h === 0) return '12am';
    if (h < 12) return `${h}am`;
    if (h === 12) return '12pm';
    return `${h - 12}pm`;
  }

  async function bcFetch(path, opts) {
    const r = await fetch(BC_BASE + path, opts);
    return r.json();
  }

  async function broadcastRefreshOps() {
    try { _bcOps = await bcFetch('/broadcast/ops'); } catch (_) { _bcOps = null; }
    renderOpsBar();
  }

  async function broadcastRefreshProgram() {
    try { _bcProgram = await bcFetch('/live-grid/program/status'); } catch (_) { _bcProgram = null; }
    renderProgramPanel();
    renderScheduleTimeline();
  }

  async function broadcastRefreshScheduler() {
    try { _bcSched = await bcFetch('/stream-scheduler/status'); } catch (_) { _bcSched = null; }
    renderSchedulerCard();
  }

  async function broadcastRefreshAnalytics() {
    const el = g('bc-analytics-body');
    if (!el) return;
    el.innerHTML = '<div style="color:rgba(255,255,255,0.35);font-size:11px;">Loading analytics…</div>';
    try {
      const days = Number(g('bc-analytics-days')?.value) || 14;
      _bcAnalytics = await bcFetch(`/live-grid/analytics/hourly?days=${days}`);
    } catch (_) { _bcAnalytics = null; }
    renderAnalytics();
  }

  async function broadcastRefreshAllowlist() {
    try { _bcAllowlist = await bcFetch('/live-grid/allowlist'); } catch (_) { _bcAllowlist = null; }
    renderAllowlist();
  }

  async function broadcastRefreshFiles() {
    try { _bcFiles = await bcFetch('/live-grid/files'); } catch (_) { _bcFiles = null; }
    populateFileSelects();
  }

  async function broadcastRefreshDiscovery(which) {
    const tab = which || g('bc-bench-tab')?.value || 'merged';
    try {
      if (tab === 'follows') {
        _bcDiscovery.follows = await bcFetch('/live-grid/followed-bench');
      } else {
        _bcDiscovery.merged = await bcFetch('/live-grid/discovery/bench');
      }
    } catch (_) {}
    renderDiscoveryBench();
  }

  function renderOpsBar() {
    const bar = g('bc-ops-bar');
    if (!bar) return;
    const o = _bcOps;
    const s = _lgStatus;
    const tv = _tvStatus;
    const gridLive = !!(s && s.running) || !!(o && o.gridLive);
    const tvLive = !!(tv && tv.running) || !!(o && o.tvLive);
    const jobs = o ? o.activeJobs : '—';
    const safe = o ? o.safeToRestart : true;
    const ver = o?.server?.version || '—';
    const branch = o?.server?.gitBranch || '';

    bar.innerHTML = `
      <div class="bc-ops-grid">
        <span class="bc-ops-chip ${gridLive ? 'bc-live-yt' : ''}">YT Grid: ${gridLive ? '● LIVE' : 'offline'}</span>
        <span class="bc-ops-chip ${tvLive ? 'bc-live-tw' : ''}">Twitch TV: ${tvLive ? '● ON AIR' : 'offline'}</span>
        <span class="bc-ops-chip">Jobs: ${jobs}</span>
        <span class="bc-ops-chip">${o?.assemblyBusy ? '⚠ assembly' : 'Assembly: idle'}</span>
        <span class="bc-ops-chip">Server: v${ver}${branch ? ' · ' + branch : ''}</span>
      </div>
      ${!safe ? `<div class="bc-ops-warn">⚠ ${(o.blockers || []).join(' · ')} — no restart/deploy while live</div>` : ''}
      ${o?.waiter?.okFile ? '<div class="bc-ops-info">24h test armed — waiter will start when pipeline idle</div>' : ''}`;
  }

  function renderProgramPanel() {
    const el = g('bc-on-air');
    if (!el) return;
    const p = _bcProgram;
    const s = _lgStatus;
    if (!p) { el.textContent = '—'; return; }

    const layout = (s && s.program && s.program.layout) || p.layout;
    const active = p.activeMode || p.scheduledMode || '—';
    const sched = p.scheduledMode || '—';
    const ev = layout?.activeEvent || p.layout?.activeEvent;

    let quads = '';
    if (layout && layout.sources) {
      layout.sources.forEach((src, i) => {
        let label = 'SLATE';
        if (typeof src === 'string') label = src.toUpperCase();
        else if (src && src.type === 'file') label = (src.label || 'FILE') + ': ' + (src.path || '').split('/').pop();
        quads += `<div class="bc-quad-src"><span>Q${i + 1}</span> ${label}</div>`;
      });
    } else if (s && s.quadrants) {
      s.quadrants.forEach(q => {
        quads += `<div class="bc-quad-src"><span>Q${q.quadrant}</span> ${(q.login || q.kind || 'slate').toString().toUpperCase()}</div>`;
      });
    }

    const files = layout?.filePaths || {};
    const fileLines = Object.entries(files).filter(([, v]) => v)
      .map(([k, v]) => `<div style="font-size:10px;color:rgba(255,255,255,0.45);">${k}: ${String(v).split('/').pop()}</div>`).join('');

    el.innerHTML = `
      <div style="margin-bottom:8px;"><b style="color:#c7af4f;">${active.toUpperCase()}</b>
        <span style="color:rgba(255,255,255,0.4);font-size:11px;"> scheduled: ${sched}${ev ? ' · ' + ev.eventTitle : ''}</span></div>
      ${layout?.title ? `<div style="font-size:12px;margin-bottom:8px;">${layout.title}</div>` : ''}
      <div class="bc-quad-grid">${quads || '<span style="color:rgba(255,255,255,0.3);font-size:11px;">Start grid to see quadrants</span>'}</div>
      ${fileLines}`;
  }

  function renderSchedulerCard() {
    const el = g('bc-scheduler-body');
    if (!el) return;
    const d = _bcSched;
    if (!d || !d.enabled) {
      el.innerHTML = '<div style="font-size:11px;color:rgba(255,255,255,0.4);">Scheduler disabled (STREAM_SCHEDULER=off)</div>';
      return;
    }
    el.innerHTML = (d.streams || []).map(s => {
      const inW = s.inWindow ? '<span style="color:#2ecc71;">● in window</span>' : '<span style="color:rgba(255,255,255,0.35);">○ out</span>';
      const next = s.next ? `${s.next.action} in ~${s.next.inMinutes}m` : '';
      return `<div style="margin-bottom:8px;font-size:12px;">
        <b style="color:#c7af4f;">${s.name}</b> ${fmtWindow(s.window)} ${inW}
        <div style="font-size:10px;color:rgba(255,255,255,0.4);">${next}</div></div>`;
    }).join('');
  }

  function renderScheduleTimeline() {
    const el = g('bc-daypart-timeline');
    if (!el || !_bcProgram) return;
    const blocks = [
      { mode: 'event_night', label: 'Event', start: 18, end: 20 },
      { mode: 'news_desk', label: 'News', start: 20, end: 23 },
      { mode: 'grid', label: 'Grid', start: 23, end: 27 },
    ];
    const mins = _bcProgram.et?.minutes ?? 0;
    el.innerHTML = blocks.map(b => {
      const end = b.end > 24 ? b.end - 24 : b.end;
      const active = b.start <= b.end
        ? (mins >= b.start * 60 && mins < b.end * 60)
        : (mins >= b.start * 60 || mins < end * 60);
      return `<div class="bc-daypart ${active ? 'active' : ''}">${b.label}<br><span>${b.start > 12 ? b.start - 12 + 'pm' : b.start + 'am'}–${b.end === 27 ? '3am' : b.end + 'pm'}</span></div>`;
    }).join('');
  }

  function renderAnalytics() {
    const el = g('bc-analytics-body');
    if (!el) return;
    const d = _bcAnalytics;
    if (!d || !d.ok) {
      el.innerHTML = `<div style="color:#e88;font-size:11px;">${d?.error || 'YouTube analytics unavailable — connect at /connect/youtube'}</div>`;
      return;
    }
    const buckets = d.hourly || [];
    const max = Math.max(1, ...buckets.map(b => b.estimatedMinutesWatched || b.views || 0));
    const bars = buckets.map(b => {
      const h = b.hour;
      const v = b.estimatedMinutesWatched || b.views || 0;
      const pct = Math.round((v / max) * 100);
      return `<div class="bc-bar-wrap" title="${fmtHour(h)} ET: ${Math.round(v)} min watched">
        <div class="bc-bar" style="height:${Math.max(4, pct)}%"></div>
        <div class="bc-bar-lbl">${h % 3 === 0 ? fmtHour(h) : ''}</div></div>`;
    }).join('');
    const rec = d.recommendation;
    el.innerHTML = `
      <div class="bc-bar-chart">${bars}</div>
      ${rec ? `<div style="margin-top:12px;font-size:12px;">
        <b style="color:#c7af4f;">Recommended window:</b> ${rec.windowEt} ET
        (${rec.lengthHours}h, ~${Math.round(rec.totalMinutes)} min watched in sample)
        <button class="btn btn-outline btn-sm" style="margin-left:8px;font-size:10px;padding:2px 8px;"
          onclick="navigator.clipboard.writeText('LIVE_GRID_WINDOW=${rec.windowEt}')">COPY ENV</button></div>` : ''}`;
  }

  function renderAllowlist() {
    const el = g('bc-allowlist-body');
    if (!el) return;
    const d = _bcAllowlist;
    if (!d || !d.events) {
      el.innerHTML = '<div style="font-size:11px;color:rgba(255,255,255,0.35);">—</div>';
      return;
    }
    const events = d.events.map(e =>
      `<div style="margin-bottom:6px;font-size:11px;"><span class="bc-tier bc-tier-${e.tier}">${e.tier}</span>
        <b>${e.label}</b> <span style="color:rgba(255,255,255,0.35);">${(e.modes || []).join(', ')}</span></div>`
    ).join('');
    const tv = d.twitchTv || {};
    el.innerHTML = events + (tv.allowedPatterns ? `<div style="margin-top:10px;font-size:10px;color:rgba(255,255,255,0.4);">
      Twitch TV allows: ${tv.allowedPatterns.join(', ')}</div>` : '');
  }

  function renderDiscoveryBench() {
    const el = g('bc-discovery-list');
    if (!el) return;
    const tab = g('bc-bench-tab')?.value || 'merged';
    let list = [];
    let err = '';
    if (tab === 'follows') {
      const d = _bcDiscovery.follows;
      if (!d?.ok) err = d?.error || 'Connect Twitch at /connect/twitch';
      else list = d.bench || [];
    } else {
      const d = _bcDiscovery.merged;
      if (!d?.ok) err = d?.error || 'Discovery failed';
      else list = d.bench || [];
    }
    if (err) { el.innerHTML = `<div style="font-size:11px;color:#e88;">${err}</div>`; return; }
    el.innerHTML = list.length
      ? list.map(l => `<span class="bc-bench-chip">${l}</span>`).join('')
      : '<div style="font-size:11px;color:rgba(255,255,255,0.35);">Empty bench</div>';
  }

  function populateFileSelects() {
    const sel = g('bc-file-swap-select');
    const ev = g('bc-event-file');
    if (!_bcFiles?.files) return;
    const opts = '<option value="">— pick output file —</option>' +
      _bcFiles.files.slice(0, 80).map(f =>
        `<option value="${f.path}">${f.name}</option>`).join('');
    if (sel) sel.innerHTML = opts;
    if (ev) {
      ev.innerHTML = '<option value="">— auto from calendar / output —</option>' +
        _bcFiles.files.slice(0, 80).map(f =>
          `<option value="${f.path}">${f.name}</option>`).join('');
    }
  }

  window.bcSwapQuadrantFile = async function () {
    const q = Number(g('bc-file-swap-quad')?.value) || 1;
    const path = g('bc-file-swap-select')?.value;
    const label = g('bc-file-swap-label')?.value || 'FILE';
    if (!path) return alert('Pick a file');
    try {
      const d = await bcFetch(`/live-grid/quadrant/${q}/file`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, label }),
      });
      if (!d.ok) alert(d.error || 'Swap failed');
      else { liveGridRefresh(); broadcastRefreshProgram(); }
    } catch (e) { alert(e.message); }
  };

  window.bcArm24h = async function () {
    if (!confirm('Arm 24h measurement? Sets LIVE_GRID_WINDOW=00:00-24:00 and signals the waiter script.')) return;
    try {
      const d = await bcFetch('/broadcast/24h-arm', { method: 'POST' });
      if (!d.ok) alert(d.error || 'Failed');
      else { alert('Armed. Waiter starts grid when pipeline is idle.'); broadcastRefreshOps(); }
    } catch (e) { alert(e.message); }
  };

  window.bcConnectTwitch = function () {
    window.open(BC_BASE + '/connect/twitch', '_blank');
  };

  window.bcConnectYoutube = function () {
    window.open(BC_BASE + '/connect/youtube', '_blank');
  };

  window.broadcastRefreshAll = async function () {
    await Promise.all([
      broadcastRefreshOps(),
      broadcastRefreshProgram(),
      broadcastRefreshScheduler(),
      broadcastRefreshAllowlist(),
      broadcastRefreshFiles(),
    ]);
    await broadcastRefreshDiscovery();
    if (g('page-broadcast')?.classList.contains('active')) {
      await broadcastRefreshAnalytics();
    }
    renderVerticalLink();
    renderWaiterLog();
    renderEnvPanel();
  };

  function renderVerticalLink() {
    const row = g('bc-vertical-row');
    if (!row) return;
    const url = _lgStatus?.verticalBroadcast?.watchUrl;
    row.style.display = url ? '' : 'none';
    if (url) g('bc-vertical-link').href = url;
  }

  function renderWaiterLog() {
    const el = g('bc-waiter-log');
    if (!el || !_bcOps) return;
    const lines = _bcOps.waiter?.logTail || [];
    el.textContent = lines.length ? lines.join('\n') : '(no waiter log yet — run scripts/start_24h_grid_when_ready.sh)';
  }

  function renderEnvPanel() {
    const el = g('bc-env-panel');
    if (!el || !_bcOps?.env) return;
    el.innerHTML = Object.entries(_bcOps.env).map(([k, v]) =>
      `<div style="font-size:10px;font-family:monospace;"><span style="color:#c7af4f;">${k}</span>=${v ?? '(unset)'}</div>`
    ).join('');
  }

  // Enhanced start — reads broadcast panel fields
  const _origLiveGridStart = window.liveGridStart;
  window.liveGridStart = async function () {
    const privacy = g('lg-privacy')?.value || 'public';
    const programMode = g('bc-program-mode')?.value || 'auto';
    const headline = (g('bc-headline')?.value || '').trim();
    const eventTitle = (g('bc-event-title')?.value || '').trim();
    const eventFile = g('bc-event-file')?.value || '';
    if (!confirm(`Start Live Grid (${programMode}, ${privacy.toUpperCase()})?`)) return;
    const btn = g('lg-start-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'STARTING…'; }
    const body = { privacyStatus: privacy, programMode };
    if (headline) body.headline = headline;
    if (eventTitle) body.eventTitle = eventTitle;
    if (eventFile) body.eventFile = eventFile;
    try {
      const r = await fetch(BC_BASE + '/live-grid/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!d.ok) alert('Start failed: ' + (d.error || 'unknown'));
    } catch (e) { alert('Start failed: ' + e.message); }
    if (btn) { btn.disabled = false; btn.textContent = 'GO LIVE'; }
    liveGridRefresh();
    broadcastRefreshAll();
  };

  window.broadcastRefreshDiscovery = broadcastRefreshDiscovery;
  window.broadcastRefreshAnalytics = broadcastRefreshAnalytics;

  window.broadcastPageInit = function () {
    broadcastRefreshAll();
    if (!_bcPoll) {
      _bcPoll = setInterval(function () {
        if (!g('page-broadcast')?.classList.contains('active')) return;
        broadcastRefreshOps();
        broadcastRefreshProgram();
        broadcastRefreshScheduler();
        liveGridRefresh();
        liveTvRefresh();
        renderVerticalLink();
      }, 15000);
    }
  };

  // Hook liveGridRefresh to update broadcast panels
  const _origRender = window.liveGridRender;
  window.liveGridRender = function () {
    if (typeof _origRender === 'function') _origRender();
    renderProgramPanel();
    renderVerticalLink();
    renderOpsBar();
  };

  const _origTvRender = window.liveTvRender;
  window.liveTvRender = function () {
    if (typeof _origTvRender === 'function') _origTvRender();
    renderOpsBar();
  };

})();
