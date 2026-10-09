(() => {
  'use strict';

  const cfg = window.RCP_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabasePublishableKey) return;

  const projectRef = new URL(cfg.supabaseUrl).hostname.split('.')[0];
  const authStorageKey = `sb-${projectRef}-auth-token`;
  const selectedTimeMemberKey = 'rcp:admin-time-member';
  let contextCache = null;
  let adminCache = null;
  let decorateTimer = null;
  let decorating = false;

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

  async function request(path, { method = 'GET', body, prefer = '' } = {}) {
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

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function todayKey(timeZone = cfg.timezone || 'Europe/Warsaw') {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  }

  function monthStartKey(timeZone) {
    return `${todayKey(timeZone).slice(0, 7)}-01`;
  }

  function formatDate(date) {
    if (!date) return '';
    return new Intl.DateTimeFormat('pl-PL', {
      day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC'
    }).format(new Date(`${date}T12:00:00Z`));
  }

  function rangeLabel(row) {
    return row.starts_on === row.ends_on
      ? formatDate(row.starts_on)
      : `${formatDate(row.starts_on)} – ${formatDate(row.ends_on)}`;
  }

  function fullName(member) {
    return [member?.first_name, member?.last_name].filter(Boolean).join(' ').trim() || 'Pracownik';
  }

  function toast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = `notice notice-${type}`;
    el.textContent = message;
    el.style.position = 'fixed';
    el.style.left = '50%';
    el.style.bottom = '20px';
    el.style.transform = 'translateX(-50%)';
    el.style.zIndex = '1800';
    el.style.width = 'min(92vw, 520px)';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3400);
  }

  async function resolveContext() {
    const session = readSession();
    if (!session?.user?.id) return null;
    const selectedId = localStorage.getItem('rcp:selected-membership') || '';
    const key = `${session.user.id}:${selectedId}`;
    if (contextCache?.key === key && Date.now() - contextCache.at < 8000) return contextCache.value;

    const rows = await request(
      `organization_members?select=id,organization_id,user_id,first_name,last_name,role,active&user_id=eq.${encodeURIComponent(session.user.id)}&active=eq.true&order=created_at.asc`
    );
    const list = Array.isArray(rows) ? rows : [];
    const membership = list.find(m => m.id === selectedId) || list[0] || null;
    if (!membership || membership.role !== 'admin') return null;

    const orgRows = await request(`organizations?select=id,timezone&id=eq.${encodeURIComponent(membership.organization_id)}&limit=1`);
    const organization = Array.isArray(orgRows) ? orgRows[0] || null : null;
    const value = { membership, timeZone: organization?.timezone || cfg.timezone || 'Europe/Warsaw' };
    contextCache = { key, at: Date.now(), value };
    return value;
  }

  async function loadAdminData(ctx, force = false) {
    const key = ctx.membership.organization_id;
    if (!force && adminCache?.key === key && Date.now() - adminCache.at < 8000) return adminCache.value;

    const employees = await request(
      `organization_members?select=id,first_name,last_name,active&organization_id=eq.${encodeURIComponent(key)}&role=eq.employee&order=first_name.asc,last_name.asc`
    );
    const list = Array.isArray(employees) ? employees : [];
    const ids = list.map(m => m.id);
    let vacations = [];
    if (ids.length) {
      const from = monthStartKey(ctx.timeZone);
      const rows = await request(
        `vacation_requests?select=id,member_id,starts_on,ends_on,created_at&member_id=in.(${ids.join(',')})&ends_on=gte.${from}&order=starts_on.asc,created_at.asc`
      );
      vacations = Array.isArray(rows) ? rows : [];
    }

    const value = { employees: list, vacations };
    adminCache = { key, at: Date.now(), value };
    return value;
  }

  function vacationStatus(v, today) {
    if (v.starts_on <= today && v.ends_on >= today) return { label: 'URLOP TERAZ', color: '#b45309' };
    if (v.starts_on > today) return { label: 'ZAPLANOWANY', color: 'var(--muted)' };
    return { label: 'ZAKOŃCZONY', color: 'var(--muted)' };
  }

  function openAdminVacationDialog(ctx, data, fixedMemberId = '') {
    if (document.getElementById('rcpAdminVacationDialog')) return;
    const today = todayKey(ctx.timeZone);
    const fixed = data.employees.find(m => m.id === fixedMemberId) || null;

    const wrap = document.createElement('div');
    wrap.id = 'rcpAdminVacationDialog';
    wrap.className = 'dialog-backdrop';
    wrap.style.zIndex = '1500';
    wrap.innerHTML = `
      <div class="dialog" style="max-width:560px">
        <h3 style="margin-top:0">Dodaj urlop pracownika</h3>
        <p class="muted small">Administrator może wpisać także urlop z datą wsteczną.</p>
        ${fixed ? `<div class="notice notice-info" style="margin-top:0">Pracownik: <b>${esc(fullName(fixed))}</b></div>` : `
          <div class="field"><label for="rcpAdminVacationMember">Pracownik</label>
            <select id="rcpAdminVacationMember" class="select" required>
              <option value="">Wybierz pracownika</option>
              ${data.employees.map(m => `<option value="${m.id}">${esc(fullName(m))}</option>`).join('')}
            </select>
          </div>`}
        <div class="form-grid">
          <div class="field"><label for="rcpAdminVacationFrom">Od</label><input id="rcpAdminVacationFrom" class="input" type="date" value="${today}" required></div>
          <div class="field"><label for="rcpAdminVacationTo">Do</label><input id="rcpAdminVacationTo" class="input" type="date" value="${today}" required></div>
        </div>
        <div id="rcpAdminVacationError" class="notice notice-error" style="display:none"></div>
        <div class="dialog-actions">
          <button class="btn btn-light" type="button" data-cancel>Anuluj</button>
          <button class="btn btn-dark" type="button" data-save>Zapisz urlop</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const from = wrap.querySelector('#rcpAdminVacationFrom');
    const to = wrap.querySelector('#rcpAdminVacationTo');
    from.addEventListener('change', () => { if (to.value < from.value) to.value = from.value; });
    const close = () => wrap.remove();
    wrap.querySelector('[data-cancel]').addEventListener('click', close);
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

    wrap.querySelector('[data-save]').addEventListener('click', async () => {
      const save = wrap.querySelector('[data-save]');
      const errorBox = wrap.querySelector('#rcpAdminVacationError');
      const memberId = fixedMemberId || wrap.querySelector('#rcpAdminVacationMember')?.value || '';
      const starts_on = from.value;
      const ends_on = to.value;
      errorBox.style.display = 'none';

      if (!memberId) return showError(errorBox, 'Wybierz pracownika.');
      if (!starts_on || !ends_on) return showError(errorBox, 'Wybierz zakres urlopu.');
      if (ends_on < starts_on) return showError(errorBox, 'Data końcowa nie może być wcześniejsza niż początkowa.');

      save.disabled = true;
      save.textContent = 'Zapisywanie…';
      try {
        await request('vacation_requests', {
          method: 'POST',
          prefer: 'return=representation',
          body: { member_id: memberId, starts_on, ends_on }
        });
        adminCache = null;
        close();
        toast(`Urlop ${formatDate(starts_on)} – ${formatDate(ends_on)} zapisany.`, 'success');
        scheduleDecorate(true);
      } catch (err) {
        const duplicate = /duplicate key|unique/i.test(err?.message || '');
        showError(errorBox, duplicate ? 'Taki zakres urlopu został już zapisany.' : (err?.message || 'Nie udało się zapisać urlopu.'));
        save.disabled = false;
        save.textContent = 'Zapisz urlop';
      }
    });
  }

  function showError(box, message) {
    box.textContent = message;
    box.style.display = 'block';
  }

  function decorateDashboard(ctx, data) {
    const active = document.querySelector('.tab.active[data-tab="dashboard"]');
    if (!active) return;
    const tabs = active.closest('.tabs');
    if (!tabs) return;

    let card = document.getElementById('rcpVacationAdminCard');
    if (!card) {
      card = document.createElement('div');
      card.id = 'rcpVacationAdminCard';
      card.className = 'card';
      tabs.insertAdjacentElement('afterend', card);
    }

    const today = todayKey(ctx.timeZone);
    const byId = new Map(data.employees.map(m => [m.id, m]));
    const rows = [...data.vacations]
      .sort((a, b) => a.starts_on.localeCompare(b.starts_on))
      .map(v => {
        const m = byId.get(v.member_id);
        const status = vacationStatus(v, today);
        return `<div class="row">
          <div class="row-main"><div class="row-title">${esc(fullName(m))}</div><div class="row-sub">${esc(rangeLabel(v))}</div></div>
          <div class="member-status" style="color:${status.color}">${status.label}</div>
        </div>`;
      }).join('');

    card.innerHTML = `
      <div class="section-head">
        <div><h3>Urlopy</h3><div class="muted small">Bieżący miesiąc i kolejne zaplanowane urlopy.</div></div>
        <button type="button" class="btn btn-dark" data-admin-vacation-add>+ Urlop</button>
      </div>
      <div class="list">${rows || '<div class="muted small">Brak urlopów.</div>'}</div>`;
    card.querySelector('[data-admin-vacation-add]')?.addEventListener('click', () => openAdminVacationDialog(ctx, data));
  }

  function decorateTeam(ctx, data) {
    const active = document.querySelector('.tab.active[data-tab="team"]');
    if (!active) return;
    document.querySelectorAll('[data-rate]').forEach(rateButton => {
      const memberId = rateButton.dataset.rate;
      const actions = rateButton.closest('.member-actions');
      if (!actions || actions.querySelector(`[data-admin-vacation-member="${memberId}"]`)) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mini-btn';
      button.dataset.adminVacationMember = memberId;
      button.textContent = 'Urlop';
      button.addEventListener('click', () => openAdminVacationDialog(ctx, data, memberId));
      actions.prepend(button);
    });
  }

  function parseRowDate(row) {
    const text = row.querySelector('.row-title')?.textContent?.trim() || '';
    const m = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
  }

  function decorateTimeDetail(ctx, data) {
    const detail = document.querySelector('.rcp-time-detail-card');
    if (!detail) return;
    const memberId = localStorage.getItem(selectedTimeMemberKey) || '';
    const member = data.employees.find(m => m.id === memberId);
    if (!member) return;

    const head = detail.querySelector('.rcp-time-detail-head');
    if (head && !head.querySelector('[data-time-add-vacation]')) {
      const addEntry = head.querySelector('#addSessionBtn');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-light';
      button.dataset.timeAddVacation = '1';
      button.textContent = '+ Urlop';
      button.addEventListener('click', () => openAdminVacationDialog(ctx, data, memberId));
      if (addEntry) addEntry.insertAdjacentElement('beforebegin', button);
      else head.appendChild(button);
    }

    const list = detail.querySelector('.list');
    if (!list) return;
    list.querySelectorAll('.rcp-time-vacation-row').forEach(el => el.remove());

    const vacations = data.vacations.filter(v => v.member_id === memberId);
    if (vacations.length && list.children.length === 1 && list.firstElementChild?.classList.contains('muted')) list.innerHTML = '';

    list.querySelectorAll('.rcp-time-session-row').forEach(row => { row.dataset.sortKey = parseRowDate(row); });
    vacations.forEach(v => {
      const row = document.createElement('div');
      row.className = 'row rcp-time-vacation-row';
      row.dataset.sortKey = v.starts_on;
      row.innerHTML = `<div class="row-main"><div class="row-title">${esc(rangeLabel(v))}</div><div class="rcp-vacation-badge">🏖️ URLOP</div><div class="row-sub">Dzień wolny od pracy</div></div>`;
      list.appendChild(row);
    });

    [...list.children]
      .filter(el => el.dataset.sortKey)
      .sort((a, b) => b.dataset.sortKey.localeCompare(a.dataset.sortKey))
      .forEach(el => list.appendChild(el));

    const heading = [...detail.querySelectorAll('.section-head h3')].find(el => /Wpisy czasu pracy/.test(el.textContent || ''));
    if (heading) heading.textContent = 'Czas pracy i urlopy';
    const count = heading?.closest('.section-head')?.querySelector('.small.muted');
    if (count) count.textContent = `${list.querySelectorAll('.rcp-time-session-row').length} wpisów · ${vacations.length} urlopów`;
  }

  function injectStyles() {
    if (document.getElementById('rcpVacationAdminStyles')) return;
    const style = document.createElement('style');
    style.id = 'rcpVacationAdminStyles';
    style.textContent = `
      .rcp-time-vacation-row{border-color:#f3d6a0;background:#fffaf0}.rcp-vacation-badge{display:inline-flex;margin-top:7px;padding:5px 9px;border-radius:999px;background:#fff0cf;color:#9a5a00;font-size:12px;font-weight:900;letter-spacing:.2px}
      @media(max-width:640px){.rcp-time-detail-head{flex-wrap:wrap}.rcp-time-detail-head [data-time-back]{margin-right:auto}.rcp-time-detail-head .btn{padding:10px 12px}}
    `;
    document.head.appendChild(style);
  }

  async function decorate(force = false) {
    if (decorating) return;
    const hasAdminUi = document.querySelector('.tab[data-tab]') || document.querySelector('.rcp-time-detail-card');
    if (!hasAdminUi) return;
    decorating = true;
    try {
      const ctx = await resolveContext();
      if (!ctx) return;
      const data = await loadAdminData(ctx, force);
      decorateDashboard(ctx, data);
      decorateTeam(ctx, data);
      decorateTimeDetail(ctx, data);
    } catch (err) {
      console.warn('RCP admin urlopy:', err);
    } finally {
      decorating = false;
    }
  }

  function scheduleDecorate(force = false) {
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(() => decorate(force), 120);
  }

  document.addEventListener('click', e => {
    const memberTile = e.target.closest?.('[data-time-member]');
    if (memberTile?.dataset.timeMember) localStorage.setItem(selectedTimeMemberKey, memberTile.dataset.timeMember);
    if (e.target.closest?.('[data-time-back]')) localStorage.removeItem(selectedTimeMemberKey);
  }, true);

  new MutationObserver(() => scheduleDecorate()).observe(document.documentElement, { childList: true, subtree: true });
  injectStyles();
  window.addEventListener('load', () => setTimeout(() => scheduleDecorate(true), 500));
})();
