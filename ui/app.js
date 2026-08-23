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
  push_pin:       '<path d="M9 3h6l-1 6 4 3v2H6v-2l4-3z"/><path d="M12 14v7"/>',
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
    <div class="sidebar-footer" id="sidebar-footer"></div>
    <button id="btn-install" class="btn-install" hidden
      onclick="(async()=>{if(!_installPrompt)return;await _installPrompt.prompt();_installPrompt=null;this.hidden=true;})()">
      Install App
    </button>
  `;
  document.body.prepend(aside);

  // theme.js owns the button so graph.html — which never loads app.js — can
  // mount the identical control from its own nav.
  window.cruxTheme?.mountToggle(document.getElementById('sidebar-footer'), 'theme-toggle');

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

// ── Task detail panel (RHS) ───────────────────────────────────────────────────
// One editable task form, shared by the CPM graph and the project Kanban board,
// so there is a single task editor in the product rather than one per view.
//
// Pinned it takes a grid column and the page reflows beside it; unpinned it
// overlays the RHS and dismisses on Escape or an outside click. Both the pin
// state and the fact that only one RHS panel may hold the column at a time are
// resolved here, not by the callers.

const TASK_STATUSES  = ['todo', 'in-progress', 'blocked', 'done', 'dropped'];
const TASK_TYPES     = ['coding', 'writing', 'research', 'accounting', 'verification', 'design', 'other'];
const TASK_EXECUTORS = ['llm', 'human', 'hybrid', 'auto'];

const PANEL_FIELDS = [
  { key: 'title',               label: 'Title',               type: 'text' },
  { key: 'status',              label: 'Status',              type: 'select', options: TASK_STATUSES },
  { key: 'phase',               label: 'Phase',               type: 'text' },
  { key: 'executor',            label: 'Executor',            type: 'select', options: TASK_EXECUTORS },
  { key: 'task_type',           label: 'Type',                type: 'select', options: TASK_TYPES },
  { key: 'priority',            label: 'Priority',            type: 'number', step: '1',    min: '0', max: '100' },
  { key: 'duration_days',       label: 'Duration (days)',     type: 'number', step: '0.25', min: '0' },
  { key: 'value_score',         label: 'Value score',         type: 'number', step: '1',    min: '0', max: '100' },
  { key: 'description',         label: 'Description',         type: 'textarea' },
  { key: 'acceptance_criteria', label: 'Acceptance criteria', type: 'textarea' },
];
const NUMERIC_FIELDS = new Set(['priority', 'duration_days', 'value_score']);

let _panelCtx = null;
let _panelHideTimer = null;

const panelPinned = () => localStorage.getItem('crux-task-panel-pinned') === 'true';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Mounts the panel shell once. Safe to call on every page load. */
function renderTaskPanel() {
  if (document.getElementById('task-panel')) return;

  const aside = document.createElement('aside');
  aside.id = 'task-panel';
  aside.hidden = true;
  aside.innerHTML = `
    <div class="task-panel-header">
      <code class="task-panel-slug" id="task-panel-slug"></code>
      <div class="task-panel-actions">
        <button class="task-panel-icon-btn" id="task-panel-pin"></button>
        <button class="task-panel-icon-btn" id="task-panel-close" title="Close" aria-label="Close">${icon('close', 16)}</button>
      </div>
    </div>
    <div class="task-panel-body" id="task-panel-body"></div>
    <div class="task-panel-footer">
      <span class="task-panel-msg" id="task-panel-msg"></span>
      <button class="task-panel-save" id="task-panel-save" disabled>Save</button>
    </div>
  `;
  document.body.appendChild(aside);

  document.getElementById('task-panel-close').onclick = () => closeTaskPanel();
  document.getElementById('task-panel-pin').onclick   = () => setPanelPinned(!panelPinned());
  document.getElementById('task-panel-save').onclick  = saveTaskPanel;

  // Escape closes only the overlay form. Pinned, the panel is page furniture
  // rather than a dialog, so Escape belongs to the page.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _panelCtx && !panelPinned()) closeTaskPanel();
  });
  document.addEventListener('mousedown', e => {
    if (!_panelCtx || panelPinned()) return;
    if (!aside.contains(e.target) && !e.target.closest('.node, .task-card')) closeTaskPanel();
  });

  applyPanelPinClass();
}

/**
 * The agent panel and the task panel both want grid-column 3, and the shell has
 * only one. The task panel wins while pinned — it is the surface you are
 * actively working in, where the agent panel is still unwired scaffolding — and
 * the agent panel's own preference is left untouched in localStorage so
 * unpinning restores whatever the user last chose.
 */
function applyPanelPinClass() {
  const pinned = panelPinned();
  document.body.classList.toggle('task-panel-pinned', pinned && !!_panelCtx);

  if (pinned && _panelCtx) {
    document.body.classList.remove('agent-panel-open');
    document.body.classList.add('agent-panel-collapsed');
    document.getElementById('agent-panel-toggle')?.classList.add('collapsed');
  } else if (localStorage.getItem('crux-agent-panel-open') === 'true') {
    document.body.classList.add('agent-panel-open');
    document.body.classList.remove('agent-panel-collapsed');
    document.getElementById('agent-panel-toggle')?.classList.remove('collapsed');
  }

  const btn = document.getElementById('task-panel-pin');
  if (btn) {
    btn.innerHTML = icon('push_pin', 16);
    btn.classList.toggle('active', pinned);
    btn.title = pinned ? 'Unpin — let the panel slide over the page' : 'Pin — keep the panel beside the page';
    btn.setAttribute('aria-pressed', String(pinned));
  }

  const aside = document.getElementById('task-panel');
  if (aside) {
    // A pinned panel is part of the layout, not a modal, so it drops the dialog
    // semantics that would otherwise trap a screen reader inside it.
    if (pinned) { aside.removeAttribute('role'); aside.removeAttribute('aria-label'); }
    else { aside.setAttribute('role', 'dialog'); aside.setAttribute('aria-label', 'Task detail'); }
  }
}

function setPanelPinned(pinned) {
  localStorage.setItem('crux-task-panel-pinned', String(pinned));
  applyPanelPinClass();
  // The graph measures its viewport on resize; pinning changes that width
  // without firing one, so the fit has to be nudged by hand.
  window.dispatchEvent(new Event('resize'));
}

/**
 * @param projectId  project the task belongs to
 * @param task       the full task row
 * @param cpm        matching node from /api/cpm (may be undefined)
 * @param opts       { neighbours: {predecessors, successors}, onSaved }
 * @returns false only when the caller's click was cancelled at the discard prompt
 */
function openTaskPanel(projectId, task, cpm, opts = {}) {
  renderTaskPanel();

  // Clicking a different node while this one has unsaved edits is the same data
  // loss as closing on it, and has to ask the same question — otherwise the one
  // dismissal the guard does not cover is the easiest to trigger by accident.
  if (_panelCtx && _panelCtx.task.slug !== task.slug && isPanelDirty()
      && !confirm(`Discard your unsaved changes to ${_panelCtx.task.slug}?`)) return false;

  _panelCtx = { projectId, task, cpm, neighbours: opts.neighbours ?? null, onSaved: opts.onSaved ?? null };

  document.getElementById('task-panel-slug').textContent = task.slug;
  document.getElementById('task-panel-body').innerHTML = panelBodyHtml(task, cpm, _panelCtx.neighbours);
  setPanelMessage('');

  const aside = document.getElementById('task-panel');
  clearTimeout(_panelHideTimer);
  aside.hidden = false;
  requestAnimationFrame(() => aside.classList.add('open'));
  applyPanelPinClass();

  bindPanelInputs();
  refreshDirtyState();
  document.getElementById('tp-title')?.focus();
  return true;
}

function bindPanelInputs() {
  for (const f of PANEL_FIELDS) {
    document.getElementById(`tp-${f.key}`)?.addEventListener('input', refreshDirtyState);
  }
}

function closeTaskPanel() {
  if (_panelCtx && isPanelDirty() && !confirm('Discard your unsaved changes to this task?')) return;

  const aside = document.getElementById('task-panel');
  const wasPinned = panelPinned();
  _panelCtx = null;
  if (aside) {
    aside.classList.remove('open');
    // `hidden` waits out the slide-out, or the panel would vanish rather than
    // leave. Reopening cancels the timer, so a fast close-then-open does not
    // hide the panel a moment after it reappears.
    clearTimeout(_panelHideTimer);
    _panelHideTimer = setTimeout(() => { if (!_panelCtx) aside.hidden = true; }, wasPinned ? 0 : 200);
  }
  document.querySelectorAll('.tp-selected').forEach(n => n.classList.remove('tp-selected'));
  applyPanelPinClass();
  if (wasPinned) window.dispatchEvent(new Event('resize'));
}

function panelBodyHtml(task, cpm, neighbours) {
  const field = (f) => {
    const raw = task[f.key];
    const val = raw == null ? '' : String(raw);
    if (f.type === 'select') {
      return `<label class="tp-field"><span class="tp-label">${f.label}</span>
        <select class="tp-input" id="tp-${f.key}">
          ${f.options.map(o => `<option value="${o}" ${o === raw ? 'selected' : ''}>${o}</option>`).join('')}
        </select></label>`;
    }
    if (f.type === 'textarea') {
      return `<label class="tp-field tp-field-wide"><span class="tp-label">${f.label}</span>
        <textarea class="tp-input tp-textarea" id="tp-${f.key}" rows="4">${escapeHtml(val)}</textarea></label>`;
    }
    const attrs = [`type="${f.type}"`, f.step ? `step="${f.step}"` : '', f.min != null ? `min="${f.min}"` : '', f.max != null ? `max="${f.max}"` : ''].filter(Boolean).join(' ');
    return `<label class="tp-field"><span class="tp-label">${f.label}</span>
      <input class="tp-input" id="tp-${f.key}" ${attrs} value="${escapeHtml(val)}"></label>`;
  };

  const chips = (slugs) => slugs?.length
    ? slugs.map(s => `<span class="depchip">${escapeHtml(s)}</span>`).join('')
    : '<span class="tp-empty">none</span>';

  const ro = (label, value) => value == null || value === ''
    ? ''
    : `<div class="tp-ro-item"><span class="tp-label">${label}</span><span class="tp-ro-value">${value}</span></div>`;

  // Everything below the rule is computed by lib/cpm.ts from durations and the
  // dependency DAG. Rendering it as text rather than as disabled inputs is the
  // honest signal: these are not fields someone forgot to enable.
  const computed = cpm ? `
    <div class="tp-computed">
      <h3 class="tp-section">Schedule <span class="tp-section-note">computed — edit durations and dependencies to move these</span></h3>
      <div class="tp-ro-grid">
        ${ro('Early start / finish', `day ${cpm.early_start} → ${cpm.early_finish}`)}
        ${ro('Late start / finish',  `day ${cpm.late_start} → ${cpm.late_finish}`)}
        ${ro('Float',               cpm.float_days != null ? `${cpm.float_days}d` : null)}
        ${ro('Critical path',       cpm.is_critical ? '★ yes' : 'no')}
        ${ro('WSJF',                cpm.wsjf_score)}
      </div>
    </div>` : '';

  const deps = neighbours ? `
    <div class="tp-computed">
      <h3 class="tp-section">Dependencies</h3>
      <div class="tp-ro-item"><span class="tp-label">Predecessors</span><span>${chips(neighbours.predecessors)}</span></div>
      <div class="tp-ro-item"><span class="tp-label">Successors</span><span>${chips(neighbours.successors)}</span></div>
    </div>` : '';

  return `<form class="tp-form" onsubmit="event.preventDefault()">${PANEL_FIELDS.map(field).join('')}</form>${computed}${deps}`;
}

/** Reads the form back as a patch of only the values that actually differ. */
function panelPatch() {
  if (!_panelCtx) return {};
  const { task } = _panelCtx;
  const patch = {};

  for (const f of PANEL_FIELDS) {
    const input = document.getElementById(`tp-${f.key}`);
    if (!input) continue;
    const raw = input.value.trim();

    let value;
    if (NUMERIC_FIELDS.has(f.key)) value = raw === '' ? null : Number(raw);
    else value = raw === '' ? null : raw;

    const current = task[f.key] ?? null;
    if (value !== current) patch[f.key] = value;
  }
  return patch;
}

const isPanelDirty = () => Object.keys(panelPatch()).length > 0;

function refreshDirtyState() {
  const btn = document.getElementById('task-panel-save');
  if (btn) btn.disabled = !isPanelDirty();
}

function setPanelMessage(text, kind = '') {
  const el = document.getElementById('task-panel-msg');
  if (!el) return;
  el.textContent = text;
  el.className = `task-panel-msg ${kind}`;
}

async function saveTaskPanel() {
  if (!_panelCtx) return;
  const { projectId, task, onSaved } = _panelCtx;
  const patch = panelPatch();
  if (!Object.keys(patch).length) return;

  const btn = document.getElementById('task-panel-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  setPanelMessage('');

  try {
    const res = await patchJson(`/api/task/${projectId}/${task.slug}`, patch);
    // Re-seed from the server's row, never from the patch we sent, so anything
    // the server normalised (trimmed text, a cleared field) is what you see.
    _panelCtx.task = res.task;

    // The caller repaints its view and may hand back a recomputed CPM node —
    // editing a duration moves float, so redrawing the schedule block from the
    // pre-save numbers would show a figure that is already wrong.
    const freshCpm = await onSaved?.(res.task);
    if (freshCpm) _panelCtx.cpm = freshCpm;

    document.getElementById('task-panel-body').innerHTML =
      panelBodyHtml(res.task, _panelCtx.cpm, _panelCtx.neighbours);
    bindPanelInputs();
    setPanelMessage(
      res.guard_warnings?.length ? `Saved — ${res.guard_warnings.map(w => w.reason).join('; ')}` : 'Saved',
      res.guard_warnings?.length ? 'warn' : 'ok',
    );
  } catch (e) {
    // The edits stay in the form on failure: re-typing a rejected description
    // because the status transition was blocked would be genuine data loss.
    setPanelMessage(e.message, 'error');
    if (e.field) document.getElementById(`tp-${e.field}`)?.classList.add('tp-invalid');
  } finally {
    btn.textContent = 'Save';
    refreshDirtyState();
  }
}

// ── Shared component CSS injected once ─────────────────────────────────────────
// The palette itself lives in ui/tokens.css, linked by every page. Nothing here
// may hardcode a colour — a literal hex is invisible to the theme switcher.
(function injectSharedStyles() {
  const s = document.createElement('style');
  s.textContent = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { min-height: 100%; }
    body {
      font-family: var(--font-sans);
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
      background: var(--color-sidebar-bg); border-right: 1px solid var(--color-border);
      display: flex; flex-direction: column; overflow-y: auto;
    }
    .sidebar-brand { padding: 1.1rem 1.25rem 0.9rem; }
    .brand-mark {
      font-weight: 900; font-size: 1.1rem; letter-spacing: -0.03em;
      color: var(--color-accent);
    }
    .sidebar-nav { display: flex; flex-direction: column; gap: 0.15rem; padding: 0 0.6rem; }
    .sidebar-link {
      display: flex; align-items: center; gap: 0.65rem;
      padding: 0.5rem 0.7rem; border-radius: var(--radius-sm);
      color: var(--color-text-dim); font-size: 0.78rem; font-weight: 600;
      letter-spacing: 0.04em; text-transform: uppercase;
    }
    .sidebar-link:hover { color: var(--color-text); background: var(--color-surface-container); text-decoration: none; }
    .sidebar-link.active { color: var(--color-accent); background: var(--color-surface-container-high); }
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
    .sidebar-project-link.active { color: var(--color-accent); border-left-color: var(--color-accent); }
    .sidebar-loading { padding: 0.4rem 1.1rem; font-size: 0.78rem; color: var(--color-text-dimmer); }
    .sidebar-footer { padding: 0.6rem 0.6rem 0; }
    .theme-toggle {
      display: flex; align-items: center; justify-content: center;
      width: 32px; height: 32px; cursor: pointer;
      background: var(--color-surface-container); color: var(--color-text-dim);
      border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm);
    }
    .theme-toggle:hover { color: var(--color-text); background: var(--color-surface-container-high); }

    .btn-install {
      margin: 0.75rem; font-size: 0.75rem; font-family: inherit; cursor: pointer;
      background: transparent; color: var(--color-accent); border: 1px solid var(--color-accent);
      padding: 0.4rem 0.85rem; border-radius: var(--radius-sm); transition: all 0.15s;
    }
    .btn-install:hover { background: var(--color-accent); color: var(--color-on-primary); }

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
    body.task-panel-pinned #agent-panel-toggle { display: none; }

    /* ── Task detail panel (RHS) ── */
    body.task-panel-pinned { grid-template-columns: var(--sidebar-width) 1fr var(--task-panel-width); }
    #task-panel {
      background: var(--color-surface-container); border-left: 1px solid var(--color-border);
      display: flex; flex-direction: column; overflow: hidden;
    }
    /* An id selector's display:flex beats the UA sheet's rule for the hidden
       attribute, which would otherwise leave a closed panel holding its column.
       (No backticks in this block — it is inside a JS template literal.) */
    #task-panel[hidden] { display: none; }
    /* Pinned: a real grid column, so the page reflows narrower beside it. */
    body.task-panel-pinned #task-panel { grid-column: 3; grid-row: 1; }
    /* Unpinned: an overlay that slides in over the RHS and leaves layout alone. */
    body:not(.task-panel-pinned) #task-panel {
      position: fixed; top: 0; right: 0; height: 100vh; width: var(--task-panel-width);
      z-index: 300; box-shadow: -8px 0 24px var(--color-panel-shadow);
      transform: translateX(100%); transition: transform 0.18s ease-out;
    }
    body:not(.task-panel-pinned) #task-panel.open { transform: translateX(0); }

    .task-panel-header { padding: 0.85rem 1rem; border-bottom: 1px solid var(--color-border);
                         display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
    .task-panel-slug { font-family: var(--font-mono); font-size: 0.82rem; color: var(--color-text-bright);
                       overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .task-panel-actions { display: flex; gap: 0.25rem; flex-shrink: 0; }
    .task-panel-icon-btn {
      background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm);
      color: var(--color-text-dim); cursor: pointer; width: 28px; height: 28px;
      display: flex; align-items: center; justify-content: center;
    }
    .task-panel-icon-btn:hover { color: var(--color-text); background: var(--color-surface-container-high); }
    .task-panel-icon-btn.active { color: var(--color-accent); border-color: var(--color-accent); }

    .task-panel-body { flex: 1; overflow-y: auto; padding: 1rem; }
    .tp-form { display: flex; flex-direction: column; gap: 0.7rem; }
    .tp-field { display: flex; flex-direction: column; gap: 0.25rem; }
    .tp-label { font-size: 0.68rem; font-weight: 600; letter-spacing: 0.06em;
                text-transform: uppercase; color: var(--color-text-dim); }
    .tp-input {
      font: inherit; font-size: 0.82rem; background: var(--color-bg); color: var(--color-text);
      border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); padding: 0.45em 0.6em;
      width: 100%;
    }
    .tp-input:focus { outline: 2px solid var(--color-accent); outline-offset: -1px; }
    .tp-textarea { resize: vertical; font-family: var(--font-mono); font-size: 0.76rem; line-height: 1.5; }
    .tp-invalid { border-color: var(--color-danger); }

    .tp-computed { margin-top: 1.25rem; padding-top: 0.85rem; border-top: 1px solid var(--color-border); }
    .tp-section { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
                  color: var(--color-text-subtle); margin-bottom: 0.6rem; }
    .tp-section-note { font-weight: 400; letter-spacing: 0; text-transform: none; color: var(--color-text-dimmer); }
    .tp-ro-grid { display: flex; flex-direction: column; gap: 0.5rem; }
    .tp-ro-item { display: flex; flex-direction: column; gap: 0.15rem; }
    .tp-ro-value { font-family: var(--font-mono); font-size: 0.78rem; color: var(--color-text); }
    .tp-empty { font-size: 0.78rem; color: var(--color-text-dimmer); }

    .task-panel-footer { padding: 0.75rem 1rem; border-top: 1px solid var(--color-border);
                         display: flex; align-items: center; gap: 0.75rem; }
    .task-panel-msg { flex: 1; font-size: 0.74rem; color: var(--color-text-dim); line-height: 1.4; }
    .task-panel-msg.ok    { color: var(--color-status-done); }
    .task-panel-msg.warn  { color: var(--color-warning); }
    .task-panel-msg.error { color: var(--color-danger); }
    .task-panel-save {
      font: inherit; font-size: 0.8rem; font-weight: 600; cursor: pointer; flex-shrink: 0;
      background: var(--color-accent); color: var(--color-on-primary);
      border: 1px solid var(--color-accent); border-radius: var(--radius-sm); padding: 0.45em 1.1em;
    }
    .task-panel-save:disabled { background: transparent; color: var(--color-text-dimmer);
                                border-color: var(--color-border-strong); cursor: default; }

    /* Dependency slug chips — shared, since the panel renders them everywhere. */
    .depchip { display: inline-block; background: var(--color-bg); border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm);
               padding: 0.1em 0.5em; font-family: var(--font-mono); font-size: 0.75rem; color: var(--color-text-muted); margin-right: 0.35rem; }

    /* The node or card the panel is describing, so the link is visible. */
    .tp-selected { outline: 2px solid var(--color-accent); outline-offset: 2px; }

    /* ── Icon ── */
    .icon { display: inline-block; vertical-align: middle; flex-shrink: 0; }

    /* ── Badges (status + executor) ── */
    .badge { font-size: 0.7rem; padding: 0.15em 0.5em; border-radius: var(--radius-sm); font-weight: 600; }
    .badge-todo       { background: var(--color-status-todo-surface); color: var(--color-status-todo); }
    .badge-inprogress { background: var(--color-status-in-progress-surface); color: var(--color-status-in-progress); }
    .badge-blocked    { background: var(--color-status-blocked-surface); color: var(--color-status-blocked); }
    .badge-done       { background: var(--color-status-done-surface); color: var(--color-status-done); }
    .badge-dropped    { background: var(--color-status-dropped-surface); color: var(--color-status-dropped); }
    .badge-llm        { background: var(--color-executor-llm-surface); color: var(--color-executor-llm); }
    .badge-human      { background: var(--color-executor-human-surface); color: var(--color-executor-human); }
    .badge-hybrid     { background: var(--color-executor-hybrid-surface); color: var(--color-executor-hybrid); }
    .badge-auto       { background: var(--color-executor-auto-surface); color: var(--color-executor-auto); }

    /* ── Buttons / inputs (shared primitives) ── */
    .filter-btn { font: inherit; font-size: 0.78rem; background: var(--color-surface-container); color: var(--color-text-subtle);
                  border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); padding: 0.35em 0.9em; cursor: pointer; }
    .filter-btn:hover { color: var(--color-text); background: var(--color-surface-container-high); }
    .filter-btn.active { background: var(--color-surface-container-highest); color: var(--color-text-bright); border-color: var(--color-text-dimmer); }
    .search-input, .status-select {
      font: inherit; font-size: 0.82rem; background: var(--color-surface-container); color: var(--color-text);
      border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); padding: 0.45em 0.8em;
    }
    .search-input::placeholder { color: var(--color-text-dimmer); }

    /* ── Tables (shared base) ── */
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    th { text-align: left; color: var(--color-text-faint); font-weight: 600; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--color-border); }
    td { padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--color-border-subtle); }

    /* ── Cards / stats / progress ── */
    .card { background: var(--color-surface-container); border: 1px solid var(--color-border);
            border-radius: var(--radius); padding: var(--space-card-padding); }
    .stat { background: var(--color-surface-container); border: 1px solid var(--color-border);
            border-radius: var(--radius); padding: 0.75rem 1rem; }
    .stat-value { font-size: 1.4rem; font-weight: 700; color: var(--color-text-bright); }
    .stat-label { font-size: 0.72rem; color: var(--color-text-dim); margin-top: 0.2rem; }
    .progress-bar-wrap { background: var(--color-surface-container-highest); border-radius: var(--radius-sm); height: 4px; }
    .progress-bar-fill { background: var(--color-accent); height: 100%; border-radius: var(--radius-sm); transition: width 0.4s; }
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

async function patchJson(path, body) {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    // The server names the offending field on a 400 and on a blocked 409; carry
    // it through so the panel can mark that input rather than only saying "400".
    const err = new Error(data.error ?? `${path}: ${res.status}`);
    err.field = data.field;
    throw err;
  }
  return data;
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

/**
 * The one place a task status becomes a colour. Badges resolve it through the
 * .badge-* classes above; the CPM graph needs the same value as an SVG stroke,
 * where no class hierarchy is available to inherit from. Both read from here so
 * a status cannot end up amber in one view and grey in the other.
 *
 * Falls back to the neutral 'dropped' grey rather than to 'todo': an unknown
 * status is not a task waiting to be picked up, and colouring it as one would
 * be a confident lie about work in an unrecognised state.
 */
const STATUS_TOKENS = {
  'todo':        '--color-status-todo',
  'in-progress': '--color-status-in-progress',
  'blocked':     '--color-status-blocked',
  'done':        '--color-status-done',
  'dropped':     '--color-status-dropped',
};

function statusColor(status) {
  return `var(${STATUS_TOKENS[status] ?? STATUS_TOKENS['dropped']})`;
}

function statusBadge(status) {
  const map = {
    'todo':        { label: 'todo',        cls: 'badge-todo' },
    'in-progress': { label: 'in progress', cls: 'badge-inprogress' },
    'blocked':     { label: 'blocked',     cls: 'badge-blocked' },
    'done':        { label: 'done',        cls: 'badge-done' },
    'dropped':     { label: 'dropped',     cls: 'badge-dropped' },
    // Project statuses borrow the task palette. 'active' keeps the blue it
    // always rendered as — that badge simply used to be called 'open'.
    'active':      { label: 'active',      cls: 'badge-inprogress' },
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
