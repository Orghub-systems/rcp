(() => {
  const parts = [
    './app.part01.txt',
    './app.part02.txt',
    './app.part03.txt',
    './app.part04.txt'
  ];

  Promise.all(parts.map(p => fetch(p, { cache: 'no-store' }).then(r => {
    if (!r.ok) throw new Error(`Nie udało się pobrać ${p}`);
    return r.text();
  }))).then(chunks => {
    (0, eval)(chunks.join(''));
  }).catch(err => {
    console.error(err);
    document.getElementById('app').innerHTML = '<div class="shell"><div class="card notice-error">Nie udało się uruchomić aplikacji.</div></div>';
  });
})();
