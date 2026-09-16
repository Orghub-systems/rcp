(() => {
  const parts = [
    './app.part01.txt',
    './app.part02.txt',
    './app.part03.txt',
    './app.part04.txt'
  ];

  function patchEmployeeAuth(source) {
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

    const adminForm = \`
      <p class="muted">Administrator loguje się e-mailem przez bezpieczny link.</p>
      <form id="adminLoginForm">
        <div class="field">
          <label for="loginEmail">E-mail</label>
          <input id="loginEmail" class="input" type="email" autocomplete="email" placeholder="np. biuro@firma.pl" required />
        </div>
        <button class="btn btn-dark btn-block" type="submit">Wyślij link logowania</button>
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
      const btn = e.currentTarget.querySelector('button');
      btn.disabled = true;
      btn.textContent = 'Wysyłanie…';
      const redirectTo = window.location.href.split('#')[0].split('?')[0];
      const { error } = await db.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
      if (error) {
        toast(error.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Wyślij link logowania';
        return;
      }
      renderLogin('Link logowania został wysłany. Otwórz wiadomość na tym urządzeniu i kliknij link.', 'admin');
    });
  }

  function roleLabel(role) {`
    );

    source = source.replace(
      "${esc(member.login_email || 'brak e-maila')} · ${rate ? fmtMoney(rate.hourly_rate) + '/h' : 'brak stawki'}",
      "${esc(member.employee_login ? 'login: ' + member.employee_login : 'brak loginu')} · ${rate ? fmtMoney(rate.hourly_rate) + '/h' : 'brak stawki'}"
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

  function openRate(memberId) {`
    );

    return source;
  }

  Promise.all(parts.map(p => fetch(p, { cache: 'no-store' }).then(r => {
    if (!r.ok) throw new Error(`Nie udało się pobrać ${p}`);
    return r.text();
  }))).then(chunks => {
    const source = patchEmployeeAuth(chunks.join(''));
    (0, eval)(source);
  }).catch(err => {
    console.error(err);
    document.getElementById('app').innerHTML = '<div class="shell"><div class="card notice-error">Nie udało się uruchomić aplikacji.</div></div>';
  });
})();
