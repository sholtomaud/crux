// ui/app.js — shared utilities for all crux UI pages

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

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
    <div class="progress-bar-wrap">
      <div class="progress-bar-fill" style="width:${pct}%"></div>
      <span class="progress-label">${done}/${total}</span>
    </div>`;
}
