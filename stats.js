(() => {
  'use strict';

  const cfg = window.RCP_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabasePublishableKey) return;

  const projectRef = new URL(cfg.supabaseUrl).hostname.split('.')[0];
  const authStorageKey = `sb-${projectRef}-auth-token`;
  const MONTHS = ['Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'];
  const WEEKDAYS = ['Pon','Wt','Śr','Czw','Pt','Sob','Nd'];
  const moneyFmt = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' });

  let contextCache = null;
  let decorateTimer = null;
  let decorating = false;
  let statsState = null;

  function readSession() {
    const keys = [authStorageKey, ...Object.keys(localStorage).filter(k => k.includes(projectRef) && k.includes('auth-token'))];
    for (const key of [...new Set(keys)]) {
      try {
        const value = JSON.parse(localStorage.getItem(key) || 'null');
        if (value?.access_token && value?.user?.id) return value;
      } catch (_) {}
    }
    return null;
  }

  async function api(path, options = {}) {
    const session = readSession();
    if (!session?.access_token) throw new Error('Sesja wygasła. Zaloguj się ponownie.');

    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
      method: options.method || 'GET',
      headers: {
        apikey: cfg.supabasePublishableKey,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {})
      },
      body: options.body == null ? undefined : JSON.stringify(options.body)
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.message || data?.details || data?.hint || data?.code || `Błąd ${res.status}`);
    }
    return data;
  }

  async function apiAll(path) {
    const session = readSession();
    if (!session?.access_token) throw new Error('Sesja wygasła. Zaloguj się ponownie.');

    const rows = [];
    const pageSize = 1000;
    for (let from = 0; from < 10000; from += pageSize) {
      const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
        headers: {
          apikey: cfg.supabasePublishableKey,
          Authorization: `Bearer ${session.access_token}`,
          Accept: 'application/json',
          'Range-Unit': 'items',
          Range: `${from}-${from + pageSize - 1}`
        }
      });
      if (res.status === 416) break;
      const page = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(page?.message || page?.details || page?.hint || page?.code || `Błąd ${res.status}`);
      }
      const list = Array.isArray(page) ? page : [];
      rows.push(...list);
      if (list.length < pageSize) break;
    }
    return rows;
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  function hhmm(minutes) {
    const mins = Math.max(0, Math.floor(Number(minutes || 0)));
    return `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min`;
  }

  function fmtMoney(value) {
    return value == null ? '—' : moneyFmt.format(Number(value));
  }

  function dateParts(iso, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date(iso));
    return {
      year: Number(parts.find(p => p.type === 'year')?.value || 0),
      month: Number(parts.find(p => p.type === 'month')?.value || 0),
      day: Number(parts.find(p => p.type === 'day')?.value || 0)
    };
  }

  function dateKey(iso, timeZone) {
    const p = dateParts(iso, timeZone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  }

  function todayKey(timeZone) {
    return dateKey(new Date().toISOString(), timeZone);
  }

  function timeLabel(iso, timeZone) {
    if (!iso) return '—';
    return new Intl.DateTimeFormat('pl-PL', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(iso));
  }

  function fullDateLabel(key) {
    return new Intl.DateTimeFormat('pl-PL', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(new Date(`${key}T12:00:00Z`));
  }

  async function resolveContext() {
    const session = readSession();
    if (!session?.user?.id) return null;

    const selectedId = localStorage.getItem('rcp:selected-membership') || '';
    const cacheKey = `${session.user.id}:${selectedId}`;
    if (contextCache?.key === cacheKey && Date.now() - contextCache.at < 8000) {
      return contextCache.value;
    }

    const memberships = await api(
      `organization_members?select=id,organization_id,user_id,first_name,last_name,role,active&user_id=eq.${encodeURIComponent(session.user.id)}&active=eq.true&order=created_at.asc`
    );
    const list = Array.isArray(memberships) ? memberships : [];
    const membership = list.find(m => m.id === selectedId) || list[0] || null;
    if (!membership) return null;

    const orgRows = await api(
      `organizations?select=id,name,slug,timezone&id=eq.${encodeURIComponent(membership.organization_id)}&limit=1`
    );
    const organization = Array.isArray(orgRows) ? orgRows[0] || null : null;
    const value = {
      membership,
      organization,
      timeZone: organization?.timezone || cfg.timezone || 'Europe/Warsaw'
    };
    contextCache = { key: cacheKey, at: Date.now(), value };
    return value;
  }

  async function loadStatsData(ctx) {
    const fields = 'id,member_id,organization_id,first_name,last_name,started_at,ended_at,duration_minutes,hourly_rate,earnings,note,created_at,updated_at';
    let sessions;
    let employees = [];

    if (ctx.membership.role === 'admin') {
      [sessions, employees] = await Promise.all([
        apiAll(`work_sessions_with_earnings?select=${fields}&organization_id=eq.${encodeURIComponent(ctx.membership.organization_id)}&order=started_at.desc`),
        api(`organization_members?select=id,first_name,last_name,active&organization_id=eq.${encodeURIComponent(ctx.membership.organization_id)}&role=eq.employee&order=first_name.asc,last_name.asc`)
      ]);
      employees = Array.isArray(employees) ? employees : [];
    } else {
      sessions = await apiAll(
        `work_sessions_with_earnings?select=${fields}&member_id=eq.${encodeURIComponent(ctx.membership.id)}&order=started_at.desc`
      );
      employees = [{
        id: ctx.membership.id,
        first_name: ctx.membership.first_name,
        last_name: ctx.membership.last_name,
        active: true
      }];
    }

    return { sessions: Array.isArray(sessions) ? sessions : [], employees };
  }

  function employeeName(row) {
    return [row?.first_name, row?.last_name].filter(Boolean).join(' ').trim() || 'Pracownik';
  }

  function selectedSessions() {
    if (!statsState) return [];
    if (!statsState.filterMemberId) return statsState.sessions;
    return statsState.sessions.filter(s => s.member_id === statsState.filterMemberId);
  }

  function monthKeyForSession(session) {
    const p = dateParts(session.started_at, statsState.ctx.timeZone);
    return `${p.year}-${String(p.month).padStart(2, '0')}`;
  }

  function buildMonthRange(sessions) {
    const now = dateParts(new Date().toISOString(), statsState.ctx.timeZone);
    let earliestYear = now.year;
    let earliestMonth = now.month;

    if (sessions.length) {
      const last = sessions[sessions.length - 1];
      const p = dateParts(last.started_at, statsState.ctx.timeZone);
      earliestYear = p.year;
      earliestMonth = p.month;
    }

    const result = [];
    let y = now.year;
    let m = now.month;
    while (y > earliestYear || (y === earliestYear && m >= earliestMonth)) {
      result.push({ year: y, month: m });
      m -= 1;
      if (m === 0) {
        m = 12;
        y -= 1;
      }
    }
    return result;
  }

  function monthSessions(year, month) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    return selectedSessions().filter(s => monthKeyForSession(s) === key);
  }

  function monthSummary(list) {
    const days = new Set(list.map(s => dateKey(s.started_at, statsState.ctx.timeZone)));
    const minutes = list.reduce((sum, s) => sum + Number(s.duration_minutes || 0), 0);
    const earnings = list.reduce((sum, s) => sum + Number(s.earnings || 0), 0);
    return { days: days.size, minutes, earnings };
  }

  function filterToolbar() {
    if (statsState.ctx.membership.role !== 'admin') return '';

    const options = statsState.employees.map(m => {
      const suffix = m.active ? '' : ' — nieaktywny';
      return `<option value="${esc(m.id)}" ${statsState.filterMemberId === m.id ? 'selected' : ''}>${esc(employeeName(m) + suffix)}</option>`;
    }).join('');

    return `
      <div class="rcp-stats-filter">
        <label for="rcpStatsEmployee">Pracownik</label>
        <select id="rcpStatsEmployee" class="select">
          <option value="" ${statsState.filterMemberId ? '' : 'selected'}>Wszyscy pracownicy</option>
          ${options}
        </select>
      </div>`;
  }

  function selectedPersonLabel() {
    if (!statsState.filterMemberId) {
      return statsState.ctx.membership.role === 'admin' ? 'Wszyscy pracownicy' : employeeName(statsState.ctx.membership);
    }
    const m = statsState.employees.find(e => e.id === statsState.filterMemberId);
    return employeeName(m);
  }

  function screenHeader(title, subtitle, backAction = 'close') {
    return `
      <div class="rcp-stats-head">
        <button class="rcp-stats-back" type="button" data-stats-back="${backAction}">←</button>
        <div>
          <div class="rcp-stats-title">${esc(title)}</div>
          <div class="rcp-stats-subtitle">${esc(subtitle || '')}</div>
        </div>
      </div>`;
  }

  function bindCommon() {
    const screen = document.getElementById('rcpStatsScreen');
    if (!screen) return;

    screen.querySelectorAll('[data-stats-back]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.statsBack === 'months') renderMonths();
        else closeStats();
      });
    });

    const select = screen.querySelector('#rcpStatsEmployee');
    if (select) {
      select.addEventListener('change', () => {
        statsState.filterMemberId = select.value || '';
        if (statsState.view === 'month') renderMonth(statsState.year, statsState.month);
        else renderMonths();
      });
    }
  }

  function renderMonths() {
    if (!statsState) return;
    statsState.view = 'months';

    const sessions = selectedSessions();
    const months = buildMonthRange(sessions);
    const now = dateParts(new Date().toISOString(), statsState.ctx.timeZone);
    const byYear = new Map();

    for (const item of months) {
      if (!byYear.has(item.year)) byYear.set(item.year, []);
      byYear.get(item.year).push(item);
    }

    const yearsHtml = [...byYear.entries()].map(([year, items]) => {
      const monthHtml = items.map(({ year: y, month }) => {
        const list = monthSessions(y, month);
        const sum = monthSummary(list);
        const current = y === now.year && month === now.month;
        return `
          <button class="rcp-month-card" type="button" data-stats-month="${y}-${month}">
            <div class="rcp-month-main">
              <span class="rcp-month-icon">📅</span>
              <span>${MONTHS[month - 1]}${current ? ' <b>(teraz)</b>' : ''}</span>
            </div>
            <div class="rcp-month-meta">${sum.days} dni · ${hhmm(sum.minutes)}</div>
          </button>`;
      }).join('');

      return `
        <section class="rcp-year-section">
          <h2>${year}</h2>
          <div class="rcp-month-list">${monthHtml}</div>
        </section>`;
    }).join('');

    statsState.screen.innerHTML = `
      <div class="rcp-stats-shell">
        ${screenHeader('Statystyki', selectedPersonLabel(), 'close')}
        ${filterToolbar()}
        ${yearsHtml || '<div class="card"><div class="muted">Brak danych.</div></div>'}
      </div>`;

    bindCommon();
    statsState.screen.querySelectorAll('[data-stats-month]').forEach(btn => {
      btn.addEventListener('click', () => {
        const [y, m] = btn.dataset.statsMonth.split('-').map(Number);
        renderMonth(y, m);
      });
    });
  }

  function renderMonth(year, month) {
    if (!statsState) return;
    statsState.view = 'month';
    statsState.year = year;
    statsState.month = month;
    statsState.screen.dataset.statsYear = String(year);
    statsState.screen.dataset.statsMonth = String(month);
    statsState.screen.dataset.statsFilterMemberId = statsState.filterMemberId || '';
    statsState.screen.dataset.statsViewerRole = statsState.ctx.membership.role;

    const list = monthSessions(year, month);
    const summary = monthSummary(list);
    const sessionsByDay = new Map();

    for (const s of list) {
      const key = dateKey(s.started_at, statsState.ctx.timeZone);
      if (!sessionsByDay.has(key)) sessionsByDay.set(key, []);
      sessionsByDay.get(key).push(s);
    }

    const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const today = todayKey(statsState.ctx.timeZone);
    const cells = [];

    for (let i = 0; i < firstWeekday; i += 1) cells.push('<div class="rcp-cal-empty"></div>');

    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const worked = sessionsByDay.has(key);
      const isToday = key === today;
      const classes = ['rcp-cal-day'];
      if (worked) classes.push('rcp-cal-worked');
      if (isToday) classes.push('rcp-cal-today');

      cells.push(`
        <button class="${classes.join(' ')}" type="button" data-stats-day="${key}" aria-label="${esc(fullDateLabel(key))}">
          <span>${day}</span>
          ${worked && sessionsByDay.get(key).length > 1 ? `<small>${sessionsByDay.get(key).length}</small>` : ''}
        </button>`);
    }

    const earningsLine = list.some(s => s.earnings != null)
      ? `<div>Kwota: <b>${fmtMoney(summary.earnings)}</b></div>`
      : '';

    statsState.screen.innerHTML = `
      <div class="rcp-stats-shell">
        ${screenHeader(MONTHS[month - 1], `${year} · ${selectedPersonLabel()}`, 'months')}
        ${filterToolbar()}
        <div class="rcp-calendar-card">
          <div class="rcp-calendar-weekdays">${WEEKDAYS.map(d => `<div>${d}</div>`).join('')}</div>
          <div class="rcp-calendar-grid">${cells.join('')}</div>
          <div class="rcp-calendar-summary">
            <div>Dni pracy: <b>${summary.days}</b></div>
            <div>Czas: <b>${hhmm(summary.minutes)}</b></div>
            ${earningsLine}
          </div>
        </div>
        <button class="btn btn-light btn-block rcp-stats-bottom-back" type="button" data-stats-back="months">← Powrót do statystyk</button>
      </div>`;

    bindCommon();
    statsState.screen.querySelectorAll('[data-stats-day]').forEach(btn => {
      btn.addEventListener('click', () => openDayDetails(btn.dataset.statsDay, sessionsByDay.get(btn.dataset.statsDay) || []));
    });
  }

  async function gpsForSessions(ids) {
    if (!ids.length) return new Map();
    const rows = await api(
      `work_sessions?select=id,stop_latitude,stop_longitude,stop_accuracy_m,stop_location_status,stop_location_at&id=in.(${ids.join(',')})`
    );
    return new Map((Array.isArray(rows) ? rows : []).map(r => [r.id, r]));
  }

  function gpsHtml(row) {
    if (!row?.stop_location_status) return '<div><b>GPS końca:</b> brak danych</div>';

    if (
      row.stop_location_status === 'captured' &&
      Number.isFinite(Number(row.stop_latitude)) &&
      Number.isFinite(Number(row.stop_longitude))
    ) {
      const lat = Number(row.stop_latitude);
      const lon = Number(row.stop_longitude);
      const accuracy = Number(row.stop_accuracy_m);
      const accuracyText = Number.isFinite(accuracy) ? ` · ±${Math.round(accuracy)} m` : '';
      const mapUrl = `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lon}`)}`;
      return `<div><b>GPS końca:</b> ${lat.toFixed(6)}, ${lon.toFixed(6)}${accuracyText} · <a href="${mapUrl}" target="_blank" rel="noopener noreferrer">Mapa</a></div>`;
    }

    const labels = {
      denied: 'brak zgody na lokalizację',
      unavailable: 'lokalizacja niedostępna',
      timeout: 'nie udało się ustalić pozycji',
      unsupported: 'urządzenie nie obsługuje lokalizacji',
      error: 'nie udało się zapisać lokalizacji'
    };
    return `<div><b>GPS końca:</b> ${esc(labels[row.stop_location_status] || row.stop_location_status)}</div>`;
  }

  async function openDayDetails(dayKey, sessions) {
    if (document.getElementById('rcpStatsDayDialog')) return;

    const wrap = document.createElement('div');
    wrap.id = 'rcpStatsDayDialog';
    wrap.className = 'dialog-backdrop rcp-stats-day-backdrop';
    wrap.innerHTML = `
      <div class="dialog rcp-stats-day-dialog">
        <div class="section-head">
          <div>
            <h3 style="margin:0">${esc(fullDateLabel(dayKey))}</h3>
            <div class="muted small">${sessions.length ? 'Ładowanie szczegółów…' : 'Brak wpisów czasu pracy.'}</div>
          </div>
          <button class="mini-btn" type="button" data-day-close>Zamknij</button>
        </div>
        <div id="rcpStatsDayContent">${sessions.length ? '<div class="spinner"></div>' : ''}</div>
      </div>`;
    wrap.dataset.dayKey = dayKey;
    wrap.dataset.statsFilterMemberId = statsState.filterMemberId || '';
    wrap.dataset.statsViewerRole = statsState.ctx.membership.role;
    document.body.appendChild(wrap);

    const close = () => wrap.remove();
    wrap.querySelector('[data-day-close]').addEventListener('click', close);
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

    if (!sessions.length) return;

    let gps = new Map();
    try {
      gps = await gpsForSessions(sessions.map(s => s.id));
    } catch (_) {}

    const totalMinutes = sessions.reduce((sum, s) => sum + Number(s.duration_minutes || 0), 0);
    const totalEarnings = sessions.reduce((sum, s) => sum + Number(s.earnings || 0), 0);
    const hasEarnings = sessions.some(s => s.earnings != null);

    const cards = sessions
      .slice()
      .sort((a, b) => new Date(a.started_at) - new Date(b.started_at))
      .map(s => {
        const who = statsState.ctx.membership.role === 'admin'
          ? `<div class="rcp-detail-person">${esc(employeeName(s))}</div>`
          : '';
        const rate = s.hourly_rate == null ? '' : `<div><b>Stawka:</b> ${fmtMoney(s.hourly_rate)}/h</div>`;
        const amount = s.earnings == null ? '' : `<div><b>Kwota:</b> ${fmtMoney(s.earnings)}</div>`;
        const note = s.note ? esc(s.note) : '<span class="muted">brak</span>';
        return `
          <div class="rcp-day-entry">
            ${who}
            <div class="rcp-detail-grid">
              <div><b>Start:</b> ${timeLabel(s.started_at, statsState.ctx.timeZone)}</div>
              <div><b>Koniec:</b> ${s.ended_at ? timeLabel(s.ended_at, statsState.ctx.timeZone) : '<span class="rcp-live">TRWA</span>'}</div>
              <div><b>Czas:</b> ${hhmm(s.duration_minutes)}</div>
              ${rate}
              ${amount}
            </div>
            <div class="rcp-detail-comment"><b>Komentarz:</b> ${note}</div>
            <div class="rcp-detail-gps">${gpsHtml(gps.get(s.id))}</div>
          </div>`;
      }).join('');

    wrap.querySelector('.muted.small').textContent = `${sessions.length} ${sessions.length === 1 ? 'wpis' : 'wpisy'} · ${hhmm(totalMinutes)}`;
    wrap.querySelector('#rcpStatsDayContent').innerHTML = `
      <div class="rcp-day-summary">
        <div><span>Łączny czas</span><b>${hhmm(totalMinutes)}</b></div>
        ${hasEarnings ? `<div><span>Łączna kwota</span><b>${fmtMoney(totalEarnings)}</b></div>` : ''}
      </div>
      <div class="rcp-day-entry-list">${cards}</div>`;
  }

  function closeStats() {
    const screen = document.getElementById('rcpStatsScreen');
    if (screen) screen.remove();
    document.body.classList.remove('rcp-stats-open');
    statsState = null;
  }

  async function openStats(ctx) {
    if (document.getElementById('rcpStatsScreen')) return;

    const screen = document.createElement('div');
    screen.id = 'rcpStatsScreen';
    screen.className = 'rcp-stats-screen';
    screen.innerHTML = `
      <div class="rcp-stats-shell">
        ${screenHeader('Statystyki', 'Ładowanie danych…', 'close')}
        <div class="card"><div class="spinner"></div></div>
      </div>`;
    document.body.appendChild(screen);
    document.body.classList.add('rcp-stats-open');

    screen.querySelector('[data-stats-back="close"]')?.addEventListener('click', closeStats);

    try {
      const data = await loadStatsData(ctx);
      statsState = {
        ctx,
        screen,
        sessions: data.sessions,
        employees: data.employees,
        filterMemberId: '',
        view: 'months',
        year: null,
        month: null
      };
      renderMonths();
    } catch (err) {
      screen.innerHTML = `
        <div class="rcp-stats-shell">
          ${screenHeader('Statystyki', 'Nie udało się wczytać danych', 'close')}
          <div class="notice notice-error">${esc(err?.message || 'Błąd pobierania danych.')}</div>
        </div>`;
      screen.querySelector('[data-stats-back="close"]')?.addEventListener('click', closeStats);
    }
  }

  function addEmployeeStatsCard(ctx) {
    if (document.getElementById('rcpStatsEmployeeCard')) return;
    const hero = document.getElementById('punchBtn')?.closest('.card.hero');
    if (!hero) return;

    const card = document.createElement('div');
    card.id = 'rcpStatsEmployeeCard';
    card.className = 'card';
    card.innerHTML = `
      <button class="btn btn-light btn-block rcp-stats-launch" type="button">
        <span aria-hidden="true">📊</span> STATYSTYKI
      </button>
      <div class="small muted" style="text-align:center;margin-top:8px">Miesiące, kalendarz i szczegóły każdego dnia</div>`;

    const anchor = document.getElementById('rcpVacationEmployeeCard') || hero;
    anchor.insertAdjacentElement('afterend', card);
    card.querySelector('button').addEventListener('click', () => openStats(ctx));
  }

  function addAdminStatsCard(ctx) {
    if (document.getElementById('rcpStatsAdminCard')) return;
    const tabs = document.querySelector('.tabs [data-tab="dashboard"]')?.closest('.tabs');
    if (!tabs) return;

    const card = document.createElement('div');
    card.id = 'rcpStatsAdminCard';
    card.className = 'card rcp-admin-stats-card';
    card.innerHTML = `
      <button class="btn btn-light btn-block rcp-stats-launch" type="button">
        <span aria-hidden="true">📊</span> STATYSTYKI CZASU PRACY
      </button>
      <div class="small muted" style="text-align:center;margin-top:8px">Firma, pracownicy, miesiące i szczegóły dni</div>`;

    const anchor = document.getElementById('rcpVacationAdminCard') || tabs;
    anchor.insertAdjacentElement('afterend', card);
    card.querySelector('button').addEventListener('click', () => openStats(ctx));
  }

  async function decorate() {
    if (decorating || document.getElementById('rcpStatsScreen')) return;

    const employeeUi = document.getElementById('punchBtn');
    const adminUi = document.querySelector('.tabs [data-tab="dashboard"]');
    if (!employeeUi && !adminUi) return;

    if (employeeUi && document.getElementById('rcpStatsEmployeeCard')) return;
    if (adminUi && document.getElementById('rcpStatsAdminCard')) return;

    decorating = true;
    try {
      const ctx = await resolveContext();
      if (!ctx) return;
      if (ctx.membership.role === 'employee' && employeeUi) addEmployeeStatsCard(ctx);
      if (ctx.membership.role === 'admin' && adminUi) addAdminStatsCard(ctx);
    } catch (err) {
      console.warn('RCP statystyki:', err);
    } finally {
      decorating = false;
    }
  }

  function scheduleDecorate() {
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(decorate, 140);
  }

  const observer = new MutationObserver(scheduleDecorate);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('load', () => setTimeout(decorate, 500));
})();