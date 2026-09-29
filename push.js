(() => {
  'use strict';

  const cfg = window.RCP_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabasePublishableKey) return;

  const projectRef = new URL(cfg.supabaseUrl).hostname.split('.')[0];
  const authStorageKey = `sb-${projectRef}-auth-token`;

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

  window.RCPPush = Object.freeze({});
})();
