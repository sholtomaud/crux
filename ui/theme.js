/**
 * ui/theme.js — theme resolution, applied before first paint.
 *
 * Loaded synchronously from <head> on every page, ahead of any body content, so
 * an explicit choice is stamped on <html> before the browser paints. Deferring
 * this to app.js (which loads at the end of <body>) would flash the wrong theme
 * for anyone whose choice differs from their OS setting — and graph.html does
 * not load app.js at all.
 *
 * Three states, stored under 'crux-theme':
 *   'system' (default) — no attribute; tokens.css resolves via prefers-color-scheme
 *   'light' / 'dark'   — data-theme on <html>, which beats the OS setting
 *
 * No colour literals live here. theme-color is mirrored from the resolved
 * --color-bg so the palette stays owned by tokens.css alone.
 */
(function () {
  const KEY   = 'crux-theme';
  const ORDER = ['system', 'light', 'dark'];

  const ICONS = {
    system: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    light:  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    dark:   '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z"/>',
  };
  const LABEL = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  /** Reads the stored choice, tolerating disabled/blocked storage. */
  function get() {
    try {
      const v = localStorage.getItem(KEY);
      return ORDER.includes(v) ? v : 'system';
    } catch {
      return 'system';
    }
  }

  /** The theme actually in force once 'system' is resolved against the OS. */
  function resolved(theme = get()) {
    return theme === 'system' ? (darkQuery.matches ? 'dark' : 'light') : theme;
  }

  /**
   * Mirrors the resolved background into <meta name="theme-color">, which styles
   * the PWA's browser chrome. It is an HTML attribute and cannot hold a var(),
   * so it is read back from the cascade rather than hardcoded. This script is
   * placed after the tokens.css <link>, so the stylesheet has applied by now.
   */
  function syncMetaColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim();
    if (bg) meta.setAttribute('content', bg);
  }

  function apply(theme) {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    syncMetaColor();
    for (const btn of document.querySelectorAll('[data-theme-toggle]')) paint(btn, theme);
  }

  function set(theme) {
    if (!ORDER.includes(theme)) return;
    try { localStorage.setItem(KEY, theme); } catch { /* storage blocked — session-only */ }
    apply(theme);
  }

  function cycle() {
    set(ORDER[(ORDER.indexOf(get()) + 1) % ORDER.length]);
  }

  function paint(btn, theme = get()) {
    const shown = theme === 'system' ? 'system' : theme;
    btn.innerHTML =
      `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
      ` stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[shown]}</svg>`;
    const label = theme === 'system' ? `${LABEL.system} (${resolved(theme)})` : LABEL[theme];
    btn.title = `${label} — click to change`;
    btn.setAttribute('aria-label', label);
  }

  /** Creates a toggle button and appends it to `container`. */
  function mountToggle(container, className = 'theme-toggle') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute('data-theme-toggle', '');
    btn.addEventListener('click', cycle);
    paint(btn);
    container.appendChild(btn);
    return btn;
  }

  // Stamp the attribute immediately — this is the whole point of loading in <head>.
  const initial = get();
  if (initial !== 'system') document.documentElement.setAttribute('data-theme', initial);

  // The stylesheet is not guaranteed applied at parse time in every browser, so
  // the meta mirror runs once the document is ready as well as right now.
  syncMetaColor();
  document.addEventListener('DOMContentLoaded', () => { syncMetaColor(); });

  // Following the OS only matters while the user has not chosen explicitly.
  darkQuery.addEventListener('change', () => {
    if (get() === 'system') apply('system');
  });

  window.cruxTheme = { get, set, cycle, resolved, mountToggle };
})();
