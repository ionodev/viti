// The theme (light, dark, or as Windows is set) and the accent colour: put on the page before it draws
// (this file is loaded in <head>, so there is no flash), and again whenever they change. The choice is
// kept by the app (/app/prefs) and remembered here too, so it is known at once.
(function () {
  const KEY = 'viti.prefs';
  const dark = matchMedia('(prefers-color-scheme: dark)');
  let prefs = { theme: 'system', accent: '#6d5efc' };
  try {
    prefs = { ...prefs, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {}

  // black or white, whichever reads better on the accent
  const inkOn = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#111318' : '#ffffff';
  };
  function apply(p) {
    prefs = { ...prefs, ...p };
    const root = document.documentElement;
    root.dataset.theme = prefs.theme === 'system' ? (dark.matches ? 'dark' : 'light') : prefs.theme;
    if (/^#[0-9a-f]{6}$/i.test(prefs.accent)) {
      root.style.setProperty('--accent', prefs.accent);
      root.style.setProperty('--accent-ink', inkOn(prefs.accent));
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {}
  }
  dark.addEventListener('change', () => prefs.theme === 'system' && apply({}));
  apply({});
  // what the app keeps wins (another window may have changed it)
  fetch('/app/state', { headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => s?.prefs && apply(s.prefs))
    .catch(() => {});
  window.vitiTheme = {
    get: () => ({ ...prefs }),
    // change and keep
    set(p) {
      apply(p);
      return fetch('/app/prefs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(prefs) }).catch(() => {});
    },
    // seen at once, not kept yet (while a colour is being dragged)
    preview: (p) => apply(p),
    ACCENTS: ['#6d5efc', '#2f6fe4', '#0ea5a4', '#16a34a', '#e8a317', '#ea580c', '#e11d48', '#c026d3', '#64748b'],
  };
})();
