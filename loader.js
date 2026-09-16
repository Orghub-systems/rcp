(() => {
  const parts = [
    './app.part01.txt',
    './app.part02.txt',
    './app.part03.txt',
    './app.part04.txt'
  ];

  function patchRcp(source) {
    source = source.replace(
      ".select('id, organization_id, user_id, first_name, last_name, role, active, login_email')",
      ".select('id, organization_id, user_id, first_name, last_name, role, active, login_email, employee_login')"
    );

    source = source.replace(
      /  function renderLogin\(message = ''\) \{[\s\S]*?\n  \}\n\n  function roleLabel\(role\) \{/,
      `  async function functionErrorMessage(error, fallback = 'Nie udało się wykonać operacji.') {
    let message = error?.message || fallback;
    try {
      const response = error?.context;
      if (response && typeof response.clone === 'function') {
        const payload = await response.clone().json();
        if (payload?.error) message = payload.error;
      }
    } catch (_) {}
    return message;
  }

  function renderLogin(message = '', requestedMode = '') {
    clearTimer();
    const savedMode = localStorage.getItem('rcp:login-mode');
    const mode = requestedMode === 'admin' || requestedMode === 'employee'
      ? requestedMode
      : (savedMode === 'admin' ? 'admin' : 'employee');
    localStorage.setItem('rcp:login-mode', mode);

    const employeeForm = \`
      <p class="muted">Pracownik loguje się bez e-maila — kodem firmy, loginem i 6-cyfrowym PIN-em.</p>
      <form id="employeeLoginForm">
        <div class="field">
          <label for="employeeCompany">Kod firmy</label>
          <input id="employeeCompany" class="input" autocomplete="organization" placeholder="np. intevero" required />
        </div>
        <div class="field">
          <label for="employeeLogin">Login</label>
          <input id="employeeLogin" class="input" autocomplete="username" autocapitalize="none" placeholder="np. rafal" required />
        </div>
        <div class="field">
          <label for="employeePin">PIN</label>
          <input id="employeePin" class="input" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{6}" maxlength="6" placeholder="••••••" required />
        </div>
        <button class="btn btn-dark btn-block" type="submit">Zaloguj</button>
      </form>\`;

    const adminEmail = state.user?.email || '';
    const adminForm = \`
      <p class="muted">Administrator loguje się adresem e-mail i 6-cyfrowym PIN-em.</p>
      <form id="adminLoginForm">
        <div class="field">
          <label for="loginEmail">E-mail</label>
          <input id="loginEmail" class="input" type="email" autocomplete="username" value="\${esc(adminEmail)}" placeholder="np. biuro@firma.pl" required />
        </div>
        <div class="field">
          <label for="adminPin">PIN</label>
          <input id="adminPin" class="input" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{6}" maxlength="6" placeholder="••••••" required />
        </div>
        <button class="btn btn-dark btn-block" type="submit">Zaloguj</button>
        <button id="adminPinSetupBtn" class="btn btn-light btn-block" type="button" style="margin-top:8px">Ustaw / zresetuj PIN przez e-mail</button>
      </form>\`;

    $app.innerHTML = \`
      <div class="shell">
        <div class="login-wrap">
          <div class="logo login-logo">RCP</div>
          <div class="card">
            <h2>Rejestracja czasu pracy</h2>
            <div class="tabs" style="grid-template-columns:repeat(2,1fr)">
              <button class="tab \${mode === 'employee' ? 'active' : ''}" type="button" data-login-mode="employee">Pracownik</button>
              <button class="tab \${mode === 'admin' ? 'active' : ''}" type="button" data-login-mode="admin">Administrator</button>
            </div>
            \${mode === 'employee' ? employeeForm : adminForm}
            \${message ? \`<div class="notice notice-info">\${esc(message)}</div>\` : ''}
          </div>
        </div>
      </div>\`;

    document.querySelectorAll('[data-login-mode]').forEach(btn => btn.addEventListener('click', () => renderLogin('', btn.dataset.loginMode)));

    document.getElementById('employeeLoginForm')?.addEventListener('submit', async e => {
      e.preventDefault();
      const organization = document.getElementById('employeeCompany').value.trim().toLowerCase();
      const login = document.getElementById('employeeLogin').value.trim().toLowerCase();
      const pin = document.getElementById('employeePin').value.trim();
      const btn = e.currentTarget.querySelector('button');
      btn.disabled = true;
      btn.textContent = 'Logowanie…';

      const { data, error } = await db.functions.invoke('employee-auth', {
        body: { action: 'login', organization, login, pin }
      });

      if (error || data?.error || !data?.session) {
        toast(data?.error || await functionErrorMessage(error, 'Nieprawidłowe dane logowania.'), 'error');
        btn.disabled = false;
        btn.textContent = 'Zaloguj';
        return;
      }

      sessionStorage.removeItem('rcp:admin-pin-ok');
      const { error: sessionError } = await db.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token
      });
      if (sessionError) {
        toast(sessionError.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Zaloguj';
        return;
      }
      loading();
      await route();
    });

    document.getElementById('adminLoginForm')?.addEventListener('submit', async e => {
      e.preventDefault();
      const email = document.getElementById('loginEmail').value.trim().toLowerCase();
      const pin = document.getElementById('adminPin').value.trim();
      const btn = e.currentTarget.querySelector('button[type="submit"]');
      if (!/^\\d{6}$/.test(pin)) return toast('PIN administratora musi mieć dokładnie 6 cyfr.', 'error');
      btn.disabled = true;
      btn.textContent = 'Logowanie…';

      const { data, error } = await db.functions.invoke('employee-auth', {
        body: { action: 'admin_login', email, pin }
      });

      if (error || data?.error || !data?.session || !data?.user_id) {
        toast(data?.error || await functionErrorMessage(error, 'Nieprawidłowy e-mail lub PIN.'), 'error');
        btn.disabled = false;
        btn.textContent = 'Zaloguj';
        return;
      }

      sessionStorage.setItem('rcp:admin-pin-ok', data.user_id);
      const { error: sessionError } = await db.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token
      });
      if (sessionError) {
        sessionStorage.removeItem('rcp:admin-pin-ok');
        toast(sessionError.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Zaloguj';
        return;
      }
      loading();
      await route();
    });

    document.getElementById('adminPinSetupBtn')?.addEventListener('click', async () => {
      const email = document.getElementById('loginEmail').value.trim().toLowerCase();
      if (!email) return toast('Najpierw wpisz adres e-mail administratora.', 'error');
      const btn = document.getElementById('adminPinSetupBtn');
      btn.disabled = true;
      btn.textContent = 'Wysyłanie…';
      const base = window.location.href.split('#')[0].split('?')[0];
      const redirectTo = base + '?adminPinSetup=1';
      const { error } = await db.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo, shouldCreateUser: false }
      });
      if (error) {
        toast(error.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Ustaw / zresetuj PIN przez e-mail';
        return;
      }
      renderLogin('Wysłaliśmy link na e-mail. Otwórz go na tym urządzeniu, aby ustawić nowy PIN.', 'admin');
    });
  }

  function renderAdminPinSetup(message = '') {
    clearTimer();
    const email = state.user?.email || '';
    $app.innerHTML = \`
      <div class="shell">
        <div class="login-wrap">
          <div class="logo login-logo">RCP</div>
          <div class="card">
            <h2>PIN administratora</h2>
            <p class="muted">Konto: <b>\${esc(email)}</b></p>
            <p class="muted">\${esc(message || 'Ustaw 6-cyfrowy PIN. Od tej pory będziesz logować się e-mailem i PIN-em.')}</p>
            <form id="adminPinSetForm">
              <div class="field"><label for="newAdminPin">Nowy PIN</label><input id="newAdminPin" class="input" type="password" inputmode="numeric" autocomplete="new-password" pattern="[0-9]{6}" maxlength="6" placeholder="••••••" required /></div>
              <div class="field"><label for="newAdminPin2">Powtórz PIN</label><input id="newAdminPin2" class="input" type="password" inputmode="numeric" autocomplete="new-password" pattern="[0-9]{6}" maxlength="6" placeholder="••••••" required /></div>
              <button class="btn btn-dark btn-block" type="submit">Ustaw PIN</button>
            </form>
          </div>
        </div>
      </div>\`;

    document.getElementById('adminPinSetForm').addEventListener('submit', async e => {
      e.preventDefault();
      const pin = document.getElementById('newAdminPin').value.trim();
      const pin2 = document.getElementById('newAdminPin2').value.trim();
      if (!/^\\d{6}$/.test(pin)) return toast('PIN musi mieć dokładnie 6 cyfr.', 'error');
      if (pin !== pin2) return toast('Wpisane PIN-y są różne.', 'error');
      const btn = e.currentTarget.querySelector('button');
      btn.disabled = true;
      btn.textContent = 'Zapisywanie…';
      const { data, error } = await db.functions.invoke('employee-auth', {
        body: { action: 'admin_set_pin', pin }
      });
      if (error || data?.error) {
        toast(data?.error || await functionErrorMessage(error, 'Nie udało się ustawić PIN-u.'), 'error');
        btn.disabled = false;
        btn.textContent = 'Ustaw PIN';
        return;
      }
      sessionStorage.removeItem('rcp:admin-pin-ok');
      const cleanUrl = window.location.href.split('#')[0].split('?')[0];
      history.replaceState({}, '', cleanUrl);
      await db.auth.signOut();
      renderLogin('PIN został ustawiony. Zaloguj się teraz e-mailem i PIN-em.', 'admin');
    });
  }

  function roleLabel(role) {`
    );

    source = source.replace(
      "${esc(member.login_email || 'brak e-maila')} · ${rate ? fmtMoney(rate.hourly_rate) + '/h' : 'brak stawki'}",
      "${esc(member.employee_login ? 'login: ' + member.employee_login : 'brak loginu')} · ${rate ? fmtMoney(rate.hourly_rate) + '/h' : 'brak stawki'}"
    );

    source = source.replace(
      '<button class="mini-btn" data-rate="${member.id}">Stawka</button><button class="mini-btn" data-toggle-member=',
      '<button class="mini-btn" data-credentials="${member.id}">Dane logowania</button><button class="mini-btn" data-rate="${member.id}">Stawka</button><button class="mini-btn" data-toggle-member='
    );

    source = source.replace(
      "    document.getElementById('addSessionBtn')?.addEventListener('click', openAddSession);\n",
      "    document.getElementById('addSessionBtn')?.addEventListener('click', openAddSession);\n    document.querySelectorAll('[data-credentials]').forEach(b => b.addEventListener('click', () => openEmployeeCredentials(b.dataset.credentials)));\n"
    );

    source = source.replace(
      "  async function logout() {\n    await db.auth.signOut();",
      "  async function logout() {\n    sessionStorage.removeItem('rcp:admin-pin-ok');\n    await db.auth.signOut();"
    );

    source = source.replace(
      /  function openAddEmployee\(\) \{[\s\S]*?\n  \}\n\n  function openRate\(memberId\) \{/,
      `  function openAddEmployee() {
    const today = localDateKey(new Date());
    const { wrap, save } = dialog('Dodaj pracownika', \`<div class="form-grid">
      <div class="field"><label>Imię</label><input id="empFirst" class="input" required></div>
      <div class="field"><label>Nazwisko</label><input id="empLast" class="input"></div>
      <div class="field"><label>Login</label><input id="empLogin" class="input" autocomplete="off" autocapitalize="none" placeholder="np. rafal" required></div>
      <div class="field"><label>PIN — 6 cyfr</label><input id="empPin" class="input" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="new-password" required></div>
      <div class="field"><label>Stawka brutto / godz.</label><input id="empRate" class="input" type="number" min="0" step="0.01" placeholder="opcjonalnie"></div>
      <div class="field"><label>Stawka obowiązuje od</label><input id="empRateFrom" class="input" type="date" value="\${today}"></div>
      <div class="field span-2"><div class="notice notice-info" style="margin-top:0">Pracownik nie podaje adresu e-mail. Do logowania dostaje kod firmy <b>\${esc(state.organization?.slug || '')}</b>, login i PIN.</div></div>
    </div>\`, 'Dodaj');
    save.addEventListener('click', async () => {
      const first_name = wrap.querySelector('#empFirst').value.trim();
      const last_name = wrap.querySelector('#empLast').value.trim() || null;
      const login = wrap.querySelector('#empLogin').value.trim().toLowerCase();
      const pin = wrap.querySelector('#empPin').value.trim();
      const rateRaw = wrap.querySelector('#empRate').value.trim();
      const hourly_rate = rateRaw === '' ? null : Number(rateRaw);
      const valid_from = wrap.querySelector('#empRateFrom').value || today;

      if (!first_name) return toast('Podaj imię pracownika.', 'error');
      if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(login)) return toast('Login: 3–40 znaków, małe litery, cyfry, kropka, myślnik lub podkreślenie.', 'error');
      if (!/^\\d{6}$/.test(pin)) return toast('PIN musi mieć dokładnie 6 cyfr.', 'error');
      if (hourly_rate != null && (!Number.isFinite(hourly_rate) || hourly_rate < 0)) return toast('Sprawdź stawkę godzinową.', 'error');

      save.disabled = true;
      const { data, error } = await db.functions.invoke('employee-auth', {
        body: {
          action: 'create',
          organization_id: state.membership.organization_id,
          first_name,
          last_name,
          login,
          pin,
          hourly_rate,
          valid_from
        }
      });

      if (error || data?.error) {
        toast(data?.error || await functionErrorMessage(error, 'Nie udało się dodać pracownika.'), 'error');
        save.disabled = false;
        return;
      }

      wrap.remove();
      toast(\`Pracownik dodany. Login: \${login}\`, 'success');
      await loadAdminData();
      renderAdmin();
    });
  }

  function generateEmployeePin() {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return String(values[0] % 1000000).padStart(6, '0');
  }

  async function copyRcpText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    document.execCommand('copy');
    area.remove();
  }

  function employeeLoginInstruction(member, pin) {
    const company = state.organization?.slug || '';
    return [
      'RCP – rejestracja czasu pracy',
      '',
      'Wejdź na: https://rcp.orghub.pl',
      '',
      'Dane logowania:',
      'Kod firmy: ' + company,
      'Login: ' + member.employee_login,
      'PIN: ' + pin,
      '',
      'Instalacja aplikacji:',
      'Android / Chrome: menu ⋮ → Zainstaluj aplikację lub Dodaj do ekranu głównego.',
      'iPhone / Safari: Udostępnij → Do ekranu początkowego → Dodaj.',
      '',
      'Po uruchomieniu wybierz „Pracownik” i wpisz powyższe dane.'
    ].join('\\n');
  }

  function openEmployeeCredentials(memberId) {
    const member = state.members.find(m => m.id === memberId);
    if (!member) return;
    if (!member.employee_login) return toast('Ten pracownik nie ma jeszcze loginu RCP.', 'error');

    const company = state.organization?.slug || '';
    const pin = generateEmployeePin();
    const fullName = [member.first_name, member.last_name].filter(Boolean).join(' ');
    const body = '<div class="form-grid">' +
      '<div class="field"><label>Kod firmy</label><input class="input" value="' + esc(company) + '" readonly></div>' +
      '<div class="field"><label>Login</label><input class="input" value="' + esc(member.employee_login) + '" readonly></div>' +
      '<div class="field"><label>Nowy PIN — 6 cyfr</label><input id="sharePin" class="input" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" value="' + esc(pin) + '" required></div>' +
      '<div class="field" style="display:flex;align-items:end"><button id="generateSharePin" class="btn btn-light btn-block" type="button">Generuj inny PIN</button></div>' +
      '<div class="field span-2"><div class="notice notice-info" style="margin-top:0">Obecnego PIN-u nie można odczytać. Kliknięcie <b>Ustaw PIN i kopiuj</b> ustawi PIN z pola powyżej i skopiuje gotową instrukcję dla pracownika.</div></div>' +
      '</div>';

    const { wrap, save } = dialog('Dane logowania — ' + fullName, body, 'Ustaw PIN i kopiuj');
    const pinInput = wrap.querySelector('#sharePin');
    wrap.querySelector('#generateSharePin').addEventListener('click', () => { pinInput.value = generateEmployeePin(); });

    save.addEventListener('click', async () => {
      const newPin = pinInput.value.trim();
      if (!/^\\d{6}$/.test(newPin)) return toast('PIN musi mieć dokładnie 6 cyfr.', 'error');
      save.disabled = true;
      const { data, error } = await db.functions.invoke('employee-auth', {
        body: {
          action: 'reset_pin',
          organization_id: state.membership.organization_id,
          member_id: member.id,
          pin: newPin
        }
      });
      if (error || data?.error) {
        toast(data?.error || await functionErrorMessage(error, 'Nie udało się ustawić PIN-u.'), 'error');
        save.disabled = false;
        return;
      }
      try {
        await copyRcpText(employeeLoginInstruction(member, newPin));
      } catch (_) {
        toast('PIN został ustawiony, ale przeglądarka nie pozwoliła skopiować tekstu.', 'error');
        save.disabled = false;
        return;
      }
      wrap.remove();
      toast('Nowy PIN ustawiony. Instrukcja została skopiowana.', 'success');
    });
  }

  function openRate(memberId) {`
    );

    source = source.replace(
      /  async function route\(\) \{[\s\S]*?\n  \}\n\n  db\.auth\.onAuthStateChange/,
      `  async function route() {
    loading();
    try {
      await loadIdentity();
      if (!state.user) return renderLogin();

      const hasAdminAccess = state.platformAdmin || state.memberships.some(m => m.role === 'admin');
      if (hasAdminAccess) {
        const { data: pinStatus, error: pinStatusError } = await db.functions.invoke('employee-auth', {
          body: { action: 'admin_pin_status' }
        });
        if (pinStatusError || pinStatus?.error) {
          throw new Error(pinStatus?.error || await functionErrorMessage(pinStatusError, 'Nie udało się sprawdzić zabezpieczenia PIN.'));
        }

        const setupRequested = new URLSearchParams(window.location.search).get('adminPinSetup') === '1';
        if (setupRequested || !pinStatus?.configured) {
          return renderAdminPinSetup(setupRequested
            ? 'Potwierdziłeś adres e-mail. Ustaw teraz nowy 6-cyfrowy PIN administratora.'
            : 'To konto nie ma jeszcze PIN-u administratora. Ustaw go teraz.');
        }

        if (sessionStorage.getItem('rcp:admin-pin-ok') !== state.user.id) {
          return renderLogin('Potwierdź dostęp administracyjny e-mailem i PIN-em.', 'admin');
        }
      }

      if (state.view === 'platform' && state.platformAdmin) {
        await loadPlatformData();
        return renderPlatform();
      }
      return await renderSelectedTenant();
    } catch (err) {
      console.error(err);
      $app.innerHTML = \`<div class="shell"><div class="card"><h2>Błąd aplikacji</h2><div class="notice notice-error">\${esc(err?.message || 'Nie udało się pobrać danych.')}</div><button id="retryBtn" class="btn btn-dark" style="margin-top:12px">Spróbuj ponownie</button></div></div>\`;
      document.getElementById('retryBtn').addEventListener('click', route);
    }
  }

  db.auth.onAuthStateChange`
    );

    return source;
  }

  Promise.all(parts.map(p => fetch(p, { cache: 'no-store' }).then(r => {
    if (!r.ok) throw new Error(`Nie udało się pobrać ${p}`);
    return r.text();
  }))).then(chunks => {
    const source = patchRcp(chunks.join(''));
    (0, eval)(source);
  }).catch(err => {
    console.error(err);
    document.getElementById('app').innerHTML = '<div class="shell"><div class="card notice-error">Nie udało się uruchomić aplikacji.</div></div>';
  });
})();
