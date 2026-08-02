// ui/app.js — shared app shell, design tokens, icons, and utilities

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

// ── Icons — hand-rolled inline SVG, no icon font / CDN (ADR-005) ───────────────
const ICON_PATHS = {
  dashboard:      '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  settings:       '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  monitoring:     '<polyline points="3,17 9,10 13,14 21,5"/>',
  database:       '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  folder:         '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  add:            '<path d="M12 5v14M5 12h14"/>',
  warning:        '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  trending_down:  '<polyline points="3,7 11,15 15,11 21,17"/><polyline points="15,17 21,17 21,11"/>',
  bar_chart:      '<rect x="4" y="12" width="4" height="8"/><rect x="10" y="7" width="4" height="13"/><rect x="16" y="3" width="4" height="17"/>',
  smart_toy:      '<rect x="5" y="8" width="14" height="11" rx="2"/><circle cx="9" cy="13" r="1.3"/><circle cx="15" cy="13" r="1.3"/><path d="M12 8V4M9 4h6"/>',
  person:         '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
  psychology:     '<path d="M12 3a5 5 0 0 0-5 5v1a4 4 0 0 0 0 8h1v3h8v-3h1a4 4 0 0 0 0-8V8a5 5 0 0 0-5-5z"/><path d="M12 3v14"/>',
  check:          '<polyline points="4,13 9,18 20,6"/>',
  filter_list:    '<path d="M4 6h16M7 12h10M10 18h4"/>',
  search:         '<circle cx="10" cy="10" r="6"/><path d="M21 21l-5.2-5.2"/>',
  chevron_right:  '<polyline points="9,5 16,12 9,19"/>',
  send:           '<path d="M3 12l18-8-8 18-2-8z"/>',
  zoom_in:        '<circle cx="10" cy="10" r="6"/><path d="M10 7v6M7 10h6M21 21l-5.2-5.2"/>',
  zoom_out:       '<circle cx="10" cy="10" r="6"/><path d="M7 10h6M21 21l-5.2-5.2"/>',
  route:          '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M5 8v3a3 3 0 0 0 3 3h8a3 3 0 0 1 3 3" stroke-dasharray="3 2"/>',
  stop_circle:    '<circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6"/>',
  account_circle: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6 19c0-2.8 2.7-5 6-5s6 2.2 6 5"/>',
  notifications:  '<path d="M6 10a6 6 0 0 1 12 0v4l2 3H4l2-3z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  close:          '<path d="M6 6l12 12M18 6L6 18"/>',
};

function icon(name, size = 18) {
  const body = ICON_PATHS[name] ?? ICON_PATHS.warning;
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

// ── Sidebar shell (persistent LHS nav + project switcher) ──────────────────────
// Replaces the old top-nav renderNav(). Returns the fetched project list (or null
// on error) so pages that need it (e.g. the Portfolio page) can reuse it instead
// of re-fetching /api/overview a second time.
async function renderSidebar(activePage, activeProjectId = null) {
  const aside = document.createElement('aside');
  aside.id = 'app-sidebar';
  aside.innerHTML = `
    <div class="sidebar-brand">
      <span class="brand-mark">crux</span>
    </div>
    <nav class="sidebar-nav">
      <a href="/" class="sidebar-link ${activePage === 'portfolio' ? 'active' : ''}">${icon('dashboard')}<span>Portfolio</span></a>
      <a href="/roi" class="sidebar-link ${activePage === 'roi' ? 'active' : ''}">${icon('monitoring')}<span>ROI</span></a>
      <a href="/db" class="sidebar-link ${activePage === 'db' ? 'active' : ''}">${icon('database')}<span>DB</span></a>
    </nav>
    <div class="sidebar-section-label">Active Projects</div>
    <nav class="sidebar-projects" id="sidebar-projects"><p class="sidebar-loading">Loading…</p></nav>
    <button id="btn-install" class="btn-install" hidden
      onclick="(async()=>{if(!_installPrompt)return;await _installPrompt.prompt();_installPrompt=null;this.hidden=true;})()">
      Install App
    </button>
  `;
  document.body.prepend(aside);

  const listEl = document.getElementById('sidebar-projects');
  try {
    const projects = await fetchJson('/api/overview');
    const active = projects.filter(p => p.status === 'active');
    listEl.innerHTML = active.length
      ? active.map(p => `
          <a href="/project?id=${p.id}" class="sidebar-project-link ${p.id === activeProjectId ? 'active' : ''}">
            <span class="sidebar-project-name">${p.name}</span>
          </a>
        `).join('')
      : '<p class="sidebar-loading">No active projects</p>';
    return projects;
  } catch (e) {
    listEl.innerHTML = '<p class="sidebar-loading">Error loading projects</p>';
    return null;
  }
}

// ── Agent panel (RHS) — scaffolding only, no backend wired up yet ──────────────
// The status dot, empty state, and disabled input all deliberately communicate
// "not connected" rather than presenting a chat box that would silently swallow
// a real message. Wiring this up to crux_ask is a later phase.
function renderAgentPanel() {
  const open = localStorage.getItem('crux-agent-panel-open') === 'true';
  document.body.classList.toggle('agent-panel-open', open);
  document.body.classList.toggle('agent-panel-collapsed', !open);

  const aside = document.createElement('aside');
  aside.id = 'agent-panel';
  aside.innerHTML = `
    <div class="agent-panel-header">
      <div class="agent-panel-title">${icon('smart_toy', 18)}<span>Crux Agent</span></div>
      <div class="agent-status"><span class="agent-status-dot"></span>Not connected</div>
    </div>
    <div class="agent-panel-messages" id="agent-panel-messages">
      <p class="agent-panel-empty">Agent chat isn't wired up yet. This panel will let you talk to a routed agent (local LLM or Claude) about your tasks — coming in a later phase.</p>
    </div>
    <div class="agent-panel-input-row">
      <input type="text" class="agent-panel-input" placeholder="Agent chat — coming soon" disabled title="Agent chat isn't wired up yet">
      <button class="agent-panel-send" disabled title="Agent chat isn't wired up yet">${icon('send', 16)}</button>
    </div>
  `;
  document.body.appendChild(aside);

  const toggle = document.createElement('button');
  toggle.id = 'agent-panel-toggle';
  toggle.className = open ? '' : 'collapsed';
  toggle.title = open ? 'Collapse agent panel' : 'Expand agent panel';
  toggle.innerHTML = icon('chevron_right', 16);
  toggle.onclick = () => {
    const nowOpen = !document.body.classList.contains('agent-panel-open');
    document.body.classList.toggle('agent-panel-open', nowOpen);
    document.body.classList.toggle('agent-panel-collapsed', !nowOpen);
    localStorage.setItem('crux-agent-panel-open', String(nowOpen));
    toggle.className = nowOpen ? '' : 'collapsed';
    toggle.title = nowOpen ? 'Collapse agent panel' : 'Expand agent panel';
  };
  document.body.appendChild(toggle);
}

// ── Design tokens + shared CSS injected once ────────────────────────────────────
(function injectSharedStyles() {
  const s = document.createElement('style');
  s.textContent = `
    :root {
      --color-bg: #0f0f0f;
      --color-surface: #141414;
      --color-surface-container: #1a1a1a;
      --color-surface-container-high: #202020;
      --color-surface-container-highest: #2a2a2a;
      --color-border: #242424;
      --color-border-strong: #333;
      --color-text: #e0e0e0;
      --color-text-bright: #fff;
      --color-text-dim: #666;
      --color-text-dimmer: #555;
      --color-primary: #34d399;
      --color-secondary: #60a5fa;
      --color-danger: #f87171;
      --color-warning: #f59e0b;
      --color-executor-llm: #22d3ee;
      --color-executor-human: #c084fc;
      --color-executor-hybrid: #f472b6;
      --color-executor-auto: #777;
      --radius: 8px;
      --radius-sm: 4px;
      --space-card-padding: 0.85rem;
      --space-section-gap: 1.5rem;
      --space-gutter-md: 1.25rem;
      --sidebar-width: 240px;
      --agent-panel-width: 340px;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { min-height: 100%; }
    body {
      font-family: system-ui, monospace;
      background: var(--color-bg);
      color: var(--color-text);
      display: grid;
      grid-template-columns: var(--sidebar-width) 1fr;
      grid-template-rows: 100vh;
    }
    body.agent-panel-open { grid-template-columns: var(--sidebar-width) 1fr var(--agent-panel-width); }
    a { color: var(--color-secondary); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* ── Sidebar ── */
    #app-sidebar {
      grid-column: 1; grid-row: 1;
      background: #131313; border-right: 1px solid var(--color-border);
      display: flex; flex-direction: column; overflow-y: auto;
    }
    .sidebar-brand { padding: 1.1rem 1.25rem 0.9rem; }
    .brand-mark {
      font-weight: 900; font-size: 1.1rem; letter-spacing: -0.03em;
      color: var(--color-primary);
    }
    .sidebar-nav { display: flex; flex-direction: column; gap: 0.15rem; padding: 0 0.6rem; }
    .sidebar-link {
      display: flex; align-items: center; gap: 0.65rem;
      padding: 0.5rem 0.7rem; border-radius: var(--radius-sm);
      color: var(--color-text-dim); font-size: 0.78rem; font-weight: 600;
      letter-spacing: 0.04em; text-transform: uppercase;
    }
    .sidebar-link:hover { color: var(--color-text); background: var(--color-surface-container); text-decoration: none; }
    .sidebar-link.active { color: var(--color-primary); background: var(--color-surface-container-high); }
    .sidebar-section-label {
      margin: 1.4rem 0 0.5rem; padding: 0 1.1rem;
      font-size: 0.68rem; font-weight: 600; letter-spacing: 0.1em;
      text-transform: uppercase; color: var(--color-text-dimmer);
    }
    .sidebar-projects { display: flex; flex-direction: column; gap: 0.1rem; padding: 0 0.6rem; flex: 1; }
    .sidebar-project-link {
      padding: 0.4rem 0.7rem; border-radius: var(--radius-sm);
      border-left: 2px solid transparent;
      color: var(--color-text-dim); font-size: 0.8rem;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sidebar-project-link:hover { color: var(--color-text); text-decoration: none; }
    .sidebar-project-link.active { color: var(--color-primary); border-left-color: var(--color-primary); }
    .sidebar-loading { padding: 0.4rem 1.1rem; font-size: 0.78rem; color: var(--color-text-dimmer); }
    .btn-install {
      margin: 0.75rem; font-size: 0.75rem; font-family: inherit; cursor: pointer;
      background: #1a3a2a; color: var(--color-primary); border: 1px solid var(--color-primary);
      padding: 0.4rem 0.85rem; border-radius: var(--radius-sm); transition: all 0.15s;
    }
    .btn-install:hover { background: var(--color-primary); color: #000; }

    /* ── Main content area (each page fills grid-column: 2) ── */
    #app-main { grid-column: 2; grid-row: 1; overflow-y: auto; padding: var(--space-gutter-md) 2rem; }

    /* ── Agent panel (RHS) ── */
    #agent-panel {
      grid-column: 3; grid-row: 1;
      background: var(--color-surface-container); border-left: 1px solid var(--color-border);
      display: flex; flex-direction: column; overflow: hidden;
    }
    body.agent-panel-collapsed #agent-panel { display: none; }
    .agent-panel-header { padding: 1rem; border-bottom: 1px solid var(--color-border); display: flex; justify-content: space-between; align-items: center; }
    .agent-panel-title { display: flex; align-items: center; gap: 0.5rem; font-weight: 700; color: var(--color-text-bright); font-size: 0.9rem; }
    .agent-status { display: flex; align-items: center; gap: 0.4rem; font-size: 0.68rem; color: var(--color-text-dim); }
    .agent-status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-text-dimmer); }
    .agent-panel-messages { flex: 1; overflow-y: auto; padding: 1rem; }
    .agent-panel-empty { font-size: 0.82rem; color: var(--color-text-dim); line-height: 1.6; }
    .agent-panel-input-row { padding: 0.75rem; border-top: 1px solid var(--color-border); display: flex; gap: 0.5rem; }
    .agent-panel-input {
      flex: 1; font: inherit; font-size: 0.82rem; background: var(--color-surface-container-high); color: var(--color-text-dimmer);
      border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); padding: 0.5em 0.75em; cursor: not-allowed;
    }
    .agent-panel-send {
      background: var(--color-surface-container-high); color: var(--color-text-dimmer); border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-sm); width: 34px; cursor: not-allowed; display: flex; align-items: center; justify-content: center;
    }
    #agent-panel-toggle {
      position: fixed; top: 50%; right: var(--agent-panel-width); transform: translateY(-50%);
      z-index: 200; width: 26px; height: 44px; border-radius: 6px 0 0 6px;
      background: var(--color-surface-container-high); border: 1px solid var(--color-border-strong); border-right: none;
      color: var(--color-text-dim); cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: right 0.15s;
    }
    #agent-panel-toggle:hover { color: var(--color-text); }
    #agent-panel-toggle.collapsed { right: 0; }
    #agent-panel-toggle.collapsed .icon { transform: rotate(180deg); }

    /* ── Icon ── */
    .icon { display: inline-block; vertical-align: middle; flex-shrink: 0; }

    /* ── Badges (status + executor) ── */
    .badge { font-size: 0.7rem; padding: 0.15em 0.5em; border-radius: var(--radius-sm); font-weight: 600; }
    .badge-open       { background: #1e3a5f; color: var(--color-secondary); }
    .badge-inprogress { background: #3a2e1a; color: var(--color-warning); }
    .badge-blocked    { background: #3a1a1a; color: var(--color-danger); }
    .badge-done       { background: #1a3a2a; color: var(--color-primary); }
    .badge-dropped    { background: #2a2a2a; color: #888; }
    .badge-llm        { background: #123a3a; color: var(--color-executor-llm); }
    .badge-human      { background: #2a1a3a; color: var(--color-executor-human); }
    .badge-hybrid     { background: #3a1a2e; color: var(--color-executor-hybrid); }
    .badge-auto       { background: #242424; color: var(--color-executor-auto); }

    /* ── Buttons / inputs (shared primitives) ── */
    .filter-btn { font: inherit; font-size: 0.78rem; background: var(--color-surface-container); color: #aaa;
                  border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); padding: 0.35em 0.9em; cursor: pointer; }
    .filter-btn:hover { color: var(--color-text); background: var(--color-surface-container-high); }
    .filter-btn.active { background: var(--color-surface-container-highest); color: var(--color-text-bright); border-color: #555; }
    .search-input, .status-select {
      font: inherit; font-size: 0.82rem; background: var(--color-surface-container); color: var(--color-text);
      border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); padding: 0.45em 0.8em;
    }
    .search-input::placeholder { color: var(--color-text-dimmer); }

    /* ── Tables (shared base) ── */
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    th { text-align: left; color: #888; font-weight: 600; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--color-border); }
    td { padding: 0.4rem 0.6rem; border-bottom: 1px solid #1e1e1e; }

    /* ── Cards / stats / progress ── */
    .card { background: var(--color-surface-container); border: 1px solid var(--color-border);
            border-radius: var(--radius); padding: var(--space-card-padding); }
    .stat { background: var(--color-surface-container); border-radius: var(--radius); padding: 0.75rem 1rem; }
    .stat-value { font-size: 1.4rem; font-weight: 700; color: var(--color-text-bright); }
    .stat-label { font-size: 0.72rem; color: var(--color-text-dim); margin-top: 0.2rem; }
    .progress-bar-wrap { background: #2a2a2a; border-radius: 3px; height: 4px; }
    .progress-bar-fill { background: var(--color-primary); height: 100%; border-radius: 3px; transition: width 0.4s; }
    .loading { color: var(--color-text-dim); font-size: 0.85rem; padding: 2rem 0; }
    .error { color: var(--color-danger); font-size: 0.85rem; }
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

function executorBadge(executor) {
  const map = {
    'llm':    { label: 'llm',    cls: 'badge-llm' },
    'human':  { label: 'human',  cls: 'badge-human' },
    'hybrid': { label: 'hybrid', cls: 'badge-hybrid' },
    'auto':   { label: 'auto',   cls: 'badge-auto' },
  };
  const b = map[executor] ?? { label: executor, cls: '' };
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
      <span style="font-size:0.7rem;color:var(--color-text-dim);flex-shrink:0">${done}/${total}</span>
    </div>`;
}
