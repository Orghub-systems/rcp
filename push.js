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

  window.RCPPush = Object.freeze({});
})();
