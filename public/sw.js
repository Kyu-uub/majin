/* Majin — service worker.
   Shell files are precached with the exact ?v= queries used in index.html.
   Bump VERSION and the ?v= queries together whenever JS/CSS changes.
   The UI is now a single self-authored css/app.css (no Tailwind build) and every
   library is served from public/vendor, so there is nothing off-CDN to fall back to
   any more — offline is the normal case. */
const VERSION = 'majin-v39';
const SHELL = [
  './',
  './index.html',
  './vision.html',
  './css/app.css?v=39',
  './js/app.js?v=39',
  './js/vision.js?v=36',
  './vendor/lucide.min.js?v=29',
  './vendor/marked.min.js?v=29',
  './vendor/purify.min.js?v=29',
  './vendor/highlight/highlight.min.js?v=29',
  './vendor/highlight/atom-one-dark.min.css',
  './vendor/inter/inter.css',
  './manifest.webmanifest',
  './favicon.svg',
  './icon-1024.png'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await Promise.allSettled(SHELL.map(u => c.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let u;
  try { u = new URL(req.url); } catch (_) { return; }
  if (!/^https?:$/.test(u.protocol)) return;
  if (/(^|\.)googleapis\.com$/.test(u.hostname)) return;   // the Gemini API must never be served from cache
  if (u.pathname.startsWith('/api/')) return;             // server helper routes stay live

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        if (r.ok) { const c = await caches.open(VERSION); c.put('./index.html', r.clone()); }
        return r;
      } catch (_) {
        const c = await caches.open(VERSION);
        return (await c.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  if (u.origin === location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      const hit = await c.match(req);
      const net = fetch(req).then(r => {
        if (r.ok || r.type === 'opaque') c.put(req, r.clone());
        return r;
      }).catch(() => null);
      return hit || (await net) || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    })());
  }
});
