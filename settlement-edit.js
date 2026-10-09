(() => {
  'use strict';

  const cfg = window.RCP_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabasePublishableKey) return;

  const projectRef = new URL(cfg.supabaseUrl).hostname.split('.')[0];
  const authStorageKey = `sb-${projectRef}-auth-token`;
  const money = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' });
  let timer = null;
  let dirty = false;

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

    const headers = {
      apikey: cfg.supabasePublishableKey,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    if (options.prefer) headers.Prefer = options.prefer;

    const response = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body == null ? undefined : JSON.stringify(options.body)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.message || data?.details || data?.hint || data?.code || `Błąd ${response.status}`);
    return data;
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function fmtMoney(value) {
    return money.format(Number(value || 0));
  }

  function dateLabel(key) {
    if (!key) return '';
    return new Intl.DateTimeFormat('pl-PL', {
      day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC'
    }).format(new Date(`${key}T12:00:00Z`));
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
    el.style.zIndex = '2200';
    el.style.width = 'min(92vw, 520px)';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  async function resolveAdmin() {
    const session = readSession();
    if (!session?.user?.id) return null;
    const selectedId = localStorage.getItem('rcp:selected-membership') || '';
    const memberships = await api(
      `organization_members?select=id,organization_id,user_id,first_name,last_name,role,active&user_id=eq.${encodeURIComponent(session.user.id)}&active=eq.true&order=created_at.asc`
    );
    const list = Array.isArray(memberships) ? memberships : [];
    const member = list.find(m => m.id === selectedId) || list[0] || null;
    return member?.role === 'admin' ? member : null;
  }

  async function loadAdvances(admin) {
    const employees = await api(
      `organization_members?select=id,first_name,last_name,active&organization_id=eq.${encodeURIComponent(admin.organization_id)}&role=eq.employee&order=first_name.asc,last_name.asc`
    );
    const list = Array.isArray(employees) ? employees : [];
    const ids = list.map(m => m.id);
    let advances = [];
    if (ids.length) {
      advances = await api(
        `employee_settlements?select=id,member_id,settlement_date,amount,note,created_at&settlement_type=eq.advance&member_id=in.(${ids.join(',')})&order=settlement_date.desc,created_at.desc&limit=300`
      );
    }
    return { employees: list, advances: Array.isArray(advances) ? advances : [] };
  }

  function renderAdvanceList(wrap, data) {
    const byId = new Map(data.employees.map(m => [m.id, m]));
    const list = wrap.querySelector('#rcpAdvanceEditList');
    if (!list) return;

    list.innerHTML = data.advances.length ? data.advances.map(row => {
      const member = byId.get(row.member_id);
      return `
        <div class="row" style="align-items:center;gap:10px">
          <div class="row-main">
            <div class="row-title">${esc(fullName(member))}</div>
            <div class="row-sub">${esc(dateLabel(row.settlement_date))} · <b>${esc(fmtMoney(row.amount))}</b>${row.note ? ` · ${esc(row.note)}` : ''}</div>
          </div>
          <button class="mini-btn" type="button" data-edit-advance="${esc(row.id)}">Edytuj</button>
        </div>`;
    }).join('') : '<div class="muted small">Brak zapisanych zaliczek.</div>';

    list.querySelectorAll('[data-edit-advance]').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = data.advances.find(x => x.id === btn.dataset.editAdvance);
        if (row) openEditDialog(wrap, data, row);
      });
    });
  }

  function openEditDialog(parent, data, row) {
    if (document.getElementById('rcpAdvanceEditForm')) return;

    const form = document.createElement('div');
    form.id = 'rcpAdvanceEditForm';
    form.className = 'dialog-backdrop';
    form.style.zIndex = '2100';
    form.innerHTML = `
      <div class="dialog" style="max-width:520px">
        <h3 style="margin-top:0">Edytuj zaliczkę</h3>
        <div class="form-grid">
          <div class="field">
            <label for="rcpAdvanceEditDate">Data</label>
            <input id="rcpAdvanceEditDate" class="input" type="date" value="${esc(row.settlement_date)}" required>
          </div>
          <div class="field">
            <label for="rcpAdvanceEditAmount">Kwota</label>
            <input id="rcpAdvanceEditAmount" class="input" type="number" min="0.01" step="0.01" value="${esc(row.amount)}" required>
          </div>
          <div class="field span-2">
            <label for="rcpAdvanceEditNote">Opis</label>
            <input id="rcpAdvanceEditNote" class="input" maxlength="250" value="${esc(row.note || '')}" placeholder="opcjonalnie">
          </div>
        </div>
        <div id="rcpAdvanceEditError" class="notice notice-error" style="display:none"></div>
        <div class="dialog-actions">
          <button class="btn btn-light" type="button" data-cancel>Anuluj</button>
          <button class="btn btn-dark" type="button" data-save>Zapisz zmiany</button>
        </div>
      </div>`;

    document.body.appendChild(form);
    const close = () => form.remove();
    form.querySelector('[data-cancel]').addEventListener('click', close);
    form.addEventListener('click', e => { if (e.target === form) close(); });

    form.querySelector('[data-save]').addEventListener('click', async () => {
      const save = form.querySelector('[data-save]');
      const error = form.querySelector('#rcpAdvanceEditError');
      const settlement_date = form.querySelector('#rcpAdvanceEditDate').value;
      const amount = Number(form.querySelector('#rcpAdvanceEditAmount').value);
      const noteRaw = form.querySelector('#rcpAdvanceEditNote').value.trim();
      error.style.display = 'none';

      if (!settlement_date) {
        error.textContent = 'Podaj datę zaliczki.';
        error.style.display = 'block';
        return;
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        error.textContent = 'Kwota musi być większa od 0.';
        error.style.display = 'block';
        return;
      }

      save.disabled = true;
      save.textContent = 'Zapisywanie…';
      try {
        const updated = await api(`employee_settlements?id=eq.${encodeURIComponent(row.id)}`, {
          method: 'PATCH',
          prefer: 'return=representation',
          body: { settlement_date, amount, note: noteRaw || null }
        });
        const fresh = Array.isArray(updated) ? updated[0] : null;
        row.settlement_date = fresh?.settlement_date || settlement_date;
        row.amount = fresh?.amount ?? amount;
        row.note = fresh?.note ?? (noteRaw || null);
        dirty = true;
        close();
        renderAdvanceList(parent, data);
        toast('Zaliczka została poprawiona.', 'success');
      } catch (err) {
        error.textContent = err?.message || 'Nie udało się zapisać zmian.';
        error.style.display = 'block';
        save.disabled = false;
        save.textContent = 'Zapisz zmiany';
      }
    });
  }

  async function openAdvanceManager() {
    if (document.getElementById('rcpAdvanceManager')) return;

    const wrap = document.createElement('div');
    wrap.id = 'rcpAdvanceManager';
    wrap.className = 'dialog-backdrop';
    wrap.style.zIndex = '2000';
    wrap.innerHTML = `
      <div class="dialog" style="max-width:720px;max-height:88vh;overflow:auto">
        <div class="section-head">
          <div><h3 style="margin:0">Edytuj zaliczki</h3><div class="muted small">Zmiana daty, kwoty lub opisu zapisanej zaliczki.</div></div>
          <button class="btn btn-light" type="button" data-close>Zamknij</button>
        </div>
        <div id="rcpAdvanceEditList"><div class="spinner"></div></div>
      </div>`;
    document.body.appendChild(wrap);

    const close = () => {
      wrap.remove();
      if (dirty) window.location.reload();
    };
    wrap.querySelector('[data-close]').addEventListener('click', close);
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

    try {
      const admin = await resolveAdmin();
      if (!admin) throw new Error('Ta funkcja jest dostępna tylko dla administratora.');
      const data = await loadAdvances(admin);
      renderAdvanceList(wrap, data);
    } catch (err) {
      const list = wrap.querySelector('#rcpAdvanceEditList');
      if (list) list.innerHTML = `<div class="notice notice-error">${esc(err?.message || 'Nie udało się pobrać zaliczek.')}</div>`;
    }
  }

  async function decorate() {
    const admin = await resolveAdmin().catch(() => null);
    if (!admin) return;

    const card = document.getElementById('rcpSettlementAdminCard');
    if (card && !card.querySelector('[data-edit-advances]')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-light btn-block';
      button.dataset.editAdvances = '1';
      button.style.marginTop = '10px';
      button.textContent = 'Edytuj zapisane zaliczki';
      button.addEventListener('click', openAdvanceManager);
      card.appendChild(button);
    }

    const screen = document.getElementById('rcpSettlementScreen');
    if (screen && !screen.querySelector('[data-edit-advances]')) {
      const shell = screen.querySelector('.rcp-stats-shell');
      if (shell) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-light btn-block';
        button.dataset.editAdvances = '1';
        button.style.marginBottom = '12px';
        button.textContent = 'Edytuj zapisane zaliczki';
        button.addEventListener('click', openAdvanceManager);
        shell.insertBefore(button, shell.children[1] || null);
      }
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => decorate().catch(() => undefined), 180);
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('load', () => setTimeout(schedule, 900));
})();
