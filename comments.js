(() => {
  'use strict';

  const cfg = window.RCP_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabasePublishableKey) return;

  const projectRef = new URL(cfg.supabaseUrl).hostname.split('.')[0];
  const authStorageKey = `sb-${projectRef}-auth-token`;
  const pendingKey = 'rcp:pending-work-comment-v1';
  const maxCommentLength = 200;

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

  async function request(path, { method = 'GET', body } = {}) {
    const session = readSession();
    if (!session?.access_token) throw new Error('Sesja wygasła. Zaloguj się ponownie.');

    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: cfg.supabasePublishableKey,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: body == null ? undefined : JSON.stringify(body)
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const message = data?.message || data?.details || data?.hint || data?.code || `Błąd ${res.status}`;
      throw new Error(message);
    }
    return data;
  }

  async function rpc(name, body) {
    return request(`rpc/${name}`, { method: 'POST', body });
  }

  async function resolveCurrentMembershipId() {
    const session = readSession();
    if (!session?.user?.id) throw new Error('Nie udało się odczytać konta pracownika.');

    const selected = localStorage.getItem('rcp:selected-membership');
    const rows = await request(
      `organization_members?select=id,role,active,created_at&user_id=eq.${encodeURIComponent(session.user.id)}&active=eq.true&order=created_at.asc`
    );
    const memberships = Array.isArray(rows) ? rows : [];
    const membership = memberships.find(m => m.id === selected) || memberships[0];
    if (!membership?.id) throw new Error('Nie znaleziono aktywnego przypisania pracownika.');
    return membership.id;
  }

  function unwrapSession(data) {
    if (Array.isArray(data)) return data[0] || null;
    return data || null;
  }

  async function latestClosedSessionId(memberId) {
    const rows = await request(
      `work_sessions?select=id,ended_at&member_id=eq.${encodeURIComponent(memberId)}&ended_at=not.is.null&order=ended_at.desc&limit=1`
    );
    return Array.isArray(rows) ? rows[0]?.id || null : null;
  }

  function savePending(sessionId, memberId) {
    const auth = readSession();
    localStorage.setItem(pendingKey, JSON.stringify({
      sessionId,
      memberId,
      userId: auth?.user?.id || '',
      createdAt: new Date().toISOString()
    }));
  }

  function readPending() {
    try {
      const pending = JSON.parse(localStorage.getItem(pendingKey) || 'null');
      const auth = readSession();
      if (!pending?.sessionId || !pending?.userId || pending.userId !== auth?.user?.id) return null;
      return pending;
    } catch (_) {
      return null;
    }
  }

  function clearPending() {
    localStorage.removeItem(pendingKey);
  }

  function showCommentCard(sessionId) {
    if (!sessionId || document.getElementById('rcpEndComment')) return;

    const wrap = document.createElement('div');
    wrap.id = 'rcpEndComment';
    wrap.className = 'dialog-backdrop';
    wrap.innerHTML = `
      <div class="dialog" style="max-width:520px">
        <h3 style="margin-top:0">Komentarz po pracy</h3>
        <p class="muted small">Napisz krótko, gdzie pracowałeś albo co robiłeś.</p>
        <div class="field">
          <label for="rcpWorkComment">Komentarz</label>
          <textarea id="rcpWorkComment" class="input" maxlength="${maxCommentLength}" rows="4" placeholder="np. Sosnowiec — serwis kotłowni" style="resize:vertical;min-height:100px"></textarea>
          <div class="small muted" style="text-align:right;margin-top:6px"><span id="rcpCommentCount">0</span>/${maxCommentLength}</div>
        </div>
        <div id="rcpCommentError" class="notice notice-error" style="display:none"></div>
        <button id="rcpCommentSend" class="btn btn-dark btn-block" type="button">Wyślij</button>
      </div>`;
    document.body.appendChild(wrap);

    const textarea = wrap.querySelector('#rcpWorkComment');
    const count = wrap.querySelector('#rcpCommentCount');
    const errorBox = wrap.querySelector('#rcpCommentError');
    const send = wrap.querySelector('#rcpCommentSend');

    textarea.addEventListener('input', () => { count.textContent = String(textarea.value.length); });
    setTimeout(() => textarea.focus(), 50);

    send.addEventListener('click', async () => {
      const comment = textarea.value.trim();
      errorBox.style.display = 'none';
      if (!comment) {
        errorBox.textContent = 'Wpisz krótki komentarz.';
        errorBox.style.display = 'block';
        textarea.focus();
        return;
      }
      if (comment.length > maxCommentLength) {
        errorBox.textContent = `Komentarz może mieć maksymalnie ${maxCommentLength} znaków.`;
        errorBox.style.display = 'block';
        return;
      }

      send.disabled = true;
      send.textContent = 'Wysyłanie…';
      try {
        await rpc('save_work_comment', { p_session_id: sessionId, p_comment: comment });
        clearPending();
        send.textContent = 'Wysłano';
        setTimeout(() => window.location.reload(), 350);
      } catch (err) {
        errorBox.textContent = err?.message || 'Nie udało się zapisać komentarza.';
        errorBox.style.display = 'block';
        send.disabled = false;
        send.textContent = 'Wyślij';
      }
    });
  }

  async function stopAndAskForComment(button) {
    button.disabled = true;
    const oldText = button.textContent;
    button.textContent = 'KOŃCZĘ…';

    try {
      const memberId = await resolveCurrentMembershipId();
      const result = unwrapSession(await rpc('stop_work', { p_member_id: memberId }));
      const sessionId = result?.id || await latestClosedSessionId(memberId);
      if (!sessionId) throw new Error('Czas zakończono, ale nie udało się odnaleźć wpisu do komentarza.');

      savePending(sessionId, memberId);
      showCommentCard(sessionId);
    } catch (err) {
      button.disabled = false;
      button.textContent = oldText;
      window.alert(err?.message || 'Nie udało się zakończyć pracy.');
    }
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('#punchBtn.punch-stop');
    if (!button) return;

    // Przechwytujemy tylko KOŃCZĘ. ZACZYNAM nadal obsługuje główna aplikacja.
    event.preventDefault();
    event.stopImmediatePropagation();
    stopAndAskForComment(button);
  }, true);

  function restorePendingComment() {
    const pending = readPending();
    if (pending?.sessionId) showCommentCard(pending.sessionId);
  }

  function formatSessionLabel(row) {
    const name = [row?.first_name, row?.last_name].filter(Boolean).join(' ').trim() || 'pracownika';
    const start = row?.started_at ? new Date(row.started_at).toLocaleString('pl-PL') : '';
    return start ? `${name} — ${start}` : name;
  }

  async function deleteAdminSession(sessionId, button) {
    if (!sessionId || button.disabled) return;
    button.disabled = true;

    try {
      const rows = await request(
        `work_sessions_with_earnings?select=id,first_name,last_name,started_at,ended_at&id=eq.${encodeURIComponent(sessionId)}&limit=1`
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) throw new Error('Nie znaleziono wpisu czasu pracy.');

      const openWarning = row.ended_at ? '' : '\n\nUWAGA: ten wpis jest nadal aktywny.';
      const confirmed = window.confirm(
        `Usunąć wpis czasu pracy?\n\n${formatSessionLabel(row)}${openWarning}\n\nTej operacji nie da się cofnąć.`
      );
      if (!confirmed) {
        button.disabled = false;
        return;
      }

      button.textContent = 'Usuwanie…';
      await request(`work_sessions?id=eq.${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      button.textContent = 'Usunięto';
      setTimeout(() => window.location.reload(), 250);
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Usuń';
      window.alert(err?.message || 'Nie udało się usunąć wpisu.');
    }
  }

  let noteTimer = null;
  async function decorateAdminRows() {
    const editButtons = [...document.querySelectorAll('[data-edit-session]')];
    if (!editButtons.length) return;

    for (const editButton of editButtons) {
      const id = editButton.dataset.editSession;
      const actions = editButton.closest('.member-actions');
      if (!id || !actions || actions.querySelector(`[data-delete-session="${id}"]`)) continue;

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mini-btn';
      del.dataset.deleteSession = id;
      del.textContent = 'Usuń';
      del.style.marginLeft = '6px';
      del.style.borderColor = '#dc2626';
      del.style.color = '#b91c1c';
      del.addEventListener('click', () => deleteAdminSession(id, del));
      actions.appendChild(del);
    }

    const ids = editButtons.map(b => b.dataset.editSession).filter(Boolean);
    const undecorated = ids.filter(id => !document.querySelector(`[data-rcp-note-for="${id}"]`));
    if (!undecorated.length) return;

    try {
      const rows = await request(`work_sessions_with_earnings?select=id,note&id=in.(${undecorated.join(',')})`);
      const notes = new Map((Array.isArray(rows) ? rows : []).map(row => [row.id, row.note]));

      for (const editButton of editButtons) {
        const id = editButton.dataset.editSession;
        if (!id || document.querySelector(`[data-rcp-note-for="${id}"]`)) continue;
        const rowMain = editButton.closest('.row')?.querySelector('.row-main');
        if (!rowMain) continue;

        const note = notes.get(id);
        const marker = document.createElement('div');
        marker.dataset.rcpNoteFor = id;
        marker.className = 'row-sub';
        marker.style.marginTop = '5px';
        marker.innerHTML = note
          ? `<b>Komentarz:</b> ${String(note).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}`
          : '';
        rowMain.appendChild(marker);
      }
    } catch (_) {
      // Lista czasu nadal działa nawet gdy komentarzy chwilowo nie uda się dociągnąć.
    }
  }

  const observer = new MutationObserver(() => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      decorateAdminRows();
      restorePendingComment();
    }, 120);
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('load', () => setTimeout(() => {
    decorateAdminRows();
    restorePendingComment();
  }, 500));
})();
