// ui/app.js — shared app shell, utilities, and navigation

// ── PWA install prompt ────────────────────────────────────────────────────────
let _installPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _installPrompt = e;
  document.getElementById('btn-install')?.removeAttribute('hidden');
});
window.addEventListener('appinstalled', () => {
  document.getElementById('btn-install')?.setAttribute('hidden', '');
  _installPrompt = null;
});

// ── Navigation shell ──────────────────────────────────────────────────────────
function renderNav(active) {
  const links = [
    { href: '/',     label: 'Overview', key: 'overview' },
    { href: '/roi',  label: 'ROI',      key: 'roi' },
    { href: '/db',   label: 'DB',       key: 'db' },
  ];
  const nav = document.createElement('nav');
  nav.id = 'app-nav';
  nav.innerHTML = `
    <a href="/" class="nav-brand">crux</a>
    <div class="nav-links">
      ${links.map(l => `
        <a href="${l.href}" class="nav-link${l.key === active ? ' active' : ''}">${l.label}</a>
      `).join('')}
    </div>
    <button id="btn-install" class="btn-install" hidden
      onclick="(async()=>{if(!_installPrompt)return;await _installPrompt.prompt();_installPrompt=null;this.hidden=true;})()">
      Install App
    </button>
  `;
  document.body.prepend(nav);
  // Push content below fixed nav
  document.body.style.paddingTop = nav.offsetHeight + 'px';
}

// ── Shared CSS injected once ──────────────────────────────────────────────────
(function injectSharedStyles() {
  const s = document.createElement('style');
  s.textContent = `
    #app-nav {
      position: fixed; top: 0; left: 0; right: 0; z-index: 100;
      display: flex; align-items: center; gap: 1rem;
      background: #111; border-bottom: 1px solid #222;
      padding: 0 1.5rem; height: 48px;
    }
    .nav-brand {
      font-family: system-ui, monospace; font-weight: 700; font-size: 1rem;
      color: #34d399; text-decoration: none; letter-spacing: 0.05em; flex-shrink: 0;
    }
    .nav-links { display: flex; gap: 0.25rem; flex: 1; }
    .nav-link {
      font-size: 0.82rem; color: #888; text-decoration: none;
      padding: 0.3rem 0.75rem; border-radius: 6px; transition: all 0.15s;
    }
    .nav-link:hover { color: #e0e0e0; background: #1e1e1e; }
    .nav-link.active { color: #fff; background: #1e1e1e; }
    .btn-install {
      font-size: 0.75rem; font-family: inherit; cursor: pointer;
      background: #1a3a2a; color: #34d399; border: 1px solid #34d399;
      padding: 0.3rem 0.85rem; border-radius: 6px; transition: all 0.15s; flex-shrink: 0;
    }
    .btn-install:hover { background: #34d399; color: #000; }
    .back-link {
      display: inline-flex; align-items: center; gap: 0.4rem;
      font-size: 0.82rem; color: #888; text-decoration: none;
      margin-bottom: 1.5rem; transition: color 0.15s;
    }
    .back-link:hover { color: #e0e0e0; }
  `;
  document.head.appendChild(s);
})();

// ── Data helpers ──────────────────────────────────────────────────────────────
async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `${path}: ${res.status}`);
  return data;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
function statusBadge(status) {
  const map = {
    'open':        { label: 'open',        cls: 'badge-open' },
    'in-progress': { label: 'in progress', cls: 'badge-inprogress' },
    'blocked':     { label: 'blocked',     cls: 'badge-blocked' },
    'done':        { label: 'done',        cls: 'badge-done' },
    'dropped':     { label: 'dropped',     cls: 'badge-dropped' },
    'active':      { label: 'active',      cls: 'badge-open' },
    'stalled':     { label: 'stalled',     cls: 'badge-blocked' },
    'paused':      { label: 'paused',      cls: 'badge-dropped' },
  };
  const b = map[status] ?? { label: status, cls: '' };
  return `<span class="badge ${b.cls}">${b.label}</span>`;
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') e.className = v;
    else if (k === 'innerHTML') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (typeof child === 'string') e.appendChild(document.createTextNode(child));
    else if (child) e.appendChild(child);
  }
  return e;
}

function progressBar(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return `
    <div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.6rem;">
      <div class="progress-bar-wrap" style="flex:1">
        <div class="progress-bar-fill" style="width:${pct}%"></div>
      </div>
      <span style="font-size:0.7rem;color:#666;flex-shrink:0">${done}/${total}</span>
    </div>`;
}
