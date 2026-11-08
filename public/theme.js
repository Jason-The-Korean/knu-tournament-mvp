(() => {
  const key = 'knu-arena-theme-v1', media = matchMedia('(prefers-color-scheme: dark)');
  let stored;
  try { stored = localStorage.getItem(key); } catch { /* OS preference remains usable. */ }
  let explicit = ['light', 'dark'].includes(stored);
  function apply(theme) { document.documentElement.dataset.theme = theme; window.dispatchEvent(new Event('arena-theme-change')); }
  apply(explicit ? stored : media.matches ? 'dark' : 'light');
  media.addEventListener('change', event => { if (!explicit) apply(event.matches ? 'dark' : 'light'); });
  window.addEventListener('storage', event => { if (event.key === key) { explicit = ['light', 'dark'].includes(event.newValue); apply(explicit ? event.newValue : media.matches ? 'dark' : 'light'); } });
  window.arenaTheme = Object.freeze({
    get: () => document.documentElement.dataset.theme,
    set(theme) {
      if (!['light', 'dark'].includes(theme)) return false;
      explicit = true; apply(theme);
      try { localStorage.setItem(key, theme); return true; } catch { return false; }
    },
  });
})();
