// crux service worker — cache-first for static assets, network-first for /api/*

// Bumped to v3 when tokens.css was introduced — a stale v2 cache would serve
// pages whose stylesheet link 404s, leaving the UI unstyled.
// Bump this on EVERY change to a precached asset below. The fetch handler is
// cache-first for them, so a stale cache is served forever otherwise — there is
// no revalidation and no max-age to save you.
//
// v5: status palette, the task detail panel, and the 'todo' rename. graph.html
//     is NOT precached, so it arrives fresh and would reference
//     --color-status-* against a v4 tokens.css that never heard of them —
//     every node outline silently falling back to grey. New page, old
//     stylesheet is the failure mode this bump exists to prevent.
const CACHE  = 'crux-v5';
const STATIC = ['/', '/tokens.css', '/theme.js', '/app.js', '/manifest.json', '/sw.js', '/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (url.pathname.startsWith('/api/')) {
    if (e.request.method !== 'GET') {
      // POST/etc. (status writes) — Cache API only supports GET; never cache these.
      e.respondWith(fetch(e.request));
      return;
    }
    // Network-first: try network, fall back to cache
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for static assets
  e.respondWith(
    caches.match(e.request).then(cached => cached ?? fetch(e.request))
  );
});
