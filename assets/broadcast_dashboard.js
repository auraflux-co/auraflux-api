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
  let _tvCatalog = null;
  let _tvPlaylistApi = null;
  const TV_LS_KEY = 'cwn_tv_playlist_paths';

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

  function tvClassifyClient(name) {
    const n = String(name).toLowerCase();
    if (/twitch-short|clips_comp|_0clips_|synth_prebuild/.test(n)) return 'hidden';
    if (/nba/.test(n)) return 'nba';
    if (/script_twitch/.test(n) || (/^twitch_/.test(n) && /avatar/.test(n)) || (/^cwn_/.test(n) && /twitch/.test(n))) return 'bobbyg';
    if (/news|because/.test(n)) return 'news';
    return 'other';
  }

  function tvFriendlyClient(name) {
    if (/22clips.*script_twitch/i.test(name)) return 'Twitch Soup — 22 clips (Bobby G avatar)';
    if (/57_avatar.*script_twitch/i.test(name)) return 'Twitch Soup — full avatar edition (Bobby G)';
    if (/script_twitch|twitch_.*avatar/i.test(name)) return 'Twitch Soup — Bobby G avatar VOD';
    if (/news/i.test(name)) return 'News desk — produced VOD';
    if (/nba/i.test(name)) return 'NBA highlights';
    return name.replace(/\.mp4$/i, '').replace(/_/g, ' ').slice(0, 72);
  }

  function tvCatalogFromFiles(files, selectedSet) {
    const groups = { bobbyg: [], news: [], nba: [], other: [] };
    for (const f of files || []) {
      const kind = tvClassifyClient(f.name);
      if (kind === 'hidden') continue;
      const item = {
        abs: f.abs,
        path: f.path,
        name: f.name,
        kind,
        label: tvFriendlyClient(f.name),
        durationMin: null,
        selected: selectedSet ? selectedSet.has(f.abs) || selectedSet.has(f.path) : false,
      };
      (groups[kind] || groups.other).push(item);
    }
    return groups;
  }

  function tvGetCheckedPaths() {
    return Array.from(document.querySelectorAll('.tv-pick:checked'))
      .map(el => el.dataset.abs || el.dataset.path)
      .filter(Boolean);
  }

  function tvUpdateDurationEst() {
    const el = g('tv-duration-est');
    if (!el) return;
    let sec = 0;
    document.querySelectorAll('.tv-pick:checked').forEach((cb) => {
      sec += Number(cb.dataset.durationSec || 0);
    });
    if (!sec) { el.textContent = 'Nothing selected'; return; }
    const min = Math.round(sec / 60);
    el.textContent = min >= 60 ? `~${Math.floor(min / 60)}h ${min % 60}m loop` : `~${min} min loop`;
  }

  function tvRenderCatalogGroup(containerId, title, items, { offseason } = {}) {
    const el = g(containerId);
    if (!el) return;
    if (!items || !items.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = '';
    el.innerHTML = `<div class="tv-catalog-title">${title}</div>` +
      items.map((item, i) => {
        const id = `tv-pick-${containerId}-${i}`;
        const dur = item.durationMin != null ? `${item.durationMin}m` : '';
        const checked = item.selected ? 'checked' : '';
        return `<label class="tv-catalog-item${offseason ? ' offseason' : ''}" for="${id}">
          <input type="checkbox" class="tv-pick" id="${id}" data-path="${item.path || item.abs}" data-abs="${item.abs || ''}"
            data-duration-sec="${item.durationSec || (item.durationMin ? Math.round(item.durationMin * 60) : 0)}" ${checked}>
          <span class="tv-lbl">${item.label || item.name}</span>
          ${dur ? `<span class="tv-dur">${dur}</span>` : ''}
        </label>`;
      }).join('');
    el.querySelectorAll('.tv-pick').forEach(cb => cb.addEventListener('change', tvUpdateDurationEst));
  }

  function tvApplySelectionToDom(paths) {
    const set = new Set(paths || []);
    document.querySelectorAll('.tv-pick').forEach((cb) => {
      cb.checked = set.has(cb.dataset.path) || set.has(cb.dataset.abs);
    });
    tvUpdateDurationEst();
  }

  async function tvRefreshCatalog() {
    const loading = g('tv-catalog-loading');
    if (loading) loading.textContent = 'Loading videos…';
    let selected = [];
    try {
      _tvPlaylistApi = await bcFetch('/live-tv/playlist');
      if (_tvPlaylistApi?.ok) {
        _tvCatalog = _tvPlaylistApi.catalog;
        selected = (_tvPlaylistApi.curated?.videoRels || _tvPlaylistApi.curated?.videos || []).map(String);
        if (!_tvCatalog) _tvCatalog = { bobbyg: [], news: [], nba: [] };
      }
    } catch (_) {
      _tvPlaylistApi = null;
    }

    if (!_tvCatalog) {
      if (!_bcFiles) await broadcastRefreshFiles();
      const saved = JSON.parse(localStorage.getItem(TV_LS_KEY) || '[]');
      const sel = new Set(saved);
      _tvCatalog = tvCatalogFromFiles(_bcFiles?.files, sel);
      selected = saved;
    }

    tvRenderCatalogGroup('tv-catalog-bobbyg', 'BOBBY G TWITCH VODs', _tvCatalog.bobbyg || []);
    tvRenderCatalogGroup('tv-catalog-news', 'NEWS DESK', _tvCatalog.news || []);
    tvRenderCatalogGroup('tv-catalog-nba', 'NBA (off-season)', _tvCatalog.nba || [], { offseason: true });
    const nbaDetails = g('tv-nba-details');
    if (nbaDetails) nbaDetails.style.display = (_tvCatalog.nba || []).length ? '' : 'none';

    if (selected.length) tvApplySelectionToDom(selected);
    else if (_tvPlaylistApi?.recommended?.length) {
      tvApplySelectionToDom(_tvPlaylistApi.recommended.map(r => r.path));
    }

    if (loading) loading.style.display = 'none';
    tvUpdateDurationEst();
  }

  window.tvUseRecommended = async function () {
    if (_tvPlaylistApi?.recommended?.length) {
      tvApplySelectionToDom(_tvPlaylistApi.recommended.map(r => r.path));
      return;
    }
    // Client fallback: 2 newest bobbyg + 1 news by file order
    const picks = [];
    for (const item of (_tvCatalog?.bobbyg || []).slice(0, 2)) picks.push(item.path || item.abs);
    for (const item of (_tvCatalog?.news || []).slice(0, 1)) picks.push(item.path || item.abs);
    tvApplySelectionToDom(picks);
  };

  window.tvBuildStartBody = async function () {
    const paths = tvGetCheckedPaths();
    if (!paths.length) {
      try {
        const d = await bcFetch('/live-tv/playlist');
        if (d?.curated?.videoRels?.length) return { videos: d.curated.videoRels, curated: true };
      } catch (_) {}
      const saved = JSON.parse(localStorage.getItem(TV_LS_KEY) || '[]');
      if (saved.length) return { videos: saved, curated: true };
    }
    return { videos: paths, curated: true };
  };

  window.tvApplyRotation = async function () {
    const paths = tvGetCheckedPaths();
    if (!paths.length) return alert('Check at least one video for the Twitch rotation.');
    const btn = g('tv-apply-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'APPLYING…'; }
    localStorage.setItem(TV_LS_KEY, JSON.stringify(paths));
    const running = !!(_tvStatus && _tvStatus.running);
    try {
      let d;
      try {
        d = await bcFetch('/live-tv/playlist', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videos: paths, apply: true, targetDurationMin: 60 }),
        });
      } catch (_) { d = null; }
      if (!d?.ok) {
        // Fallback for server not reloaded yet: stop + start with explicit list
        if (running) await bcFetch('/live-tv/stop', { method: 'POST' });
        d = await bcFetch('/live-tv/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videos: paths, curated: true }),
        });
      }
      if (!d?.ok) alert('Could not apply rotation: ' + (d?.error || 'unknown'));
      else if (running) alert('Rotation updated — brief Twitch blip is normal (~2 seconds).');
      else alert('Rotation saved. Click START TWITCH when ready.');
    } catch (e) { alert(e.message); }
    if (btn) { btn.disabled = false; btn.textContent = 'APPLY ROTATION'; }
    liveTvRefresh();
    broadcastRefreshOps();
  };

  async function bcFetch(path, opts) {
    const r = await fetch(BC_BASE + path, opts);
    return r.json();
  }

  function renderPlaybook() {
    const el = g('bc-playbook');
    if (!el) return;
    const pb = _bcOps?.playbook;
    if (!pb?.tiers?.length) {
      el.innerHTML = `<div class="bc-play-principle"><b>What the data said (Jun 13)</b><br>
        Tier A: sports watch-alongs, long-run news desk, esports finals — <b>YouTube Live</b> with commentary/transform layers.<br>
        Tier C: 4-up Twitch multiview — keep on YouTube late night only; <b>not</b> the Twitch TV loop.<br>
        Full playbook loads after server reload — see logs/youtube_top200_build_analysis.json.</div>
        <div style="margin-top:8px;font-size:10px;color:rgba(255,255,255,0.35);">Your pipeline (Bobby G VODs + news) feeds Tier A news desk — but production rate is ~1 hr/day, not 6+ hours of live.</div>`;
      return;
    }

    const statusClass = (s) => {
      if (s === 'wired') return 'bc-play-wired';
      if (s === 'partial') return 'bc-play-partial';
      if (s === 'gap' || s === 'not_built') return 'bc-play-gap';
      if (s === 'skip') return 'bc-play-skip';
      return 'bc-play-partial';
    };

    let html = (pb.principles || []).slice(0, 2).map((p) =>
      `<div class="bc-play-principle"><b>${p.title}</b><br>${p.body}</div>`).join('');

    for (const tier of pb.tiers) {
      html += `<div class="bc-play-tier">${tier.tier}</div>`;
      for (const item of tier.items) {
        if (item.channel === 'skip') continue;
        html += `<div class="bc-play-item ${statusClass(item.wiringStatus)}">
          <b>${item.format}</b> <span class="bc-play-ev">(${item.evidence || ''})</span>
          <div class="bc-play-ch">${item.channelLabel || ''}</div>
          <div style="margin-top:4px;color:rgba(255,255,255,0.7);">${item.robSummary || item.build || ''}</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.4);margin-top:4px;">Status: ${item.wiringDetail || item.wiringStatus}</div>
        </div>`;
      }
    }
    el.innerHTML = html;
  }

  async function broadcastRefreshCalendarBanner() {
    const el = g('bc-cal-banner');
    if (!el) return;
    let cal = null;
    try {
      cal = typeof fetchCalendarBroadcastToday === 'function'
        ? await fetchCalendarBroadcastToday()
        : await bcFetch('/calendar/broadcast-today');
    } catch (_) {}
    if (!cal?.ok) { el.style.display = 'none'; return; }
    el.style.display = '';
    const yt = cal.youtubeNow;
    const prod = (cal.production || []).map((p) => `${p.time} ${p.label} (${p.status})`).join(' · ');
    el.innerHTML = `<b style="color:#c7af4f;">Calendar drives today</b><br>
      ${yt ? `YouTube Live now: <b>${yt.label}</b> (${yt.mode}) — use this mode in GO LIVE below.` : 'YouTube Live: between dayparts — check scheduler.'}<br>
      Twitch TV window: <b>${cal.twitchTv?.window || '—'}</b> · ${cal.twitchTv?.contentRule || ''}<br>
      <span style="font-size:10px;color:rgba(255,255,255,0.45);">Produce today: ${prod || '—'} · Full plan on Content Calendar tab</span>`;
    const modeSel = g('bc-program-mode');
    if (modeSel && yt?.mode && modeSel.value === 'auto') {
      modeSel.value = yt.mode;
    }
  }

  async function broadcastRefreshOps() {
    try { _bcOps = await bcFetch('/broadcast/ops'); } catch (_) { _bcOps = null; }
    renderOpsBar();
    renderContentBoard();
    renderPlaybook();
    broadcastRefreshCalendarBanner();
  }

  function bcStatusClass(status) {
    return 'bc-status-' + (status || 'gap');
  }

  function buildContentBoardClient() {
    const files = _bcFiles?.files || [];
    const catalog = tvCatalogFromFiles(files, new Set());
    const jobs = (typeof JOBS !== 'undefined' ? JOBS : []) || [];
    const pipeline = [];
    jobs.forEach((j) => {
      const ct = j.contentType || j.type || '';
      const stage = j.stage || j.status || '';
      if (stage === 'published' || stage === 'dismissed' || stage === 'failed') return;
      if (ct !== 'news' && ct !== 'twitch' && ct !== 'twitch-short') return;
      pipeline.push({
        title: ct === 'news' ? 'News desk compilation' : ct === 'twitch' ? 'Twitch Soup (Bobby G)' : 'Twitch short (streamer clips)',
        contentType: ct,
        stageLabel: String(stage).replace(/_/g, ' '),
        forTwitchTv: ct === 'news' || ct === 'twitch',
        isShort: ct === 'twitch-short',
        jobId: j.id,
      });
    });
    const now = new Date();
    const weekIndex = now.getDay() === 0 ? 6 : now.getDay() - 1;
    const scheduled = [{
      label: 'News desk compilation', slot: '10:45 AM ET',
      status: (catalog.news || []).length ? 'stale' : 'gap',
      detail: (catalog.news || []).length ? 'News VOD on disk — check date in Content Calendar' : 'No news VOD — run News from Generate',
    }];
    if (weekIndex >= 2) {
      const tw = pipeline.filter((p) => p.contentType === 'twitch');
      scheduled.push({
        label: 'Twitch Soup — Bobby G avatar VOD', slot: '11:00 AM ET',
        status: tw.length ? 'pipeline' : ((catalog.bobbyg || []).length ? 'ready' : 'gap'),
        detail: tw.length ? tw[0].stageLabel : ((catalog.bobbyg || []).length ? 'Bobby G VOD ready on disk' : 'Nothing in pipeline'),
      });
    }
    scheduled.push({
      label: 'NBA long-form', slot: '—', status: 'info',
      detail: 'Off-season — NFL prep starts August',
    });
    return {
      scheduled,
      pipeline: pipeline.filter((p) => p.forTwitchTv),
      pipelineShorts: pipeline.filter((p) => p.isShort),
      ready: { bobbyg: catalog.bobbyg || [], news: catalog.news || [] },
      gaps: scheduled.filter((s) => s.status === 'gap' || s.status === 'stale'),
    };
  }

  function renderContentBoard() {
    const el = g('bc-content-board');
    if (!el) return;
    const board = _bcOps?.contentBoard || buildContentBoardClient();

    const schedHtml = (board.scheduled || []).filter((s) => s.status !== 'info').map((s) =>
      `<div class="bc-board-item ${bcStatusClass(s.status)}">
        <b>${s.label}</b> <span style="color:rgba(255,255,255,0.35);">${s.slot || ''}</span>
        <div class="bc-board-sub">${s.detail || ''}</div>
      </div>`).join('');

    const info = (board.scheduled || []).find((s) => s.status === 'info');
    const infoHtml = info ? `<div class="bc-board-sub" style="margin-bottom:8px;">${info.detail}</div>` : '';

    const pipeTv = board.pipeline || [];
    const pipeHtml = pipeTv.length
      ? pipeTv.map((p) =>
        `<div class="bc-board-item bc-status-pipeline">
          <b>${p.title}</b>
          <div class="bc-board-sub">${p.stageLabel}${p.jobId ? ' · see Job Queue' : ''}</div>
        </div>`).join('')
      : '<div class="bc-board-sub">No news or Bobby G VOD jobs in the pipeline — start one from Generate</div>';

    const readyItems = [...(board.ready?.bobbyg || []), ...(board.ready?.news || [])];
    const readyHtml = readyItems.length
      ? readyItems.slice(0, 6).map((f) =>
        `<div class="bc-board-item bc-status-ready"><b>${f.label || tvFriendlyClient(f.name)}</b>
          <div class="bc-board-sub">${f.durationMin ? f.durationMin + ' min' : 'ready'}</div></div>`).join('')
      : '<div class="bc-board-sub">Nothing finished yet — pipeline output lands here when published</div>';

    const shorts = board.pipelineShorts || [];
    const shortsHtml = shorts.length
      ? `<div style="margin-top:8px;font-size:10px;color:rgba(255,255,255,0.35);">${shorts.length} streamer short(s) in Job Queue — YouTube/TikTok only, not Twitch TV</div>`
      : '';

    const gapsHtml = (board.gaps || []).length
      ? `<div class="bc-board-gaps"><b>Needs attention</b><ul style="margin:6px 0 0;padding-left:18px;">
        ${board.gaps.map((g) => `<li>${g.label}: ${g.detail}</li>`).join('')}
        </ul></div>`
      : '';

    const ev = board.activeEvent;
    const evHtml = ev
      ? `<div style="font-size:10px;color:rgba(255,255,255,0.45);margin-bottom:10px;">YouTube Grid event slot: <b style="color:#c7af4f;">${ev.eventTitle || ev.eventId}</b></div>`
      : '';

    el.innerHTML = `
      ${evHtml}${infoHtml}
      <div class="bc-board-grid">
        <div class="bc-board-col"><h4>TODAY&apos;S SCHEDULE</h4>${schedHtml || '—'}</div>
        <div class="bc-board-col"><h4>IN PRODUCTION</h4>${pipeHtml}${shortsHtml}</div>
        <div class="bc-board-col"><h4>READY FOR TWITCH TV</h4>${readyHtml}</div>
      </div>
      ${gapsHtml}
      <div style="margin-top:8px;font-size:10px;color:rgba(255,255,255,0.3);">This board shows the gap between the calendar and what&apos;s on disk. Pick Ready items in ClipzWorld TV below.</div>`;
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
    renderContentBoard();
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
    tvRefreshCatalog();
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
    const s = _tvStatus;
    const badge = g('tv-curated-badge');
    if (badge) badge.style.display = (s && (s.curated || (s.playlist && s.playlist.length <= 6))) ? '' : 'none';
    const pl = g('tv-playlist');
    if (pl && s && s.running && s.playlist) {
      pl.innerHTML = (s.playlist || []).map((name, i) => {
        const lbl = tvFriendlyClient(name);
        return `<div style="color:rgba(255,255,255,0.65);">${i + 1}. ${lbl}</div>`;
      }).join('');
    }
  };

  window.tvRefreshCatalog = tvRefreshCatalog;

})();
