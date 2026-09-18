(() => {
  'use strict';

  const cfg = window.RCP_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabasePublishableKey) return;

  const projectRef = new URL(cfg.supabaseUrl).hostname.split('.')[0];
  const authStorageKey = `sb-${projectRef}-auth-token`;
  let membershipCache = null;
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
    if (!res.ok) {
      const message = data?.message || data?.details || data?.hint || data?.code || `Błąd ${res.status}`;
      const error = new Error(message);
      error.status = res.status;
      throw error;
    }
    return data;
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

  function todayKey() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: cfg.timezone || 'Europe/Warsaw',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  }

  function formatDate(date) {
    if (!date) return '';
    return new Intl.DateTimeFormat('pl-PL', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: cfg.timezone || 'Europe/Warsaw'
    }).format(new Date(`${date}T12:00:00`));
  }

  function rangeLabel(row) {
    return row.starts_on === row.ends_on
      ? formatDate(row.starts_on)
      : `${formatDate(row.starts_on)} – ${formatDate(row.ends_on)}`;
  }

  function toast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = `notice notice-${type}`;
    el.textContent = message;
    el.style.position = 'fixed';
    el.style.left = '50%';
    el.style.bottom = '20px';
    el.style.transform = 'translateX(-50%)';
    el.style.zIndex = '120';
    el.style.width = 'min(92vw, 520px)';
    el.style.boxShadow = '0 14px 34px rgba(17,24,39,.22)';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  async function resolveMembership() {
    const session = readSession();
    if (!session?.user?.id) return null;

    const selectedId = localStorage.getItem('rcp:selected-membership') || '';
    const cacheKey = `${session.user.id}:${selectedId}`;
    if (membershipCache?.key === cacheKey && Date.now() - membershipCache.at < 8000) {
      return membershipCache.value;
    }

    const rows = await request(
      `organization_members?select=id,organization_id,user_id,first_name,last_name,role,active&user_id=eq.${encodeURIComponent(session.user.id)}&active=eq.true&order=created_at.asc`
    );
    const memberships = Array.isArray(rows) ? rows : [];
    const value = memberships.find(m => m.id === selectedId) || memberships[0] || null;
    membershipCache = { key: cacheKey, at: Date.now(), value };
    return value;
  }

  async function loadOwnVacations(memberId) {
    const today = todayKey();
    const rows = await request(
      `vacation_requests?select=id,member_id,starts_on,ends_on,created_at&member_id=eq.${encodeURIComponent(memberId)}&ends_on=gte.${today}&order=starts_on.asc`
    );
    return Array.isArray(rows) ? rows : [];
  }

  async function openVacationDialog(member) {
    if (document.getElementById('rcpVacationDialog')) return;

    let vacations = [];
    try {
      vacations = await loadOwnVacations(member.id);
    } catch (_) {}

    const today = todayKey();
    const wrap = document.createElement('div');
    wrap.id = 'rcpVacationDialog';
    wrap.className = 'dialog-backdrop';

    const upcomingHtml = vacations.length
      ? vacations.map(v => `
          <div class="row">
            <div class="row-main">
              <div class="row-title">${esc(rangeLabel(v))}</div>
              <div class="row-sub">${v.starts_on <= today && v.ends_on >= today ? 'Trwa teraz' : 'Zgłoszony urlop'}</div>
            </div>
          </div>`).join('')
      : '<div class="muted small">Brak zgłoszonych urlopów.</div>';

    wrap.innerHTML = `
      <div class="dialog" style="max-width:560px">
        <h3 style="margin-top:0">URLOP</h3>
        <p class="muted small">Wybierz pierwszy i ostatni dzień urlopu, a następnie wyślij zgłoszenie.</p>
        <div class="form-grid">
          <div class="field">
            <label for="rcpVacationFrom">Od</label>
            <input id="rcpVacationFrom" class="input" type="date" min="${today}" value="${today}" required>
          </div>
          <div class="field">
            <label for="rcpVacationTo">Do</label>
            <input id="rcpVacationTo" class="input" type="date" min="${today}" value="${today}" required>
          </div>
        </div>
        <div class="card" style="margin-top:14px;padding:12px">
          <div class="section-head"><h3 style="font-size:15px">Moje urlopy</h3></div>
          <div class="list">${upcomingHtml}</div>
        </div>
        <div id="rcpVacationError" class="notice notice-error" style="display:none"></div>
        <div class="dialog-actions">
          <button class="btn btn-light" type="button" data-vacation-cancel>Anuluj</button>
          <button class="btn btn-dark" type="button" data-vacation-send>Wyślij</button>
        </div>
      </div>`;

    document.body.appendChild(wrap);
    const from = wrap.querySelector('#rcpVacationFrom');
    const to = wrap.querySelector('#rcpVacationTo');
    const send = wrap.querySelector('[data-vacation-send]');
    const errorBox = wrap.querySelector('#rcpVacationError');

    from.addEventListener('change', () => {
      to.min = from.value || today;
      if (to.value < from.value) to.value = from.value;
    });

    wrap.querySelector('[data-vacation-cancel]').addEventListener('click', () => wrap.remove());
    wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });

    send.addEventListener('click', async () => {
      const starts_on = from.value;
      const ends_on = to.value;
      errorBox.style.display = 'none';

      if (!starts_on || !ends_on) {
        errorBox.textContent = 'Wybierz zakres urlopu.';
        errorBox.style.display = 'block';
        return;
      }
      if (ends_on < starts_on) {
        errorBox.textContent = 'Data końcowa nie może być wcześniejsza niż początkowa.';
        errorBox.style.display = 'block';
        return;
      }

      send.disabled = true;
      send.textContent = 'Wysyłanie…';
      try {
        await request('vacation_requests', {
          method: 'POST',
          body: { member_id: member.id, starts_on, ends_on },
          prefer: 'return=representation'
        });
        adminCache = null;
        wrap.remove();
        toast(`Urlop ${formatDate(starts_on)} – ${formatDate(ends_on)} został zgłoszony.`, 'success');
      } catch (err) {
        const duplicate = /duplicate key|unique/i.test(err?.message || '');
        errorBox.textContent = duplicate
          ? 'Taki zakres urlopu został już zgłoszony.'
          : (err?.message || 'Nie udało się zgłosić urlopu.');
        errorBox.style.display = 'block';
        send.disabled = false;
        send.textContent = 'Wyślij';
      }
    });
  }

  function decorateEmployee(member) {
    const punch = document.getElementById('punchBtn');
    if (!punch || document.getElementById('rcpVacationEmployeeCard')) return;

    const hero = punch.closest('.card.hero');
    if (!hero) return;

    const card = document.createElement('div');
    card.id = 'rcpVacationEmployeeCard';
    card.className = 'card';
    card.innerHTML = `
      <button id="rcpVacationOpen" class="btn btn-light btn-block" type="button"
        style="min-height:64px;font-size:18px;font-weight:850;display:flex;align-items:center;justify-content:center;gap:10px">
        <span aria-hidden="true">🏖️</span> URLOP
      </button>
      <div class="small muted" style="text-align:center;margin-top:8px">Zgłoś termin urlopu</div>`;

    hero.insertAdjacentElement('afterend', card);
    card.querySelector('#rcpVacationOpen').addEventListener('click', () => openVacationDialog(member));
  }

  async function loadAdminVacations(member) {
    const cacheKey = member.organization_id;
    if (adminCache?.key === cacheKey && Date.now() - adminCache.at < 12000) return adminCache.value;

    const members = await request(
      `organization_members?select=id,first_name,last_name,role,active&organization_id=eq.${encodeURIComponent(member.organization_id)}&role=eq.employee&order=first_name.asc`
    );
    const employees = Array.isArray(members) ? members : [];
    const ids = employees.map(m => m.id);

    let vacations = [];
    if (ids.length) {
      const today = todayKey();
      const rows = await request(
        `vacation_requests?select=id,member_id,starts_on,ends_on,created_at&member_id=in.(${ids.join(',')})&ends_on=gte.${today}&order=starts_on.asc`
      );
      vacations = Array.isArray(rows) ? rows : [];
    }

    const value = { employees, vacations };
    adminCache = { key: cacheKey, at: Date.now(), value };
    return value;
  }

  function currentVacation(vacations, memberId, today) {
    return vacations.find(v => v.member_id === memberId && v.starts_on <= today && v.ends_on >= today) || null;
  }

  function nextVacation(vacations, memberId, today) {
    return vacations.find(v => v.member_id === memberId && v.starts_on > today) || null;
  }

  function decorateAdminDashboard(data) {
    const activeDashboard = document.querySelector('[data-tab="dashboard"].active');
    if (!activeDashboard || document.getElementById('rcpVacationAdminCard')) return;

    const tabs = activeDashboard.closest('.tabs');
    if (!tabs) return;

    const today = todayKey();
    const relevant = data.vacations.slice(0, 20);
    const byId = new Map(data.employees.map(m => [m.id, m]));

    const rows = relevant.length
      ? relevant.map(v => {
          const m = byId.get(v.member_id);
          const active = v.starts_on <= today && v.ends_on >= today;
          const name = [m?.first_name, m?.last_name].filter(Boolean).join(' ') || 'Pracownik';
          return `
            <div class="row">
              <div class="row-main">
                <div class="row-title">${esc(name)}</div>
                <div class="row-sub">${esc(rangeLabel(v))}</div>
              </div>
              <div class="member-status" style="color:${active ? '#b45309' : 'var(--muted)'}">
                ${active ? 'URLOP TERAZ' : 'ZAPLANOWANY'}
              </div>
            </div>`;
        }).join('')
      : '<div class="muted small">Brak bieżących lub zaplanowanych urlopów.</div>';

    const card = document.createElement('div');
    card.id = 'rcpVacationAdminCard';
    card.className = 'card';
    card.innerHTML = `
      <div class="section-head">
        <div>
          <h3>Urlopy</h3>
          <div class="muted small">Bieżące i najbliższe zgłoszenia pracowników.</div>
        </div>
      </div>
      <div class="list">${rows}</div>`;

    tabs.insertAdjacentElement('afterend', card);
  }

  function decorateAdminTeam(data) {
    const activeTeam = document.querySelector('[data-tab="team"].active');
    if (!activeTeam) return;

    const today = todayKey();
    const rows = [...document.querySelectorAll('.row')];

    for (const row of rows) {
      if (row.querySelector('.rcp-vacation-team-status')) continue;
      const idSource = row.querySelector('[data-credentials], [data-rate], [data-toggle-member]');
      const memberId = idSource?.dataset?.credentials || idSource?.dataset?.rate || idSource?.dataset?.toggleMember;
      if (!memberId) continue;

      const current = currentVacation(data.vacations, memberId, today);
      const upcoming = current ? null : nextVacation(data.vacations, memberId, today);
      if (!current && !upcoming) continue;

      const main = row.querySelector('.row-main');
      if (!main) continue;

      const info = document.createElement('div');
      info.className = 'row-sub rcp-vacation-team-status';
      info.style.fontWeight = '800';
      info.style.color = current ? '#b45309' : 'var(--muted)';
      info.textContent = current
        ? `URLOP do ${formatDate(current.ends_on)}`
        : `Urlop: ${rangeLabel(upcoming)}`;
      main.appendChild(info);
    }
  }

  async function decorate() {
    if (decorating) return;
    decorating = true;
    try {
      const member = await resolveMembership();
      if (!member) return;

      if (member.role === 'employee') {
        decorateEmployee(member);
        return;
      }

      if (member.role === 'admin' && document.querySelector('[data-tab]')) {
        const data = await loadAdminVacations(member);
        decorateAdminDashboard(data);
        decorateAdminTeam(data);
      }
    } catch (err) {
      console.warn('RCP urlopy:', err);
    } finally {
      decorating = false;
    }
  }

  function scheduleDecorate() {
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(decorate, 120);
  }

  const observer = new MutationObserver(scheduleDecorate);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('load', () => setTimeout(decorate, 400));
})();