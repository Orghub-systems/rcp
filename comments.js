(() => {
  'use strict';

  const cfg = window.RCP_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabasePublishableKey) return;

  const projectRef = new URL(cfg.supabaseUrl).hostname.split('.')[0];
  const authStorageKey = `sb-${projectRef}-auth-token`;
  const pendingKey = 'rcp:pending-work-comment-v1';
  const maxCommentLength = 200;
  const gpsTasks = new Map();

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

  function captureStopLocation() {
    if (!('geolocation' in navigator)) {
      return Promise.resolve({ status: 'unsupported' });
    }

    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        position => {
          const latitude = Number(position.coords.latitude);
          const longitude = Number(position.coords.longitude);
          const accuracy = Number(position.coords.accuracy);
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            resolve({ status: 'error' });
            return;
          }
          resolve({
            status: 'captured',
            latitude,
            longitude,
            accuracy: Number.isFinite(accuracy) ? accuracy : null
          });
        },
        error => {
          const status = error?.code === 1
            ? 'denied'
            : error?.code === 2
              ? 'unavailable'
              : error?.code === 3
                ? 'timeout'
                : 'error';
          resolve({ status });
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0
        }
      );
    });
  }

  function gpsStatusText(status) {
    if (status === 'captured') return 'Pozycja GPS została zapisana.';
    if (status === 'denied') return 'Pozycja GPS nie została zapisana — brak zgody na lokalizację.';
    if (status === 'unavailable') return 'Pozycja GPS nie została zapisana — lokalizacja jest niedostępna.';
    if (status === 'timeout') return 'Pozycja GPS nie została zapisana — telefon nie ustalił pozycji na czas.';
    if (status === 'unsupported') return 'Pozycja GPS nie została zapisana — urządzenie nie udostępnia lokalizacji.';
    if (status === 'error') return 'Pozycja GPS nie została zapisana.';
    return 'Ustalanie pozycji GPS…';
  }

  function updateGpsStatus(status) {
    const el = document.getElementById('rcpGpsStatus');
    if (!el) return;
    el.textContent = gpsStatusText(status);
    el.className = status === 'captured' ? 'notice notice-info' : 'small muted';
    el.style.marginTop = '10px';
  }

  async function saveStopLocation(sessionId, locationPromise) {
    let location = { status: 'error' };
    try {
      location = await locationPromise;
      await rpc('save_stop_location', {
        p_session_id: sessionId,
        p_status: location.status,
        p_latitude: location.status === 'captured' ? location.latitude : null,
        p_longitude: location.status === 'captured' ? location.longitude : null,
        p_accuracy_m: location.status === 'captured' ? location.accuracy : null
      });
    } catch (err) {
      console.warn('Nie udało się zapisać GPS końca pracy:', err);
      location = { status: 'error' };
    }
    updateGpsStatus(location.status);
    return location;
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
        <div id="rcpGpsStatus" class="small muted" style="margin-top:10px">Ustalanie pozycji GPS…</div>
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
        const gpsTask = gpsTasks.get(sessionId);
        if (gpsTask) {
          send.textContent = 'Zapisywanie GPS…';
          await gpsTask.catch(() => undefined);
          gpsTasks.delete(sessionId);
        }
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

    // Uruchamiamy lokalizację natychmiast po kliknięciu, ale nie opóźniamy serwerowego STOP-u.
    const locationPromise = captureStopLocation();

    try {
      const memberId = await resolveCurrentMembershipId();
      const result = unwrapSession(await rpc('stop_work', { p_member_id: memberId }));
      const sessionId = result?.id || await latestClosedSessionId(memberId);
      if (!sessionId) throw new Error('Czas zakończono, ale nie udało się odnaleźć wpisu do komentarza.');

      savePending(sessionId, memberId);
      showCommentCard(sessionId);

      const gpsTask = saveStopLocation(sessionId, locationPromise);
      gpsTasks.set(sessionId, gpsTask);
      gpsTask.finally(() => {
        if (gpsTasks.get(sessionId) === gpsTask) gpsTasks.delete(sessionId);
      });
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
    if (pending?.sessionId) {
      showCommentCard(pending.sessionId);
      updateGpsStatus('error');
    }
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

  function escHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  function gpsAdminHtml(row) {
    const status = row?.stop_location_status;
    if (!status) return '';

    if (status === 'captured' && Number.isFinite(Number(row.stop_latitude)) && Number.isFinite(Number(row.stop_longitude))) {
      const lat = Number(row.stop_latitude);
      const lon = Number(row.stop_longitude);
      const accuracy = Number(row.stop_accuracy_m);
      const accuracyText = Number.isFinite(accuracy) ? ` · dokładność ±${Math.round(accuracy)} m` : '';
      const mapUrl = `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lon}`)}`;
      return `<div><b>GPS końca:</b> ${lat.toFixed(6)}, ${lon.toFixed(6)}${accuracyText} · <a href="${mapUrl}" target="_blank" rel="noopener noreferrer">Mapa</a></div>`;
    }

    const labels = {
      denied: 'brak zgody na lokalizację',
      unavailable: 'lokalizacja niedostępna',
      timeout: 'nie udało się ustalić pozycji na czas',
      unsupported: 'urządzenie nie obsługuje lokalizacji',
      error: 'nie udało się zapisać lokalizacji'
    };
    return `<div><b>GPS końca:</b> ${escHtml(labels[status] || status)}</div>`;
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
    const undecorated = ids.filter(id => !document.querySelector(`[data-rcp-meta-for="${id}"]`));
    if (!undecorated.length) return;

    try {
      const rows = await request(
        `work_sessions?select=id,note,stop_latitude,stop_longitude,stop_accuracy_m,stop_location_status,stop_location_at&id=in.(${undecorated.join(',')})`
      );
      const details = new Map((Array.isArray(rows) ? rows : []).map(row => [row.id, row]));

      for (const editButton of editButtons) {
        const id = editButton.dataset.editSession;
        if (!id || document.querySelector(`[data-rcp-meta-for="${id}"]`)) continue;
        const rowMain = editButton.closest('.row')?.querySelector('.row-main');
        if (!rowMain) continue;

        const row = details.get(id) || {};
        const parts = [];
        if (row.note) parts.push(`<div><b>Komentarz:</b> ${escHtml(row.note)}</div>`);
        const gps = gpsAdminHtml(row);
        if (gps) parts.push(gps);

        const marker = document.createElement('div');
        marker.dataset.rcpMetaFor = id;
        marker.className = 'row-sub';
        marker.style.marginTop = '5px';
        marker.innerHTML = parts.join('');
        rowMain.appendChild(marker);
      }
    } catch (_) {
      // Lista czasu nadal działa nawet gdy komentarzy/GPS chwilowo nie uda się dociągnąć.
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
