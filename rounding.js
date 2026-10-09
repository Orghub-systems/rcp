(() => {
  'use strict';

  const originalFetch = window.fetch.bind(window);
  let warned = false;

  window.fetch = async function(input, init) {
    const response = await originalFetch(input, init);

    let url = '';
    try {
      url = typeof input === 'string' ? input : (input?.url || '');
    } catch (_) {}

    if (!/app\.part01\.txt(?:$|[?#])/.test(url) || !response.ok) return response;

    const source = await response.clone().text();
    const pattern = /const durationMinutes = \(start, end = Date\.now\(\)\) => Math\.max\(0, Math\.floor\(\(new Date\(end\)\.getTime\(\) - new Date\(start\)\.getTime\(\)\) \/ 60000\)\);/;

    const patched = source.replace(pattern, `const durationMinutes = (start, end = Date.now()) => {
    const rawMinutes = Math.max(0, Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 60000));
    return Math.floor(rawMinutes / 15) * 15;
  };`);

    if (patched === source) {
      if (!warned) {
        warned = true;
        console.warn('RCP rounding: nie znaleziono funkcji durationMinutes do podmiany.');
      }
      return response;
    }

    return new Response(patched, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };
})();
