(() => {
  'use strict';

  const cfg = window.RCP_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabasePublishableKey) return;

  const projectRef = new URL(cfg.supabaseUrl).hostname.split('.')[0];
  const authStorageKey = `sb-${projectRef}-auth-token`;
  const money = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' });

  let contextCache = null;
  let financeCache = null;
  let decorateTimer = null;
  let decorating = false;
  let dayInjecting = false;
  let calendarDecorating = false;

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

  async function api(path, { method = 'GET', body, prefer = '' } = {}) {
    const session = readSession();
    if (!session?.access_token) throw new Error('Sesja wygasła. Zaloguj się ponownie.');
    const headers = {
      apikey: cfg.supabasePublishableKey,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    if (prefer) headers.Prefer = prefer;

    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.message || data?.details || data?.hint || data?.code || `Błąd ${res.status}`);
    return data;
  }

  async function apiAll(path) {
    const session = readSession();
    if (!session?.access_token) throw new Error('Sesja wygasła. Zaloguj się ponownie.');

    const result = [];
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
      if (!res.ok) throw new Error(page?.message || page?.details || page?.hint || page?.code || `Błąd ${res.status}`);
      const rows = Array.isArray(page) ? page : [];
      result.push(...rows);
      if (rows.length < pageSize) break;
    }
    return result;
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

  function fmtMoney(value) {
    return money.format(Number(value || 0));
  }

  function employeeName(row) {
    return [row?.first_name, row?.last_name].filter(Boolean).join(' ').trim() || 'Pracownik';
  }

  function typeLabel(type) {
    return type === 'advance' ? 'Zaliczka' : 'Wypłata';
  }

  function dateLabel(key) {
    if (!key) return '';
    return new Intl.DateTimeFormat('pl-PL', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(new Date(`${key}T12:00:00Z`));
  }

  function dateTimeLabel(iso, timeZone) {
    if (!iso) return '';
    return new Intl.DateTimeFormat('pl-PL', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(iso));
  }

  function balanceLabel(value) {
    if (value > 0.004) return { label: 'Do wypłaty', cls: 'positive' };
    if (value < -0.004) return { label: 'Nadpłata', cls: 'negative' };
    return { label: 'Rozliczone', cls: 'zero' };
  }

  function toast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = `notice notice-${type}`;
    el.textContent = message;
    el.style.position = 'fixed';
    el.style.left = '50%';
    el.style.bottom = '20px';
    el.style.transform = 'translateX(-50%)';
    el.style.zIndex = '1600';
    el.style.width = 'min(92vw, 520px)';
    el.style.boxShadow = '0 14px 34px rgba(17,24,39,.22)';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  async function resolveContext() {
    const session = readSession();
    if (!session?.user?.id) return null;

    const selectedId = localStorage.getItem('rcp:selected-membership') || '';
    const key = `${session.user.id}:${selectedId}`;
    if (contextCache?.key === key && Date.now() - contextCache.at < 8000) return contextCache.value;

    const memberships = await api(
      `organization_members?select=id,organization_id,user_id,first_name,last_name,role,active&user_id=eq.${encodeURIComponent(session.user.id)}&active=eq.true&order=created_at.asc`
    );
    const list = Array.isArray(memberships) ? memberships : [];
    const membership = list.find(m => m.id === selectedId) || list[0] || null;
    if (!membership) return null;

    const orgRows = await api(
      `organizations?select=id,name,timezone&id=eq.${encodeURIComponent(membership.organization_id)}&limit=1`
    );
    const organization = Array.isArray(orgRows) ? orgRows[0] || null : null;

    const value = {
      session,
      membership,
      organization,
      timeZone: organization?.timezone || cfg.timezone || 'Europe/Warsaw'
    };
    contextCache = { key, at: Date.now(), value };
    return value;
  }

  async function loadFinance(ctx, force = false) {
    const key = `${ctx.membership.organization_id}:${ctx.membership.role}:${ctx.membership.id}`;
    if (!force && financeCache?.key === key && Date.now() - financeCache.at < 12000) return financeCache.value;

    let employees;
    let sessions;
    let settlements;

    if (ctx.membership.role === 'admin') {
      [employees, sessions, settlements] = await Promise.all([
        api(`organization_members?select=id,user_id,first_name,last_name,active&organization_id=eq.${encodeURIComponent(ctx.membership.organization_id)}&role=eq.employee&order=first_name.asc,last_name.asc`),
        apiAll(`work_sessions_with_earnings?select=id,member_id,earnings,started_at,ended_at&organization_id=eq.${encodeURIComponent(ctx.membership.organization_id)}&order=started_at.desc`),
        apiAll(`employee_settlements?select=id,member_id,settlement_date,settlement_type,amount,note,created_by,created_at&order=settlement_date.desc,created_at.desc`)
      ]);
    } else {
      employees = [{
        id: ctx.membership.id,
        user_id: ctx.membership.user_id,
        first_name: ctx.membership.first_name,
        last_name: ctx.membership.last_name,
        active: true
      }];
      [sessions, settlements] = await Promise.all([
        apiAll(`work_sessions_with_earnings?select=id,member_id,earnings,started_at,ended_at&member_id=eq.${encodeURIComponent(ctx.membership.id)}&order=started_at.desc`),
        apiAll(`employee_settlements?select=id,member_id,settlement_date,settlement_type,amount,note,created_by,created_at&member_id=eq.${encodeURIComponent(ctx.membership.id)}&order=settlement_date.desc,created_at.desc`)
      ]);
    }

    const value = {
      employees: Array.isArray(employees) ? employees : [],
      sessions: Array.isArray(sessions) ? sessions : [],
      settlements: Array.isArray(settlements) ? settlements : []
    };
    financeCache = { key, at: Date.now(), value };
    return value;
  }

  function summarizeMember(memberId, data) {
    const earned = data.sessions
      .filter(s => s.member_id === memberId)
      .reduce((sum, s) => sum + Number(s.earnings || 0), 0);

    const own = data.settlements.filter(s => s.member_id === memberId);
    const advances = own.filter(s => s.settlement_type === 'advance').reduce((sum, s) => sum + Number(s.amount || 0), 0);
    const payouts = own.filter(s => s.settlement_type === 'payout').reduce((sum, s) => sum + Number(s.amount || 0), 0);
    const balance = earned - advances - payouts;

    return { earned, advances, payouts, paid: advances + payouts, balance };
  }

  function balanceSummaryHtml(summary, compact = false) {
    const state = balanceLabel(summary.balance);
    if (compact) {
      return `
        <div class="rcp-balance-compact ${state.cls}">
          <span>${state.label}</span>
          <b>${fmtMoney(Math.abs(summary.balance))}</b>
        </div>`;
    }

    return `
      <div class="rcp-balance-grid">
        <div><span>Naliczone</span><b>${fmtMoney(summary.earned)}</b></div>
        <div><span>Zaliczki</span><b>${fmtMoney(summary.advances)}</b></div>
        <div><span>Wypłaty</span><b>${fmtMoney(summary.payouts)}</b></div>
        <div class="rcp-balance-main ${state.cls}"><span>${state.label}</span><b>${fmtMoney(Math.abs(summary.balance))}</b></div>
      </div>`;
  }

  async function addEmployeeDashboard(ctx) {
    if (document.getElementById('rcpSettlementEmployeeCard')) return;
    const hero = document.getElementById('punchBtn')?.closest('.card.hero');
    if (!hero) return;

    const card = document.createElement('div');
    card.id = 'rcpSettlementEmployeeCard';
    card.className = 'card rcp-settlement-card';
    card.innerHTML = '<div class="spinner"></div>';

    const anchor = document.getElementById('rcpStatsEmployeeCard') || document.getElementById('rcpVacationEmployeeCard') || hero;
    anchor.insertAdjacentElement('afterend', card);

    try {
      const data = await loadFinance(ctx);
      const summary = summarizeMember(ctx.membership.id, data);
      card.innerHTML = `
        <button class="rcp-settlement-open" type="button">
          <div class="rcp-settlement-open-title"><span>💰</span><b>ROZLICZENIE</b></div>
          ${balanceSummaryHtml(summary, true)}
          <div class="small muted">Naliczenia, zaliczki i wypłaty</div>
        </button>`;
      card.querySelector('button').addEventListener('click', () => openSettlementModule(ctx, ctx.membership.id));
    } catch (err) {
      card.innerHTML = `<div class="notice notice-error">${esc(err?.message || 'Nie udało się pobrać rozliczenia.')}</div>`;
    }
  }

  async function addAdminDashboard(ctx) {
    if (document.getElementById('rcpSettlementAdminCard')) return;
    const tabs = document.querySelector('.tabs [data-tab="dashboard"]')?.closest('.tabs');
    if (!tabs) return;

    const card = document.createElement('div');
    card.id = 'rcpSettlementAdminCard';
    card.className = 'card rcp-settlement-card';
    card.innerHTML = '<div class="spinner"></div>';

    const anchor = document.getElementById('rcpStatsAdminCard') || document.getElementById('rcpVacationAdminCard') || tabs;
    anchor.insertAdjacentElement('afterend', card);

    try {
      const data = await loadFinance(ctx);
      const rows = data.employees.map(member => {
        const summary = summarizeMember(member.id, data);
        const state = balanceLabel(summary.balance);
        return `
          <button type="button" class="rcp-admin-balance-row" data-settlement-member="${member.id}">
            <span class="rcp-admin-balance-name">${esc(employeeName(member))}</span>
            <span class="rcp-admin-balance-value ${state.cls}">${esc(state.label)}: <b>${fmtMoney(Math.abs(summary.balance))}</b></span>
          </button>`;
      }).join('');

      const total = data.employees.reduce((sum, member) => sum + summarizeMember(member.id, data).balance, 0);
      card.innerHTML = `
        <div class="section-head">
          <div>
            <h3>💰 Rozliczenie</h3>
            <div class="muted small">Aktualny bilans finansowy z pracownikami</div>
          </div>
          <button type="button" class="mini-btn" data-settlement-all>Otwórz</button>
        </div>
        <div class="rcp-company-balance">
          <span>Łączny bilans</span>
          <b>${fmtMoney(total)}</b>
        </div>
        <div class="rcp-admin-balance-list">${rows || '<div class="muted small">Brak pracowników.</div>'}</div>`;

      card.querySelector('[data-settlement-all]')?.addEventListener('click', () => openSettlementModule(ctx, ''));
      card.querySelectorAll('[data-settlement-member]').forEach(btn => {
        btn.addEventListener('click', () => openSettlementModule(ctx, btn.dataset.settlementMember));
      });
    } catch (err) {
      card.innerHTML = `<div class="notice notice-error">${esc(err?.message || 'Nie udało się pobrać rozliczeń.')}</div>`;
    }
  }

  function moduleHeader(title, subtitle) {
    return `
      <div class="rcp-stats-head">
        <button class="rcp-stats-back" type="button" data-settlement-close>←</button>
        <div>
          <div class="rcp-stats-title">${esc(title)}</div>
          <div class="rcp-stats-subtitle">${esc(subtitle || '')}</div>
        </div>
      </div>`;
  }

  async function openSettlementModule(ctx, memberId = '') {
    if (document.getElementById('rcpSettlementScreen')) return;
    const screen = document.createElement('div');
    screen.id = 'rcpSettlementScreen';
    screen.className = 'rcp-stats-screen';
    screen.innerHTML = `<div class="rcp-stats-shell">${moduleHeader('Rozliczenie', 'Ładowanie…')}<div class="card"><div class="spinner"></div></div></div>`;
    document.body.appendChild(screen);
    document.body.classList.add('rcp-stats-open');

    const close = () => {
      screen.remove();
      document.body.classList.remove('rcp-stats-open');
    };
    screen.querySelector('[data-settlement-close]').addEventListener('click', close);

    try {
      const data = await loadFinance(ctx, true);
      if (ctx.membership.role === 'employee' || memberId) {
        renderMemberSettlementScreen(screen, ctx, data, memberId || ctx.membership.id, close);
      } else {
        renderAdminSettlementList(screen, ctx, data, close);
      }
    } catch (err) {
      screen.innerHTML = `<div class="rcp-stats-shell">${moduleHeader('Rozliczenie', 'Błąd')}<div class="notice notice-error">${esc(err?.message || 'Nie udało się pobrać danych.')}</div></div>`;
      screen.querySelector('[data-settlement-close]').addEventListener('click', close);
    }
  }

  function renderAdminSettlementList(screen, ctx, data, close) {
    const rows = data.employees.map(member => {
      const summary = summarizeMember(member.id, data);
      const state = balanceLabel(summary.balance);
      return `
        <button type="button" class="rcp-settlement-person-card" data-member="${member.id}">
          <div>
            <div class="row-title">${esc(employeeName(member))}</div>
            <div class="row-sub">Naliczone: ${fmtMoney(summary.earned)} · rozliczono: ${fmtMoney(summary.paid)}</div>
          </div>
          <div class="rcp-balance-compact ${state.cls}">
            <span>${state.label}</span><b>${fmtMoney(Math.abs(summary.balance))}</b>
          </div>
        </button>`;
    }).join('');

    screen.innerHTML = `
      <div class="rcp-stats-shell">
        ${moduleHeader('Rozliczenie', 'Wszyscy pracownicy')}
        <div class="rcp-month-list">${rows || '<div class="card muted">Brak pracowników.</div>'}</div>
      </div>`;
    screen.querySelector('[data-settlement-close]').addEventListener('click', close);
    screen.querySelectorAll('[data-member]').forEach(btn => {
      btn.addEventListener('click', () => renderMemberSettlementScreen(screen, ctx, data, btn.dataset.member, close, true));
    });
  }

  function renderMemberSettlementScreen(screen, ctx, data, memberId, close, allowBackToList = false) {
    const member = data.employees.find(m => m.id === memberId);
    if (!member) {
      screen.innerHTML = `<div class="rcp-stats-shell">${moduleHeader('Rozliczenie', 'Pracownik')}<div class="notice notice-error">Nie znaleziono pracownika.</div></div>`;
      screen.querySelector('[data-settlement-close]').addEventListener('click', close);
      return;
    }

    const summary = summarizeMember(memberId, data);
    const history = data.settlements.filter(s => s.member_id === memberId);
    const historyHtml = history.map(row => {
      const own = row.created_by === ctx.session.user.id;
      return `
        <div class="rcp-settlement-history-row">
          <div>
            <div class="row-title">${esc(typeLabel(row.settlement_type))} · ${fmtMoney(row.amount)}</div>
            <div class="row-sub">${dateLabel(row.settlement_date)} · wprowadził: ${own ? 'Ty' : 'druga strona'}</div>
            ${row.note ? `<div class="row-sub">${esc(row.note)}</div>` : ''}
          </div>
        </div>`;
    }).join('');

    const header = allowBackToList
      ? `
        <div class="rcp-stats-head">
          <button class="rcp-stats-back" type="button" data-settlement-list-back>←</button>
          <div><div class="rcp-stats-title">Rozliczenie</div><div class="rcp-stats-subtitle">${esc(employeeName(member))}</div></div>
        </div>`
      : moduleHeader('Rozliczenie', employeeName(member));

    screen.innerHTML = `
      <div class="rcp-stats-shell">
        ${header}
        <div class="card">
          ${balanceSummaryHtml(summary)}
          <div class="notice notice-info" style="margin-top:14px">Nową zaliczkę lub wypłatę dodajesz po wejściu w konkretny dzień w kalendarzu Statystyk.</div>
        </div>
        <div class="card">
          <div class="section-head"><h3>Historia rozliczeń</h3><span class="small muted">${history.length} wpisów</span></div>
          <div class="list">${historyHtml || '<div class="muted small">Brak zaliczek i wypłat.</div>'}</div>
        </div>
      </div>`;

    if (allowBackToList) {
      screen.querySelector('[data-settlement-list-back]').addEventListener('click', () => renderAdminSettlementList(screen, ctx, data, close));
    } else {
      screen.querySelector('[data-settlement-close]').addEventListener('click', close);
    }
  }

  async function injectDaySettlement(ctx) {
    const dialog = document.getElementById('rcpStatsDayDialog');
    if (!dialog || dialog.dataset.settlementReady === '1' || dayInjecting) return;
    const dayKey = dialog.dataset.dayKey;
    if (!dayKey) return;

    dayInjecting = true;
    try {
      const data = await loadFinance(ctx);
      const filterMemberId = dialog.dataset.statsFilterMemberId || '';
      const targetMemberId = ctx.membership.role === 'employee' ? ctx.membership.id : filterMemberId;
      const rows = data.settlements.filter(s =>
        s.settlement_date === dayKey &&
        (!targetMemberId || s.member_id === targetMemberId)
      );

      const byId = new Map(data.employees.map(m => [m.id, m]));
      const listHtml = rows.map(row => {
        const member = byId.get(row.member_id);
        const own = row.created_by === ctx.session.user.id;
        return `
          <div class="rcp-day-settlement-row">
            <div>
              <b>${esc(typeLabel(row.settlement_type))}: ${fmtMoney(row.amount)}</b>
              ${ctx.membership.role === 'admin' ? `<div class="row-sub">${esc(employeeName(member))}</div>` : ''}
              <div class="row-sub">wprowadził: ${own ? 'Ty' : 'druga strona'}${row.note ? ' · ' + esc(row.note) : ''}</div>
            </div>
          </div>`;
      }).join('');

      const section = document.createElement('div');
      section.id = 'rcpDaySettlementSection';
      section.className = 'rcp-day-settlement-section';
      section.innerHTML = `
        <div class="section-head">
          <div>
            <h3 style="margin:0">💰 Rozliczenie dnia</h3>
            <div class="muted small">${dateLabel(dayKey)}</div>
          </div>
        </div>
        <div class="rcp-day-settlement-actions">
          <button class="btn btn-light" type="button" data-add-settlement="advance">+ Zaliczka</button>
          <button class="btn btn-dark" type="button" data-add-settlement="payout">+ Wypłata</button>
        </div>
        <div class="rcp-day-settlement-list">${listHtml || '<div class="muted small">Brak operacji finansowych tego dnia.</div>'}</div>`;

      const content = dialog.querySelector('#rcpStatsDayContent');
      if (content) content.insertAdjacentElement('beforebegin', section);
      else dialog.querySelector('.dialog')?.appendChild(section);

      section.querySelectorAll('[data-add-settlement]').forEach(btn => {
        btn.addEventListener('click', () => openAddSettlementDialog(ctx, data, dayKey, btn.dataset.addSettlement, targetMemberId));
      });
      dialog.dataset.settlementReady = '1';
    } catch (err) {
      console.warn('RCP rozliczenia dnia:', err);
    } finally {
      dayInjecting = false;
    }
  }

  function openAddSettlementDialog(ctx, data, dayKey, type, fixedMemberId = '') {
    if (document.getElementById('rcpAddSettlementDialog')) return;

    const wrap = document.createElement('div');
    wrap.id = 'rcpAddSettlementDialog';
    wrap.className = 'dialog-backdrop';
    wrap.style.zIndex = '1500';

    let memberField = '';
    if (ctx.membership.role === 'admin' && !fixedMemberId) {
      memberField = `
        <div class="field">
          <label for="rcpSettlementMember">Pracownik</label>
          <select id="rcpSettlementMember" class="select" required>
            <option value="">Wybierz pracownika</option>
            ${data.employees.map(m => `<option value="${m.id}">${esc(employeeName(m))}</option>`).join('')}
          </select>
        </div>`;
    } else {
      const member = data.employees.find(m => m.id === (fixedMemberId || ctx.membership.id));
      memberField = `<div class="notice notice-info" style="margin-top:0">Pracownik: <b>${esc(employeeName(member))}</b></div>`;
    }

    wrap.innerHTML = `
      <div class="dialog" style="max-width:520px">
        <h3 style="margin-top:0">${esc(typeLabel(type))}</h3>
        <div class="muted small" style="margin-bottom:12px">Data: ${dateLabel(dayKey)}</div>
        ${memberField}
        <div class="field">
          <label for="rcpSettlementAmount">Kwota</label>
          <input id="rcpSettlementAmount" class="input" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="0,00" required>
        </div>
        <div class="field">
          <label for="rcpSettlementNote">Komentarz / opis</label>
          <textarea id="rcpSettlementNote" class="input" maxlength="500" rows="3" placeholder="opcjonalnie" style="resize:vertical"></textarea>
        </div>
        <div id="rcpSettlementError" class="notice notice-error" style="display:none"></div>
        <div class="dialog-actions">
          <button class="btn btn-light" type="button" data-cancel>Anuluj</button>
          <button class="btn btn-dark" type="button" data-save>Zapisz</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const close = () => wrap.remove();
    wrap.querySelector('[data-cancel]').addEventListener('click', close);
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

    wrap.querySelector('[data-save]').addEventListener('click', async () => {
      const save = wrap.querySelector('[data-save]');
      const errorBox = wrap.querySelector('#rcpSettlementError');
      const amount = Number(String(wrap.querySelector('#rcpSettlementAmount').value || '').replace(',', '.'));
      const note = wrap.querySelector('#rcpSettlementNote').value.trim() || null;
      const memberId = fixedMemberId || (ctx.membership.role === 'employee' ? ctx.membership.id : wrap.querySelector('#rcpSettlementMember')?.value);

      errorBox.style.display = 'none';
      if (!memberId) {
        errorBox.textContent = 'Wybierz pracownika.';
        errorBox.style.display = 'block';
        return;
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        errorBox.textContent = 'Podaj prawidłową kwotę większą od zera.';
        errorBox.style.display = 'block';
        return;
      }

      save.disabled = true;
      save.textContent = 'Zapisywanie…';

      try {
        await api('employee_settlements', {
          method: 'POST',
          prefer: 'return=representation',
          body: {
            member_id: memberId,
            settlement_date: dayKey,
            settlement_type: type,
            amount: Math.round(amount * 100) / 100,
            note,
            created_by: ctx.session.user.id
          }
        });

        financeCache = null;
        close();
        toast(`${typeLabel(type)} ${fmtMoney(amount)} została zapisana.`, 'success');

        const dayDialog = document.getElementById('rcpStatsDayDialog');
        if (dayDialog) {
          dayDialog.dataset.settlementReady = '';
          dayDialog.querySelector('#rcpDaySettlementSection')?.remove();
        }
        document.getElementById('rcpSettlementEmployeeCard')?.remove();
        document.getElementById('rcpSettlementAdminCard')?.remove();

        setTimeout(() => {
          scheduleDecorate();
          injectDaySettlement(ctx);
          decorateCalendar(ctx, true);
        }, 80);
      } catch (err) {
        errorBox.textContent = err?.message || 'Nie udało się zapisać rozliczenia.';
        errorBox.style.display = 'block';
        save.disabled = false;
        save.textContent = 'Zapisz';
      }
    });

    setTimeout(() => wrap.querySelector('#rcpSettlementAmount')?.focus(), 50);
  }

  async function decorateCalendar(ctx, force = false) {
    const screen = document.getElementById('rcpStatsScreen');
    if (!screen || !screen.dataset.statsYear || !screen.dataset.statsMonth || calendarDecorating) return;

    const year = Number(screen.dataset.statsYear);
    const month = Number(screen.dataset.statsMonth);
    const filterMemberId = screen.dataset.statsFilterMemberId || '';
    const key = `${year}-${String(month).padStart(2, '0')}`;

    if (!force && screen.dataset.settlementCalendarKey === `${key}:${filterMemberId}`) return;

    calendarDecorating = true;
    try {
      const data = await loadFinance(ctx);
      const memberId = ctx.membership.role === 'employee' ? ctx.membership.id : filterMemberId;
      const dates = new Set(
        data.settlements
          .filter(s => s.settlement_date.startsWith(key) && (!memberId || s.member_id === memberId))
          .map(s => s.settlement_date)
      );

      screen.querySelectorAll('[data-stats-day]').forEach(btn => {
        btn.classList.remove('rcp-cal-settlement');
        btn.querySelector('.rcp-cal-money')?.remove();
        if (dates.has(btn.dataset.statsDay)) {
          btn.classList.add('rcp-cal-settlement');
          const badge = document.createElement('em');
          badge.className = 'rcp-cal-money';
          badge.textContent = 'zł';
          btn.appendChild(badge);
        }
      });
      screen.dataset.settlementCalendarKey = `${key}:${filterMemberId}`;
    } catch (_) {
      // Statystyki pozostają dostępne nawet jeśli rozliczenia chwilowo się nie dociągną.
    } finally {
      calendarDecorating = false;
    }
  }

  async function decorate() {
    if (decorating) return;
    const employeeUi = document.getElementById('punchBtn');
    const adminUi = document.querySelector('.tabs [data-tab="dashboard"]');
    const dayDialog = document.getElementById('rcpStatsDayDialog');
    const statsScreen = document.getElementById('rcpStatsScreen');

    if (!employeeUi && !adminUi && !dayDialog && !statsScreen) return;

    decorating = true;
    try {
      const ctx = await resolveContext();
      if (!ctx) return;

      if (ctx.membership.role === 'employee' && employeeUi) await addEmployeeDashboard(ctx);
      if (ctx.membership.role === 'admin' && adminUi) await addAdminDashboard(ctx);
      if (dayDialog) await injectDaySettlement(ctx);
      if (statsScreen) await decorateCalendar(ctx);
    } catch (err) {
      console.warn('RCP rozliczenie:', err);
    } finally {
      decorating = false;
    }
  }

  function scheduleDecorate() {
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(decorate, 160);
  }

  const observer = new MutationObserver(scheduleDecorate);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-stats-year','data-stats-month','data-stats-filter-member-id'] });

  window.addEventListener('load', () => setTimeout(decorate, 600));
})();