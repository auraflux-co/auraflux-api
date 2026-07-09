/**
 * Content Calendar — monthly plan vs actual (jobs + YouTube + Upload-Post).
 */
(function () {
  const CAL_BASE = (typeof CFG !== 'undefined' && CFG.ffmpegUrl) || 'http://localhost:3000';
  let _calMonth = null;
  let _viewYear = new Date().getFullYear();
  let _viewMonth = new Date().getMonth() + 1;
  let _selectedDate = null;
  let _ownerUnlocked = sessionStorage.getItem('cwn_calendar_owner') === '1';
  let _scheduleCtx = null;

  function g(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function calendarSourceLabel(it) {
    if (it.platform === 'youtube' || (it.source || '').includes('youtube')) return 'YouTube';
    if (it.platform === 'tiktok' || (it.source || '').includes('tiktok')) return 'TikTok';
    if (it.platform === 'instagram' || (it.source || '').includes('instagram')) return 'Instagram';
    if ((it.source || '').includes('upload_post')) return 'Upload-Post';
    if (it.source === 'job') return 'Job queue';
    return it.source || '';
  }

  async function calFetch(path, opts) {
    const r = await fetch(CAL_BASE + path, opts);
    if (!r.ok) {
      let detail = '';
      try {
        const err = await r.json();
        detail = err.error || err.message || '';
      } catch (_) {
        try { detail = await r.text(); } catch (_e) { /* ignore */ }
      }
      throw new Error(detail || `HTTP ${r.status}`);
    }
    return r.json();
  }

  const FORMAT_ICON = { short: '▮', longform: '▬', live: '●' };
  const PILLAR_ICON = { twitch: '🎮', news: '📰', sports: '🏀', streaming: '📺' };

  function monthCacheKey(year, month) {
    return `${year}-${String(month).padStart(2, '0')}`;
  }

  function loadMonthCache(year, month) {
    try {
      const all = JSON.parse(localStorage.getItem(CAL_MONTH_CACHE_KEY) || '{}');
      return all[monthCacheKey(year, month)] || null;
    } catch (_) {
      return null;
    }
  }

  function saveMonthCache(year, month, plan) {
    try {
      const all = JSON.parse(localStorage.getItem(CAL_MONTH_CACHE_KEY) || '{}');
      all[monthCacheKey(year, month)] = { plan, savedAt: new Date().toISOString() };
      localStorage.setItem(CAL_MONTH_CACHE_KEY, JSON.stringify(all));
    } catch (_) { /* ignore */ }
  }

  function bustMonthCache(year, month) {
    try {
      const all = JSON.parse(localStorage.getItem(CAL_MONTH_CACHE_KEY) || '{}');
      delete all[monthCacheKey(year, month)];
      localStorage.setItem(CAL_MONTH_CACHE_KEY, JSON.stringify(all));
    } catch (_) { /* ignore */ }
  }

  function loadViewPrefs() {
    try {
      return JSON.parse(localStorage.getItem(CAL_VIEW_PREFS_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }

  function saveViewPrefs() {
    try {
      localStorage.setItem(CAL_VIEW_PREFS_KEY, JSON.stringify({
        year: _viewYear,
        month: _viewMonth,
        selectedDate: _selectedDate,
      }));
    } catch (_) { /* ignore */ }
  }

  function formatCacheAge(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (_) {
      return '';
    }
  }

  function renderCalendarCacheBanner(savedAt, fromCache) {
    const el = g('cal-cache-banner');
    if (!el) return;
    if (!fromCache) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    const when = formatCacheAge(savedAt);
    el.innerHTML = `Showing saved calendar from ${when || 'last session'}. Click <strong>REFRESH</strong> to sync YouTube + Upload-Post.`;
  }

  function planLine(planned) {
    const parts = [];
    if (planned.short) parts.push(`${planned.short}▮`);
    if (planned.longform) parts.push(`${planned.longform}▬`);
    if (planned.live) parts.push(`${planned.live}●`);
    return parts.length ? `Plan: ${parts.join(' ')}` : 'Plan: —';
  }

  function actualLine(counts) {
    const parts = [];
    if (counts.short) parts.push(`${counts.short}▮`);
    if (counts.longform) parts.push(`${counts.longform}▬`);
    if (counts.live) parts.push(`${counts.live}●`);
    return parts.length ? `Actual: ${parts.join(' ')}` : '';
  }

  function goalClass(goals, isPast) {
    if (!goals || goals.state === 'no_plan') return '';
    if (goals.state === 'met') return 'cal-goal-met';
    if (isPast && goals.state === 'missed') return 'cal-goal-missed';
    if (isPast && goals.state === 'partial') return 'cal-goal-partial';
    return '';
  }

  function renderStreamerFocusBanner(plan) {
    const el = g('cal-focus-banner');
    if (!el) return;
    const sf = plan?.streamerFocus;
    if (!sf?.primary) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    const reach = sf.reach ? ` Reach only: ${sf.reach}.` : '';
    const note = plan.focusNote ? `<div style="margin-top:6px;color:rgba(255,255,255,0.55);">${esc(plan.focusNote)}</div>` : '';
    el.innerHTML = `<strong style="color:rgba(46,204,113,0.95);">FOCUS · ${esc(sf.primary)}</strong> — ${esc(sf.cadence || '3 of 4 posts')}. Titles lead with <strong>${esc(sf.titleLead || sf.primary)}</strong>.${reach}${sf.reviewAfter ? ` Locked until ${esc(sf.reviewAfter)}.` : ''}${note}`;
  }

  function renderMonth(plan) {
    const grid = g('calendar-grid');
    const titleEl = g('cal-month-title');
    const summaryEl = g('cal-month-summary');
    if (!grid || !plan?.days) return;

    renderStreamerFocusBanner(plan);

    if (titleEl) titleEl.textContent = plan.monthLabel || `${plan.year}-${plan.month}`;
    grid.innerHTML = '';

    for (let i = 0; i < (plan.gridPad || 0); i++) {
      const pad = document.createElement('div');
      pad.className = 'cal-month-day cal-month-pad';
      grid.appendChild(pad);
    }

    plan.days.forEach((day) => {
      const div = document.createElement('div');
      const gc = goalClass(day.goals, day.isPast);
      div.className = 'cal-month-day'
        + (day.isToday ? ' cal-today' : '')
        + (day.isPast ? ' cal-past' : '')
        + (gc ? ` ${gc}` : '')
        + (_selectedDate === day.date ? ' cal-selected' : '');
      div.onclick = () => calSelectDay(day.date);

      const chips = (day.actual.items || []).slice(0, 4).map((it) => {
        const st = it.status === 'published' ? 'published' : (it.status === 'scheduled' ? 'scheduled' : '');
        const icon = PILLAR_ICON[it.pillar] || FORMAT_ICON[it.format] || '·';
        const tip = (it.timeEt ? it.timeEt + ' ET · ' : '') + (it.title || '');
        return `<span class="cal-chip ${st}" title="${esc(tip)}">${icon}</span>`;
      }).join('');
      const more = (day.actual.items || []).length > 4 ? `<span class="cal-chip">+${day.actual.items.length - 4}</span>` : '';
      const timesLine = (day.actual.items || []).slice(0, 3).map((it) => {
        if (!it.timeEt) return '';
        return `<span class="cal-time-chip">${esc(it.timeEt)}${FORMAT_ICON[it.format] || ''}</span>`;
      }).filter(Boolean).join('');

      div.innerHTML = `
        <div class="cal-month-daynum">${day.day}${day.isToday ? ' <span style="font-size:14px;color:#c7af4f;">TODAY</span>' : ''}</div>
        <div class="cal-month-plan">${planLine(day.planned)}</div>
        <div class="cal-month-actual">${actualLine(day.actual.counts) || (day.isPast ? 'Actual: —' : '')}</div>
        ${timesLine ? `<div class="cal-month-times">${timesLine}</div>` : ''}
        <div class="cal-month-chips">${chips}${more}</div>`;
      grid.appendChild(div);
    });

    if (summaryEl && plan.monthTotals) {
      const t = plan.monthTotals;
      summaryEl.innerHTML = `Month totals · Planned ${t.planned.short}▮ ${t.planned.longform}▬ ${t.planned.live}●`
        + ` · Actual ${t.actual.short}▮ ${t.actual.longform}▬ ${t.actual.live}●`
        + (t.daysWithPlan ? ` · ${t.daysMet}/${t.daysWithPlan} past days met plan` : '');
    }

    const defShort = g('cal-def-short');
    const defLong = g('cal-def-longform');
    const defLive = g('cal-def-live');
    const defs = plan.defaultDailyTargets || { short: 3, longform: 1, live: 1 };
    if (defShort) defShort.value = defs.short;
    if (defLong) defLong.value = defs.longform;
    if (defLive) defLive.value = defs.live;
  }

  function renderDayPanel(day) {
    const panel = g('cal-day-panel');
    const title = g('cal-day-panel-title');
    const body = g('cal-day-panel-body');
    if (!panel || !body || !day) { if (panel) panel.style.display = 'none'; return; }

    panel.style.display = 'block';
    if (title) {
      title.textContent = new Date(day.date + 'T12:00:00').toLocaleDateString([], {
        weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
      });
    }

    const goalHtml = Object.entries(day.goals.detail || {}).map(([fmt, g]) =>
      `<div style="font-size:13px;margin:2px 0;color:${g.met ? '#2ecc71' : (day.isPast ? '#e74c3c' : '#e67e22')};">`
      + `${FORMAT_ICON[fmt] || fmt}: ${g.actual}/${g.planned} ${g.met ? '✓' : (day.isPast ? 'missed' : 'pending')}</div>`).join('');

    const itemsHtml = (day.actual.items || []).length
      ? day.actual.items.map((it) => {
        const icon = PILLAR_ICON[it.pillar] || FORMAT_ICON[it.format] || '·';
        const st = it.status === 'published' ? '✓ published'
          : (it.status === 'scheduled' ? '⏱ scheduled'
            : (it.status === 'live' ? '● live now' : it.status));
        const timeLabel = it.timeEt ? `${it.timeEt} ET` : '';
        const src = calendarSourceLabel(it);
        const jobLink = it.jobId
          ? `<a href="#" onclick="nav('queue');setTimeout(function(){var el=document.getElementById('job-${esc(it.jobId)}');if(el)el.scrollIntoView({behavior:'smooth'});},400);return false;" style="color:#3498db;">${esc(it.jobId.slice(0, 28))}</a>`
          : '';
        const ytLink = it.url
          ? ` · <a href="${esc(it.url)}" target="_blank" rel="noopener" style="color:#e74c3c;">↗ YT</a>`
          : '';
        return `<div class="cal-item-row">
          <span class="cal-item-time">${esc(timeLabel || '—')}</span>
          <span>${icon}</span>
          <div class="cal-item-title">${esc(it.title)}<div class="cal-item-meta">${st}${timeLabel ? '' : ''} · ${it.format}${it.pillar ? ' · ' + it.pillar : ''} · ${src}${jobLink ? ' · ' + jobLink : ''}${ytLink}</div></div>
        </div>`;
      }).join('')
      : '<div style="font-size:13px;color:rgba(255,255,255,0.4);">No jobs or YouTube items linked to this day yet.</div>';

    body.innerHTML = `
      <div style="font-size:13px;color:rgba(255,255,255,0.5);margin-bottom:8px;">${planLine(day.planned)}${day.planned.note ? ' · ' + esc(day.planned.note) : ''}</div>
      ${goalHtml || '<div style="font-size:13px;color:rgba(255,255,255,0.35);">No targets set for this day.</div>'}
      <div style="font-size:16px;font-weight:900;color:rgba(199,175,79,0.6);letter-spacing:1px;margin:12px 0 6px;">EDIT PLAN</div>
      <div class="cal-plan-form">
        <div><label>Shorts</label><input type="number" id="cal-day-short" min="0" max="20" value="${day.planned.short}"></div>
        <div><label>Long-form</label><input type="number" id="cal-day-longform" min="0" max="10" value="${day.planned.longform}"></div>
        <div><label>Live</label><input type="number" id="cal-day-live" min="0" max="5" value="${day.planned.live}"></div>
      </div>
      <div style="margin-bottom:8px;"><label style="font-size:16px;color:rgba(255,255,255,0.45);">Note</label>
        <input type="text" id="cal-day-note" value="${esc(day.planned.note || '')}" style="width:100%;background:#0a1020;border:1px solid rgba(199,175,79,0.25);color:#fff;padding:6px;border-radius:4px;font-size:14px;margin-top:3px;"></div>
      <button class="btn btn-gold btn-sm" onclick="calSaveDayPlan('${day.date}')">SAVE DAY PLAN</button>
      <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;">
        <button type="button" class="btn btn-outline btn-sm" onclick="calOpenStatsForDay('${day.date}')">📊 Stats — this day</button>
        <button type="button" class="btn btn-outline btn-sm" onclick="calOpenStatsForWeek('${day.date}')">📊 Stats — 7d ending here</button>
      </div>
      <div style="font-size:16px;font-weight:900;color:rgba(199,175,79,0.6);letter-spacing:1px;margin:14px 0 6px;">ACTUAL (${(day.actual.items || []).length})</div>
      ${itemsHtml}`;

    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  window.calSelectDay = function (dateKey) {
    _selectedDate = dateKey;
    if (!_calMonth?.days) return;
    const day = _calMonth.days.find((d) => d.date === dateKey);
    renderMonth(_calMonth);
    renderDayPanel(day);
  };

  window.calSaveDayPlan = async function (dateKey) {
    const short = Number(g('cal-day-short')?.value) || 0;
    const longform = Number(g('cal-day-longform')?.value) || 0;
    const live = Number(g('cal-day-live')?.value) || 0;
    const note = g('cal-day-note')?.value || '';
    const d = await calFetch('/calendar/month/day', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dateKey, short, longform, live, note }),
    });
    if (d.ok) {
      bustMonthCache(_viewYear, _viewMonth);
      calendarRefresh(false);
    }
    else alert(d.error || 'Save failed');
  };

  window.calSaveMonthDefaults = async function () {
    const d = await calFetch('/calendar/month/defaults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        year: _viewYear,
        month: _viewMonth,
        short: Number(g('cal-def-short')?.value) || 0,
        longform: Number(g('cal-def-longform')?.value) || 0,
        live: Number(g('cal-def-live')?.value) || 0,
      }),
    });
    if (d.ok) {
      bustMonthCache(_viewYear, _viewMonth);
      calendarRefresh(false);
    }
    else alert(d.error || 'Save failed');
  };

  window.calPrevMonth = function () {
    _viewMonth -= 1;
    if (_viewMonth < 1) { _viewMonth = 12; _viewYear -= 1; }
    _selectedDate = null;
    calendarRefresh(false);
  };

  window.calNextMonth = function () {
    _viewMonth += 1;
    if (_viewMonth > 12) { _viewMonth = 1; _viewYear += 1; }
    _selectedDate = null;
    calendarRefresh(false);
  };

  window.calThisMonth = function () {
    const now = new Date();
    _viewYear = now.getFullYear();
    _viewMonth = now.getMonth() + 1;
    _selectedDate = null;
    calendarRefresh(false);
  };

  async function fetchCalendarRange(start, end) {
    return calFetch('/calendar/range?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end));
  }

  window.calOpenStatsForDay = async function (dateKey) {
    const d = await fetchCalendarRange(dateKey, dateKey);
    if (d.ok && typeof window.applyCalendarStatsFilter === 'function') window.applyCalendarStatsFilter(d);
    else alert(d.error || 'Range load failed');
  };

  window.calOpenStatsForWeek = async function (anchorDate) {
    const end = anchorDate || _selectedDate || new Date().toISOString().slice(0, 10);
    const startD = new Date(end + 'T12:00:00');
    startD.setDate(startD.getDate() - 6);
    const start = startD.toISOString().slice(0, 10);
    const d = await fetchCalendarRange(start, end);
    if (d.ok && typeof window.applyCalendarStatsFilter === 'function') window.applyCalendarStatsFilter(d);
    else alert(d.error || 'Range load failed');
  };

  window.calOpenStatsForMonth = async function () {
    const start = `${_viewYear}-${String(_viewMonth).padStart(2, '0')}-01`;
    const dim = new Date(_viewYear, _viewMonth, 0).getDate();
    const end = `${_viewYear}-${String(_viewMonth).padStart(2, '0')}-${String(dim).padStart(2, '0')}`;
    const d = await fetchCalendarRange(start, end);
    if (d.ok && typeof window.applyCalendarStatsFilter === 'function') window.applyCalendarStatsFilter(d);
    else alert(d.error || 'Range load failed');
  };

  function renderYoutubeStudioBanner(plan) {
    const el = g('cal-yt-studio-banner');
    if (!el) return;
    const ys = plan?.youtubeStudio;
    if (!ys) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    if (!ys.ok && ys.message) {
      el.innerHTML = `<strong>YouTube sync off.</strong> ${ys.message} · <a href="/connect/youtube" target="_blank" style="color:#c7af4f;">Connect YouTube</a>`;
      return;
    }
    const stale = ys.stale ? ' (cached)' : '';
    el.innerHTML = `<strong>YouTube</strong> · ${ys.count || 0} videos in range with publish times (ET) · actual publish times tie back to job IDs when scheduled via queue.`;
  }

  window.calCloseSchedule = function () {
    const m = g('cal-schedule-modal');
    if (m) m.classList.remove('open');
    _scheduleCtx = null;
  };

  window.calPickJob = async function (jobId) {
    if (!_scheduleCtx) return;
    const { date, slotId } = _scheduleCtx;
    const d = await calFetch('/calendar/schedule-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, slotId, date }),
    });
    if (d.ok) {
      alert(d.message || 'Scheduled');
      calCloseSchedule();
      bustMonthCache(_viewYear, _viewMonth);
      calendarRefresh(false);
    } else {
      alert(d.error || 'Schedule failed');
    }
  };

  window.calOpenSlot = async function (date, slotId, contentType) {
    const title = g('cal-schedule-title');
    const sub = g('cal-schedule-sub');
    const list = g('cal-schedule-jobs');
    const modal = g('cal-schedule-modal');
    if (!modal || !list) return;

    _scheduleCtx = { date, slotId, contentType };
    if (title) title.textContent = slotId.replace(/_/g, ' ');
    if (sub) sub.textContent = `${date} · pick assembled job`;
    list.innerHTML = '<div style="font-size:14px;color:rgba(255,255,255,0.5);">Loading jobs…</div>';
    modal.classList.add('open');

    const data = await calFetch('/calendar/eligible-jobs?contentType=' + encodeURIComponent(contentType || ''));
    const jobs = data.jobs || [];
    if (!jobs.length) {
      list.innerHTML = '<div style="font-size:14px;color:#e74c3c;">No assembled jobs for this slot yet.</div>';
      return;
    }
    list.innerHTML = jobs.map((j) =>
      `<button type="button" class="cal-job-pick" onclick="calPickJob('${j.jobId}')">
        <b>${esc(j.title)}</b><br><span style="font-size:16px;color:rgba(255,255,255,0.45);">${esc(j.jobId)} · ${j.stage}</span>
      </button>`).join('');
  };

  window.calUnlockOwner = async function () {
    const pin = prompt('Owner PIN (only Rob):');
    if (!pin) return;
    const verify = await calFetch('/calendar/verify-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (verify.ok) {
      sessionStorage.setItem('cwn_calendar_owner', '1');
      _ownerUnlocked = true;
      alert('Owner mode on.');
      calendarRefresh(false);
    } else {
      alert(verify.error || 'Wrong PIN');
    }
  };

  window.calendarRefresh = async function (forceRefresh) {
    saveViewPrefs();
    const refreshBtn = g('cal-refresh-btn');

    if (!forceRefresh) {
      const cached = loadMonthCache(_viewYear, _viewMonth);
      if (cached?.plan?.ok) {
        _calMonth = cached.plan;
        await renderNorthStarCadence(false);
        renderYoutubeStudioBanner(_calMonth);
        renderMonth(_calMonth);
        renderCalendarCacheBanner(cached.savedAt, true);
        if (_selectedDate) {
          const day = _calMonth.days.find((d) => d.date === _selectedDate);
          renderDayPanel(day);
        }
        return;
      }
    } else {
      bustMonthCache(_viewYear, _viewMonth);
      try { localStorage.removeItem(CAL_NORTHSTAR_CACHE_KEY); } catch (_) { /* ignore */ }
    }

    const grid = g('calendar-grid');
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'REFRESHING…';
    }
    if (forceRefresh && grid) grid.style.opacity = '0.55';

    let fetchError = null;
    try {
      const refreshParam = forceRefresh ? '&refreshYoutube=1&refresh=1' : '';
      _calMonth = await calFetch(`/calendar/month?year=${_viewYear}&month=${_viewMonth}${refreshParam}`);
    } catch (e) {
      fetchError = e;
      _calMonth = null;
    } finally {
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'REFRESH';
      }
      if (grid) grid.style.opacity = '';
    }

    if (fetchError) {
      renderCalendarCacheBanner(null, false);
      const banner = g('cal-cache-banner');
      if (banner) {
        banner.style.display = 'block';
        banner.innerHTML = `<span style="color:#e74c3c;">Refresh failed: ${esc(fetchError.message)}</span>`;
      }
      if (grid) {
        grid.innerHTML = '<div style="padding:20px;color:#e74c3c;">Could not refresh calendar — is server running?</div>';
      }
      return;
    }

    await renderNorthStarCadence(!!forceRefresh);
    renderCalendarCacheBanner(null, false);
    if (!_calMonth?.ok) {
      const errGrid = g('calendar-grid');
      if (errGrid) errGrid.innerHTML = '<div style="padding:20px;color:#e74c3c;">Could not load calendar — is server running?</div>';
      return;
    }
    saveMonthCache(_viewYear, _viewMonth, _calMonth);
    renderYoutubeStudioBanner(_calMonth);
    renderMonth(_calMonth);
    if (_selectedDate) {
      const day = _calMonth.days.find((d) => d.date === _selectedDate);
      renderDayPanel(day);
    }
    const banner = g('cal-cache-banner');
    if (banner && forceRefresh) {
      banner.style.display = 'block';
      banner.innerHTML = `<span style="color:#2ecc71;">Synced ${formatCacheAge(new Date().toISOString())} — YouTube + Upload-Post</span>`;
      setTimeout(() => { if (banner) banner.style.display = 'none'; }, 6000);
    }
  };

  async function renderNorthStarCadence(forceRefresh) {
    const el = g('cal-northstar');
    const card = g('cal-northstar-card');
    if (!el) return;
    if (!forceRefresh) {
      try {
        const cached = JSON.parse(localStorage.getItem(CAL_NORTHSTAR_CACHE_KEY) || 'null');
        if (cached?.html) {
          el.innerHTML = cached.html;
          if (card) card.style.borderColor = cached.borderColor || '';
          return;
        }
      } catch (_) { /* fetch below */ }
    }
    try {
      const stats = await calFetch('/stats/channel');
      const ns = stats.northStar;
      if (!ns) {
        el.innerHTML = '<b style="color:#c7af4f;">Targets</b><br>3–5 Shorts · 1–2 VOD · 0–2 Live/day<br><a href="#" onclick="nav(\'stats\');return false;" style="color:#c7af4f;font-size:13px;">→ Channel Stats</a>';
        return;
      }
      const c = ns.cadence || {};
      const avg = c.avgPerDay || {};
      const y = c.yesterday || {};
      const t = ns.config?.cadence || {};
      const alertHtml = (ns.alerts || []).slice(0, 2).map((a) =>
        `<div style="margin-top:4px;color:${a.level === 'warn' ? '#e67e22' : '#8899aa'};font-size:16px;">⚠ ${esc(a.message)}</div>`).join('');
      el.innerHTML = `
        <div><b style="color:#c7af4f;">Target</b> · ${t.shorts?.min || 3}–${t.shorts?.max || 5} Shorts · ${t.videos?.min || 1}–${t.videos?.max || 2} VOD · ${t.streams?.min || 0}–${t.streams?.max || 2} Live</div>
        <div style="margin-top:6px;"><b style="color:#c7af4f;">Yesterday</b> · ${y.shorts || 0}▮ ${y.videos || 0}▬ ${y.streams || 0}●</div>
        <div style="margin-top:4px;"><b style="color:#c7af4f;">7d avg</b> · ${(avg.shorts || 0).toFixed(1)}▮ ${(avg.videos || 0).toFixed(1)}▬ ${(avg.streams || 0).toFixed(1)}●</div>
        <div style="margin-top:6px;font-size:16px;color:rgba(255,255,255,0.4);">$${ns.config?.dailyUsdTarget || 300}/day · ${ns.progress?.pctOfTarget || 0}% progress</div>
        ${alertHtml}
        <div style="margin-top:8px;"><a href="#" onclick="nav('stats');return false;" style="color:#c7af4f;font-size:13px;">→ Channel Stats</a></div>`;
      const borderColor = (ns.alerts || []).some((a) => a.level === 'warn') ? 'rgba(243,156,18,0.45)' : '';
      if (card) card.style.borderColor = borderColor;
      try {
        localStorage.setItem(CAL_NORTHSTAR_CACHE_KEY, JSON.stringify({ html: el.innerHTML, borderColor }));
      } catch (_) { /* ignore */ }
      return;
    } catch (_) {
      el.innerHTML = '<b style="color:#c7af4f;">North star</b><br>3–5 Shorts · 1–2 VOD · 0–2 Live/day';
    }
  }

  window.calendarPageInit = function () {
    const prefs = loadViewPrefs();
    if (prefs?.year && prefs?.month) {
      _viewYear = prefs.year;
      _viewMonth = prefs.month;
      _selectedDate = prefs.selectedDate || null;
    } else {
      const now = new Date();
      _viewYear = now.getFullYear();
      _viewMonth = now.getMonth() + 1;
      _selectedDate = null;
    }
    initCalSidebarLayout();
    calendarRefresh(false);
  };

  const CAL_SIDEBAR_KEY = 'cwn_cal_sidebar';
  const CAL_MONTH_CACHE_KEY = 'cwn_cal_month_cache_v1';
  const CAL_VIEW_PREFS_KEY = 'cwn_cal_view_prefs';
  const CAL_NORTHSTAR_CACHE_KEY = 'cwn_cal_northstar_cache_v1';
  const CAL_SIDEBAR_DEFAULT = 220;
  const CAL_SIDEBAR_MIN = 160;
  const CAL_SIDEBAR_MAX = 380;

  function applyCalSidebarPrefs(prefs) {
    const layout = g('cal-month-layout');
    const col = g('cal-sidebar-col');
    const toggle = g('cal-sidebar-toggle');
    if (!layout) return;
    const collapsed = !!(prefs && prefs.collapsed);
    const width = (prefs && prefs.width) ? Number(prefs.width) : CAL_SIDEBAR_DEFAULT;
    if (collapsed) {
      layout.classList.add('cal-sidebar-hidden');
      if (col) col.setAttribute('aria-hidden', 'true');
      if (toggle) toggle.textContent = '◨ Panel';
    } else {
      layout.classList.remove('cal-sidebar-hidden');
      const w = Math.max(CAL_SIDEBAR_MIN, Math.min(CAL_SIDEBAR_MAX, width || CAL_SIDEBAR_DEFAULT));
      layout.style.setProperty('--cal-sidebar-width', w + 'px');
      if (col) col.removeAttribute('aria-hidden');
      if (toggle) toggle.textContent = '◧ Panel';
    }
  }

  function saveCalSidebarPrefs(prefs) {
    try { localStorage.setItem(CAL_SIDEBAR_KEY, JSON.stringify(prefs)); } catch (_) { /* ignore */ }
  }

  function readCalSidebarPrefs() {
    try {
      const raw = localStorage.getItem(CAL_SIDEBAR_KEY);
      return raw ? JSON.parse(raw) : { width: CAL_SIDEBAR_DEFAULT, collapsed: false };
    } catch (_) {
      return { width: CAL_SIDEBAR_DEFAULT, collapsed: false };
    }
  }

  function initCalSidebarLayout() {
    applyCalSidebarPrefs(readCalSidebarPrefs());
    const handle = g('cal-sidebar-resize-handle');
    const layout = g('cal-month-layout');
    if (!handle || !layout) return;
    let dragging = false;
    handle.addEventListener('mousedown', (ev) => {
      if (window.matchMedia('(max-width: 1100px)').matches) return;
      dragging = true;
      layout.classList.remove('cal-sidebar-hidden');
      handle.classList.add('cal-dragging');
      ev.preventDefault();
    });
    handle.addEventListener('dblclick', () => {
      const prefs = readCalSidebarPrefs();
      prefs.width = CAL_SIDEBAR_DEFAULT;
      prefs.collapsed = false;
      saveCalSidebarPrefs(prefs);
      applyCalSidebarPrefs(prefs);
    });
    document.addEventListener('mousemove', (ev) => {
      if (!dragging) return;
      const rect = layout.getBoundingClientRect();
      const w = Math.max(CAL_SIDEBAR_MIN, Math.min(CAL_SIDEBAR_MAX, rect.right - ev.clientX));
      layout.style.setProperty('--cal-sidebar-width', w + 'px');
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('cal-dragging');
      const w = parseInt(getComputedStyle(layout).getPropertyValue('--cal-sidebar-width'), 10) || CAL_SIDEBAR_DEFAULT;
      const prefs = readCalSidebarPrefs();
      prefs.width = w;
      prefs.collapsed = false;
      saveCalSidebarPrefs(prefs);
    });
  }

  window.calToggleSidebar = function () {
    const prefs = readCalSidebarPrefs();
    prefs.collapsed = !prefs.collapsed;
    saveCalSidebarPrefs(prefs);
    applyCalSidebarPrefs(prefs);
  };

  window.fetchCalendarBroadcastToday = async function () {
    try {
      return await calFetch('/calendar/broadcast-today');
    } catch (_) {
      return null;
    }
  };

  async function renderCalendarScheduleHeatmap() {
    const body = g('cal-schedule-heatmap-body');
    if (!body) return;
    body.textContent = 'Loading heatmap…';
    try {
      const d = await calFetch('/intelligence/schedule-heatmap?days=28&limit=8');
      if (!d.ok || !d.grid || !d.grid.length) {
        body.textContent = 'No analytics data yet — sync Intelligence analytics first.';
        return;
      }
      const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      let html = '<div style="display:grid;grid-template-columns:34px repeat(24,minmax(8px,1fr));gap:2px;font-size:10px;max-width:100%;overflow-x:auto;">';
      html += '<div></div>';
      for (let h = 0; h < 24; h++) {
        html += '<div style="text-align:center;color:rgba(255,255,255,0.35);">' + h + '</div>';
      }
      for (let dIdx = 0; dIdx < 7; dIdx++) {
        html += '<div style="color:rgba(255,255,255,0.55);padding-top:2px;">' + dayLabels[dIdx] + '</div>';
        const row = d.grid[dIdx] || [];
        for (let h = 0; h < 24; h++) {
          const cell = row[h] || { intensity: 0, score: 0 };
          const alpha = 0.06 + Math.min(0.92, (cell.intensity || 0) * 0.009);
          html += '<div title="' + esc(dayLabels[dIdx] + ' ' + h + ':00 ET · watch ' + (cell.score || 0)) + '" style="height:14px;border-radius:2px;background:rgba(52,152,219,' + alpha.toFixed(2) + ');"></div>';
        }
      }
      html += '</div>';
      if (d.topSlots && d.topSlots.length) {
        html += '<div style="margin-top:8px;font-size:12px;color:rgba(255,255,255,0.55);">Best publish slots: '
          + d.topSlots.map((s) => esc(s.label)).join(' · ') + '</div>';
      }
      body.innerHTML = html;
    } catch (e) {
      body.textContent = '❌ ' + (e.message || 'heatmap failed');
    }
  }

  window.renderCalendarScheduleHeatmap = renderCalendarScheduleHeatmap;

})();
