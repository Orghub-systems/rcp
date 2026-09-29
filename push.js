(() => {
  'use strict';

  const cfg = window.RCP_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabasePublishableKey) return;

  const projectRef = new URL(cfg.supabaseUrl).hostname.split('.')[0];
  const authStorageKey = `sb-${projectRef}-auth-token`;
  const vapidPublicKey = 'BI76i--nKJOOBgtMbwE_99U31X-q2VlQyerNvIrT3G2Q2JVBOaH4y5P4WzamzCKm0RB6YvpvBCm4op63yf1SG3U';
  let decorateTimer = null;

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

  async function request(path, options = {}) {
    const session = readSession();
    if (!session?.access_token) throw new Error('Sesja wygasła. Zaloguj się ponownie.');

    const headers = {
      apikey: cfg.supabasePublishableKey,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    if (options.prefer) headers.Prefer = options.prefer;

    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body == null ? undefined : JSON.stringify(options.body)
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.message || data?.error || `Błąd ${res.status}`);
    return data;
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
    setTimeout(() => el.remove(), 3200);
  }

  async function currentMembership() {
    const session = readSession();
    if (!session?.user?.id) return null;
    const selected = localStorage.getItem('rcp:selected-membership') || '';
    const rows = await request(
      `organization_members?select=id,organization_id,user_id,role,active&user_id=eq.${encodeURIComponent(session.user.id)}&active=eq.true&order=created_at.asc`
    );
    const list = Array.isArray(rows) ? rows : [];
    return list.find(row => row.id === selected) || list[0] || null;
  }

  function keyBytes(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(ch => ch.charCodeAt(0)));
  }

  async function browserSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    const registration = await navigator.serviceWorker.ready;
    return registration.pushManager.getSubscription();
  }

  async function saveSubscription(subscription) {
    const session = readSession();
    if (!session?.user?.id) throw new Error('Brak zalogowanego administratora.');

    const json = subscription.toJSON();
    const endpoint = json.endpoint || subscription.endpoint;
    const existing = await request(
      `push_subscriptions?select=id&user_id=eq.${encodeURIComponent(session.user.id)}&endpoint=eq.${encodeURIComponent(endpoint)}&limit=1`
    );
    const row = Array.isArray(existing) ? existing[0] : null;
    const payload = {
      user_id: session.user.id,
      provider: 'webpush',
      endpoint,
      token: null,
      p256dh: json.keys?.p256dh || '',
      auth_secret: json.keys?.auth || '',
      device_label: 'RCP PWA',
      user_agent: navigator.userAgent || null,
      active: true,
      updated_at: new Date().toISOString()
    };

    if (row?.id) {
      await request(`push_subscriptions?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        body: payload,
        prefer: 'return=minimal'
      });
    } else {
      await request('push_subscriptions', {
        method: 'POST',
        body: payload,
        prefer: 'return=minimal'
      });
    }
  }

  async function invoke(body) {
    const session = readSession();
    if (!session?.access_token) throw new Error('Sesja wygasła. Zaloguj się ponownie.');

    const res = await fetch(`${cfg.supabaseUrl}/functions/v1/work-push`, {
      method: 'POST',
      headers: {
        apikey: cfg.supabasePublishableKey,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `Błąd ${res.status}`);
    return data;
  }

  async function enablePush(button) {
    button.disabled = true;
    try {
      if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        throw new Error('To urządzenie nie obsługuje powiadomień push.');
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Nie udzielono zgody na powiadomienia.');

      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();

      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(vapidPublicKey)
        });
      }

      await saveSubscription(subscription);
      toast('Powiadomienia push zostały włączone.', 'success');
      await renderPushCard(button.closest('#rcpPushAdminCard'));
    } catch (err) {
      toast(err?.message || 'Nie udało się włączyć powiadomień.', 'error');
      button.disabled = false;
    }
  }

  async function disablePush(button) {
    button.disabled = true;
    try {
      const session = readSession();
      const subscription = await browserSubscription();

      if (subscription && session?.user?.id) {
        await request(
          `push_subscriptions?user_id=eq.${encodeURIComponent(session.user.id)}&endpoint=eq.${encodeURIComponent(subscription.endpoint)}`,
          {
            method: 'PATCH',
            body: { active: false, updated_at: new Date().toISOString() },
            prefer: 'return=minimal'
          }
        ).catch(() => undefined);

        await subscription.unsubscribe();
      }

      toast('Powiadomienia push zostały wyłączone.', 'success');
      await renderPushCard(button.closest('#rcpPushAdminCard'));
    } catch (err) {
      toast(err?.message || 'Nie udało się wyłączyć powiadomień.', 'error');
      button.disabled = false;
    }
  }

  async function renderPushCard(card) {
    if (!card) return;

    const supported = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
    let enabled = false;

    if (supported && Notification.permission === 'granted') {
      try { enabled = !!(await browserSubscription()); } catch (_) {}
    }

    card.innerHTML = `
      <div class="section-head">
        <div>
          <h3>🔔 Powiadomienia push</h3>
          <div class="muted small">Start i koniec pracy pracowników</div>
        </div>
      </div>
      <div class="notice ${enabled ? 'notice-info' : 'notice-error'}" style="margin-top:0">
        ${!supported ? 'To urządzenie nie obsługuje Web Push.' : enabled ? 'Powiadomienia są włączone na tym urządzeniu.' : 'Powiadomienia są wyłączone na tym urządzeniu.'}
      </div>
      ${supported ? `<button class="btn ${enabled ? 'btn-light' : 'btn-dark'} btn-block" type="button" data-push-mode="${enabled ? 'off' : 'on'}">${enabled ? 'Wyłącz powiadomienia' : 'Włącz powiadomienia push'}</button>` : ''}
    `;

    const toggle = card.querySelector('[data-push-mode]');
    if (toggle) {
      toggle.addEventListener('click', () => toggle.dataset.pushMode === 'on' ? enablePush(toggle) : disablePush(toggle));
    }
  }

  async function decorateAdmin() {
    if (document.getElementById('rcpPushAdminCard')) return;

    const dashboard = document.querySelector('.tab.active[data-tab="dashboard"]');
    if (!dashboard) return;

    const member = await currentMembership();
    if (!member || member.role !== 'admin') return;

    const tabs = dashboard.closest('.tabs');
    if (!tabs) return;

    const card = document.createElement('div');
    card.id = 'rcpPushAdminCard';
    card.className = 'card';

    const anchor = document.getElementById('rcpSettlementAdminCard')
      || document.getElementById('rcpStatsAdminCard')
      || document.getElementById('rcpVacationAdminCard')
      || tabs;

    anchor.insertAdjacentElement('afterend', card);
    await renderPushCard(card);
  }

  async function notifyWorkEvent(memberId, sessionId, eventType) {
    if (!memberId || !sessionId || !['start', 'stop'].includes(eventType)) return;
    try {
      await invoke({
        action: 'send_work_event',
        member_id: memberId,
        session_id: sessionId,
        event_type: eventType
      });
    } catch (err) {
      console.warn('RCP push:', err);
    }
  }

  window.RCPPush = Object.freeze({ notifyWorkEvent });

  function scheduleDecorate() {
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(() => decorateAdmin().catch(() => undefined), 160);
  }

  new MutationObserver(scheduleDecorate).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('load', () => setTimeout(scheduleDecorate, 700));
})();
