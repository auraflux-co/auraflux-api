/**
 * Content Calendar dashboard — master plan for production, live streams, and VOD publish.
 */
(function () {
  const CAL_BASE = (typeof CFG !== 'undefined' && CFG.ffmpegUrl) || 'http://localhost:3000';
  let _calPlan = null;
  let _ownerUnlocked = sessionStorage.getItem('cwn_calendar_owner') === '1';
  let _scheduleCtx = null;

  function g(id) { return document.getElementById(id); }

  async function calFetch(path, opts) {
    const r = await fetch(CAL_BASE + path, opts);
    return r.json();
  }

  function slotClass(item) {
    if (item.status === 'published') return 'cal-published';
    if (item.status === 'in_production') return 'cal-progress';
    if (item.status === 'publish_scheduled') return 'cal-scheduled';
    if (item.status === 'skipped') return 'cal-skipped';
    return item.kind === 'short' ? 'short' : item.contentType === 'news' ? 'news' : item.contentType === 'twitch' ? 'twitch' : item.contentType === 'nba' ? 'nba' : 'short';
  }

  function slotSub(it) {
    if (it.status === 'skipped') return it.skipReason;
    if (it.status === 'published') return '✓ published';
    if (it.status === 'in_production') return '◐ in production';
    if (it.status === 'publish_scheduled') {
      const plat = (it.linkedPlatforms || it.publishPlatforms || []).join('+');
      const hint = it.jobHint ? ` → ${it.jobHint}` : '';
      return `⏱ scheduled${hint}${plat ? ' · ' + plat : ''}`;
    }
    const plat = (it.publishPlatforms || []).join('+') || '';
    return plat ? '→ ' + plat + ' · click to schedule' : 'click to schedule';
  }

  function renderGuidelines(plan) {
    const el = g('cal-guidelines');
    if (!el || !plan?.guidelines) return;
    const live = (plan.guidelines.live || []).map((l) => `<li>${l}</li>`).join('');
    const vod = (plan.guidelines.vod || []).map((l) => `<li>${l}</li>`).join('');
    el.innerHTML = `
      <div class="cal-guide-col"><b style="color:#c7af4f;">LIVE</b><ul>${live}</ul></div>
      <div class="cal-guide-col"><b style="color:#c7af4f;">VOD / PUBLISH</b><ul>${vod}</ul></div>
      <div style="font-size:10px;color:rgba(255,255,255,0.35);margin-top:8px;">
        Hard rules — only owner PIN can override. ${plan.overridesActive ? plan.overridesActive + ' override(s) active.' : 'No overrides.'}
      </div>`;
  }

  function renderLiveStrip(day) {
    if (!day?.live) return '';
    const tt = day.live.twitchTv;
    const parts = (day.live.youtubeLive?.dayparts || []).map((dp) =>
      `<span class="cal-live-chip">${dp.start}–${dp.end} ${dp.label} <i>(${dp.mode})</i></span>`).join('');
    return `<div class="cal-live-strip">
      <span class="cal-live-chip cal-live-twitch">Twitch TV ${tt.window || ''}</span>
      ${parts}
    </div>`;
  }

  function renderWeek(plan) {
    const grid = g('calendar-grid');
    const schedule = g('schedule-list');
    if (!grid || !plan?.days) return;

    const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
    grid.innerHTML = '';
    let schedHtml = '';

    plan.days.forEach((day, i) => {
      const prodItems = day.production || [];
      const div = document.createElement('div');
      div.className = 'cal-day' + (day.isToday ? ' cal-day-today' : '');

      const prodHtml = prodItems.map((it) => {
        const sub = slotSub(it);
        const clickable = it.status !== 'skipped' && it.status !== 'published';
        const click = clickable
          ? ` onclick="calOpenSlot('${day.date}','${it.id}','${it.contentType || ''}')"`
          : '';
        return `<div class="cal-item ${slotClass(it)}" title="${sub}"${click} style="${clickable ? '' : 'cursor:default;'}">
          ${it.time} ${it.label}
          <div class="cal-item-sub">${sub}</div>
        </div>`;
      }).join('');

      div.innerHTML = `
        <div class="cal-day-name">${DAYS[i]}${day.isToday ? ' <span style="font-size:8px;color:#c7af4f;">TODAY</span>' : ''}</div>
        <div class="cal-section-label">LIVE STREAMS</div>
        ${renderLiveStrip(day)}
        <div class="cal-section-label">PRODUCE + PUBLISH</div>
        ${prodHtml}
        ${day.isToday && _ownerUnlocked ? `<button class="cal-override-btn" onclick="calToggleSlot('${day.date}','news_long')">Override today</button>` : ''}`;

      grid.appendChild(div);

      schedHtml += `<strong style="color:#c7af4f">${DAYS[i]}${day.isToday ? ' (TODAY)' : ''}</strong><br>`;
      prodItems.forEach((it) => {
        schedHtml += `&nbsp;&nbsp;${it.time} ${it.label} [${it.status}]${it.jobHint ? ' → ' + it.jobHint : ''}<br>`;
      });
      (day.live?.youtubeLive?.dayparts || []).forEach((dp) => {
        schedHtml += `&nbsp;&nbsp;🔴 ${dp.start}–${dp.end} ${dp.label}<br>`;
      });
      schedHtml += '<br>';
    });

    if (schedule) schedule.innerHTML = schedHtml;
  }

  window.calCloseSchedule = function () {
    const m = g('cal-schedule-modal');
    if (m) m.classList.remove('open');
    _scheduleCtx = null;
  };

  window.calPickJob = async function (jobId) {
    if (!_scheduleCtx) return;
    const { date, slotId, label } = _scheduleCtx;
    const d = await calFetch('/calendar/schedule-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, slotId, date }),
    });
    if (d.ok) {
      alert(d.message || 'Scheduled');
      calCloseSchedule();
      calendarRefresh();
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
    if (sub) sub.textContent = `${date} · ${slotId} — pick an assembled job to publish at slot time`;
    list.innerHTML = '<div style="font-size:11px;color:rgba(255,255,255,0.5);">Loading jobs…</div>';
    modal.classList.add('open');

    const data = await calFetch('/calendar/eligible-jobs?contentType=' + encodeURIComponent(contentType || ''));
    const jobs = data.jobs || [];
    if (!jobs.length) {
      list.innerHTML = '<div style="font-size:11px;color:#e74c3c;">No assembled jobs for this slot yet. Finish Gate 4 assembly first.</div>';
      return;
    }
    list.innerHTML = jobs.map((j) =>
      `<button type="button" class="cal-job-pick" onclick="calPickJob('${j.jobId}')">
        <b>${j.title}</b><br><span style="font-size:9px;color:rgba(255,255,255,0.45);">${j.jobId} · ${j.stage}</span>
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
      alert('Owner mode on — you can override schedule rules.');
      calendarRefresh();
    } else {
      alert(verify.error || 'Wrong PIN — overrides disabled.');
    }
  };

  window.calToggleSlot = async function (date, slotId) {
    if (!_ownerUnlocked) return alert('Unlock owner mode first.');
    const pin = prompt('Confirm owner PIN:');
    if (!pin) return;
    const disable = confirm('Disable this slot for ' + date + '? Cancel = force enable.');
    const d = await calFetch('/calendar/override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pin, type: 'production', date, slotId,
        patch: disable ? { disabled: true } : { forced: true, disabled: false },
        reason: disable ? 'Owner disabled slot' : 'Owner forced slot',
      }),
    });
    if (d.ok) calendarRefresh();
    else alert(d.error || 'Override failed');
  };

  window.calendarRefresh = async function () {
    try {
      _calPlan = await calFetch('/calendar/plan');
    } catch (_) {
      _calPlan = null;
    }
    if (!_calPlan?.ok) {
      if (typeof buildCalendar === 'function') buildCalendar();
      return;
    }
    renderGuidelines(_calPlan);
    renderWeek(_calPlan);
    renderPublishRules(_calPlan);
  };

  function renderPublishRules(plan) {
    const el = g('cal-publish-rules');
    if (!el || !plan.vodPublish) return;
    const rows = [];
    for (const [plat, rules] of Object.entries(plan.vodPublish)) {
      rows.push(`<div style="margin-bottom:8px;"><b style="color:#c7af4f;text-transform:uppercase;">${plat}</b><br>
        <span style="font-size:10px;color:rgba(255,255,255,0.5);">${JSON.stringify(rules).replace(/[{}"]/g, ' ')}</span></div>`);
    }
    el.innerHTML = rows.join('');
  }

  window.calendarPageInit = function () {
    calendarRefresh();
  };

  window.fetchCalendarBroadcastToday = async function () {
    try {
      return await calFetch('/calendar/broadcast-today');
    } catch (_) {
      return null;
    }
  };

})();
