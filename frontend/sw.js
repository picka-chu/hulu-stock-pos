/**
 * Hulu Stock Service Worker v7
 * ─────────────────────────────────────────────────────────────────
 * AUTO-UPDATE SYSTEM:
 *   1. Every deploy bumps SW_VERSION → browser detects new SW
 *   2. New SW installs & posts SW_UPDATED to all open tabs
 *   3. App shows "Update available" banner — user clicks → reload
 *   4. Local JS uses network-first so code is always fresh when online
 *   5. Old caches are deleted on activate → no stale files survive
 *
 * Strategies:
 *   • API calls        → network only (never cached)
 *   • Local JS/CSS     → network-first, cache fallback (always fresh when online)
 *   • CDN assets       → cache-first (stable libraries, rarely change)
 *   • HTML pages       → network-first, cache fallback
 *   • Push notifs      → unchanged
 */

const SW_VERSION   = 'xpos-sw-v1.0';
const CACHE_SHELL  = `xpos-shell-${SW_VERSION}`;
const CACHE_ASSETS = `xpos-assets-${SW_VERSION}`;
const CACHE_PAGES  = `xpos-pages-${SW_VERSION}`;

const SHELL_FILES = [
  '/',
  '/index.html',
  '/login.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/apple-touch-icon.png',
  '/assets/js/app.js',
  '/assets/js/api.js',
  '/assets/js/config.js',
  '/assets/js/scanner.js',
  '/assets/js/fast-scan.js',
  '/assets/js/smart-scan.js',
  '/assets/js/quick-update.js',
];

const CACHEABLE_CDN_HOSTS = [
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.tailwindcss.com',
  'ka-f.fontawesome.com',
  'cdn.jsdelivr.net',
];

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing', SW_VERSION);
  event.waitUntil(
    caches.open(CACHE_SHELL)
      .then(cache => cache.addAll(SHELL_FILES).catch(e => console.warn('[SW] pre-cache partial:', e.message)))
      // skipWaiting → activate immediately, don't wait for old tabs to close
      .then(() => self.skipWaiting())
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating', SW_VERSION);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          // Delete ALL old xpos caches that don't match this version
          .filter(k => k.startsWith('xpos-') && ![CACHE_SHELL, CACHE_ASSETS, CACHE_PAGES].includes(k))
          .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      ))
      .then(() => clients.claim())
      .then(() => {
        // Notify ALL open tabs that a new version has activated
        // The app will show an "Update available — reload" banner
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
          list.forEach(client => client.postMessage({ type: 'SW_UPDATED', version: SW_VERSION }));
        });
      })
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // ── API → network only, never cache ────────────────────────────────────────
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // ── CDN assets (libraries) → cache-first (they never change) ───────────────
  if (CACHEABLE_CDN_HOSTS.some(h => url.hostname.includes(h))) {
    event.respondWith(cacheFirst(request, CACHE_ASSETS));
    return;
  }

  // ── Local JS/CSS assets → network-first ────────────────────────────────────
  // This is the key change: when online, always fetch fresh JS from server.
  // Falls back to cache if offline so the app still loads.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(networkFirstAsset(request));
    return;
  }

  // ── Other static (fonts, images) → cache-first ─────────────────────────────
  if (['image', 'font'].includes(request.destination)) {
    event.respondWith(cacheFirst(request, CACHE_ASSETS));
    return;
  }

  // ── HTML pages → network-first, fall back to shell ─────────────────────────
  if (
    request.destination === 'document' ||
    (request.headers.get('Accept') || '').includes('text/html')
  ) {
    event.respondWith(networkFirstHtml(request));
    return;
  }
});

// ── Network-first for local assets (JS/CSS) ───────────────────────────────────
// Fetches fresh from server when online; serves cache when offline
async function networkFirstAsset(request) {
  const cache = await caches.open(CACHE_ASSETS);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline — serve from cache
    const cached = await cache.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

// ── Cache-first (CDN libraries) ───────────────────────────────────────────────
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(cacheName)).put(request, response.clone());
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

// ── Network-first for HTML pages ──────────────────────────────────────────────
async function networkFirstHtml(request) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE_PAGES)).put(request, response.clone());
    return response;
  } catch {
    return (
      (await caches.match(request)) ||
      (await caches.match('/index.html')) ||
      new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html' } })
    );
  }
}

// ── Offline page ──────────────────────────────────────────────────────────────
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hulu Stock — Offline</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
     background:#0f172a;color:#f8fafc;display:flex;align-items:center;
     justify-content:center;min-height:100dvh;text-align:center;padding:24px}
.box{max-width:320px}
.icon{width:72px;height:72px;background:#2563eb;border-radius:18px;
      display:flex;align-items:center;justify-content:center;
      margin:0 auto 20px;font-size:2rem}
h1{font-size:1.4rem;font-weight:700;margin-bottom:8px}
p{color:#94a3b8;font-size:13px;line-height:1.6;margin-bottom:24px}
button{background:#2563eb;color:#fff;border:none;border-radius:10px;
       padding:12px 32px;font-size:14px;font-weight:600;cursor:pointer}
</style></head>
<body><div class="box">
<div class="icon">✕</div>
<h1>You're offline</h1>
<p>Hulu Stock needs a connection to load.<br>Check your network and try again.</p>
<button onclick="location.reload()">Try Again</button>
</div></body></html>`;

// ── Push received ─────────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  console.log('[SW] Push received');
  let p = {
    title: 'Hulu Stock', body: 'New notification',
    tag: 'xpos-general', url: '/',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-72x72.png',
  };
  if (event.data) {
    try {
      const d = event.data.json();
      p = { ...p, ...d, url: (d.data && d.data.url) || d.url || p.url };
    } catch { p.body = event.data.text(); }
  }

  const isSale  = p.tag.includes('sale');
  const isStock = p.tag.includes('stock') || p.tag.includes('expir');

  const actions = isSale
    ? [{ action: 'open_sales', title: '📋 View Sales' }, { action: 'dismiss', title: '✕' }]
    : isStock
    ? [{ action: 'open_items', title: '📦 View Stock' }, { action: 'dismiss', title: '✕' }]
    : [{ action: 'open_app',   title: '📱 Open Hulu Stock' }, { action: 'dismiss', title: '✕' }];

  event.waitUntil(
    self.registration.showNotification(p.title, {
      body: p.body, icon: p.icon, badge: p.badge,
      tag: p.tag, renotify: true, requireInteraction: false,
      vibrate: isSale ? [200, 80, 200, 80, 200] : [100, 50, 100],
      data: { url: p.url }, actions, timestamp: Date.now(),
    }).catch(err => console.error('[SW] showNotification failed:', err))
  );
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  let url = event.notification.data?.url || '/';
  if (event.action === 'open_sales') url = '/?page=sales';
  if (event.action === 'open_items') url = '/?page=items';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) {
          c.postMessage({ type: 'NAVIGATE', url });
          return c.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

// ── Subscription changed ──────────────────────────────────────────────────────
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(
    clients.matchAll({ type: 'window' })
      .then(list => list.forEach(c => c.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGED' })))
  );
});
