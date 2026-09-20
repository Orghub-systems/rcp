(() => {
  'use strict';

  const ROOT = '__rcp_root__';
  const GUARD = '__rcp_guard__';
  let lastRootBackAt = 0;
  let exiting = false;

  function stateWith(marker) {
    return { ...(history.state || {}), [ROOT]: marker === ROOT, [GUARD]: marker === GUARD };
  }

  function ensureGuard() {
    if (history.state?.[GUARD]) return;
    history.pushState(stateWith(GUARD), '', location.href);
  }

  function initHistory() {
    if (history.state?.[GUARD]) return;
    if (history.state?.[ROOT]) {
      ensureGuard();
      return;
    }
    history.replaceState(stateWith(ROOT), '', location.href);
    ensureGuard();
  }

  function hint(message) {
    let el = document.getElementById('rcpBackHint');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rcpBackHint';
      el.style.position = 'fixed';
      el.style.left = '50%';
      el.style.bottom = '22px';
      el.style.transform = 'translateX(-50%)';
      el.style.zIndex = '3000';
      el.style.maxWidth = '90vw';
      el.style.padding = '10px 14px';
      el.style.borderRadius = '12px';
      el.style.background = 'rgba(17,24,39,.94)';
      el.style.color = '#fff';
      el.style.fontSize = '13px';
      el.style.fontWeight = '750';
      el.style.textAlign = 'center';
      el.style.boxShadow = '0 10px 28px rgba(0,0,0,.28)';
      document.body.appendChild(el);
    }
    el.textContent = message;
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.remove(), 1900);
  }

  function clickOne(selector) {
    const el = document.querySelector(selector);
    if (!el) return false;
    el.click();
    return true;
  }

  function handleInternalBack() {
    // Najpierw najbardziej zagnieżdżone okna.
    if (document.getElementById('rcpAddSettlementDialog')) {
      return clickOne('#rcpAddSettlementDialog [data-cancel]');
    }

    if (document.getElementById('rcpStatsDayDialog')) {
      return clickOne('#rcpStatsDayDialog [data-day-close]');
    }

    if (document.getElementById('rcpVacationDialog')) {
      return clickOne('#rcpVacationDialog [data-vacation-cancel]');
    }

    // Komentarz po zakończeniu pracy jest wymagany — cofnięcie go nie omija.
    if (document.getElementById('rcpEndComment')) {
      hint('Najpierw wyślij komentarz po zakończeniu pracy.');
      return true;
    }

    // Pozostałe standardowe dialogi aplikacji.
    const genericDialog = [...document.querySelectorAll('.dialog-backdrop')]
      .reverse()
      .find(el => el.offsetParent !== null);
    if (genericDialog) {
      const cancel = genericDialog.querySelector('[data-cancel], [data-day-close], [data-vacation-cancel]');
      if (cancel) {
        cancel.click();
        return true;
      }
    }

    // Rozliczenie: szczegóły pracownika -> lista -> pulpit.
    if (document.getElementById('rcpSettlementScreen')) {
      if (clickOne('#rcpSettlementScreen [data-settlement-list-back]')) return true;
      if (clickOne('#rcpSettlementScreen [data-settlement-close]')) return true;
    }

    // Statystyki: dzień -> miesiąc jest obsłużony wyżej, dalej miesiąc -> miesiące -> pulpit.
    if (document.getElementById('rcpStatsScreen')) {
      if (clickOne('#rcpStatsScreen [data-stats-back="months"]')) return true;
      if (clickOne('#rcpStatsScreen [data-stats-back="close"]')) return true;
    }

    // Panel admina: z Zespołu/Czasu pracy wracamy na Pulpit zamiast wychodzić z aplikacji.
    const activeTab = document.querySelector('.tab.active[data-tab]');
    if (activeTab && activeTab.dataset.tab && activeTab.dataset.tab !== 'dashboard') {
      const dashboard = document.querySelector('.tab[data-tab="dashboard"]');
      if (dashboard) {
        dashboard.click();
        return true;
      }
    }

    return false;
  }

  window.addEventListener('popstate', () => {
    if (exiting) return;

    if (handleInternalBack()) {
      setTimeout(ensureGuard, 0);
      return;
    }

    const now = Date.now();
    if (now - lastRootBackAt < 1800) {
      exiting = true;
      lastRootBackAt = 0;
      // Drugi szybki Wstecz: pozwalamy systemowi zamknąć PWA / wrócić do poprzedniej aplikacji.
      setTimeout(() => history.back(), 0);
      return;
    }

    lastRootBackAt = now;
    hint('Naciśnij Wstecz ponownie, aby zamknąć RCP.');
    setTimeout(ensureGuard, 0);
  });

  window.addEventListener('pageshow', () => {
    exiting = false;
    setTimeout(initHistory, 0);
  });

  initHistory();
})();