// ============================================================================
// ⚡ PEA SMART GRID — SERVICE WORKER v107 (sw.js)
// เปลี่ยนเฉพาะเลข CACHE_NAME บรรทัดเดียว บังคับอัปเดต HTML/JS ทะลุแคชทุกเครื่องอัตโนมัติ
// ============================================================================
const CACHE_NAME = 'pea-smart-tools-v109';
const TILE_CACHE_NAME = 'pea-map-tiles-v2';

const APP_SHELL_ASSETS = [
    './',
    './index.html',
    './page2.html',
    './shared-core.js',
    './main-app.js',
    './tech-jobs.js',
    './scada-engine.js',
    './pm-calendar.js',
    './pm-push.js',
    './manifest.json',
    './manifest-main.json',
    'https://cdn.tailwindcss.com',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://unpkg.com/mqtt@5.3.4/dist/mqtt.min.js',
    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    'https://cdn.jsdelivr.net/npm/sortablejs@latest/Sortable.min.js',
    'https://cdn.jsdelivr.net/npm/chart.js'
];

const BYPASS_HOSTS = [
    'script.google.com',
    'script.googleusercontent.com',
    'generativelanguage.googleapis.com',
    'firebaseinstallations.googleapis.com',
    'fcmregistrations.googleapis.com',
    'broker.emqx.io',
    'broker.hivemq.com',
    'mqtt.eclipseprojects.io',
    'router.project-osrm.org',
    'routing.openstreetmap.de',
    'api.microlink.io',
    'api.allorigins.win',
    'unshorten.me',
    'api.codetabs.com',
    'corsproxy.io',
    'open-meteo.com',
    'nominatim.openstreetmap.org'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            Promise.allSettled(
                APP_SHELL_ASSETS.map((assetUrl) => {
                    const isLocal = assetUrl.startsWith('./');
                    const fetchUrl = isLocal
                        ? `${assetUrl}${assetUrl.includes('?') ? '&' : '?'}_sw=${encodeURIComponent(CACHE_NAME)}`
                        : assetUrl;
                    return fetch(fetchUrl, isLocal ? { cache: 'no-store' } : { cache: 'reload' })
                        .then((res) => (res && (res.ok || res.type === 'opaque') ? cache.put(assetUrl, res) : null))
                        .catch(() => null);
                })
            )
        )
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.map((key) => (key !== CACHE_NAME && key !== TILE_CACHE_NAME ? caches.delete(key) : null))
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (!url.protocol.startsWith('http')) return;
    if (BYPASS_HOSTS.some((host) => url.hostname.includes(host))) return;

    // 1. แผ่นแผนที่ (Map Tiles): Cache-First พร้อมอัปเดตเบื้องหลัง
    if (url.hostname.includes('mt1.google.com') || url.hostname.includes('tile.openstreetmap.org')) {
        event.respondWith(
            caches.open(TILE_CACHE_NAME).then(async (tileCache) => {
                const cachedTile = await tileCache.match(req);
                const netFetch = fetch(req).then((res) => {
                    if (res && (res.ok || res.type === 'opaque')) tileCache.put(req, res.clone());
                    return res;
                }).catch(() => cachedTile);
                return cachedTile || netFetch;
            })
        );
        return;
    }

    // 2. ไฟล์ระบบ HTML / JS / JSON: ทะลุแคชอัตโนมัติตามเลข CACHE_NAME โดยไม่ต้องแก้ ?v= ใน HTML
    const isAppShellFile = url.origin === self.location.origin &&
        (req.mode === 'navigate' || /\.(?:html|js|json)$/i.test(url.pathname) || url.pathname.endsWith('/'));

    if (isAppShellFile) {
        const cleanCacheKey = url.origin + url.pathname;
        event.respondWith(
            (async () => {
                try {
                    let netRes;
                    if (req.mode === 'navigate') {
                        netRes = await fetch(req, { cache: 'no-store' });
                    } else {
                        const bustUrl = new URL(req.url);
                        bustUrl.searchParams.set('_sw', CACHE_NAME);
                        netRes = await fetch(bustUrl.href, { cache: 'no-cache' });
                    }
                    if (netRes && netRes.ok) {
                        const cache = await caches.open(CACHE_NAME);
                        cache.put(cleanCacheKey, netRes.clone());
                    }
                    return netRes;
                } catch (err) {
                    const cache = await caches.open(CACHE_NAME);
                    const cached = await cache.match(cleanCacheKey, { ignoreSearch: true }) ||
                                   await cache.match(req, { ignoreSearch: true });
                    if (cached) return cached;
                    if (req.mode === 'navigate') {
                        return url.pathname.includes('page2')
                            ? cache.match('./page2.html', { ignoreSearch: true })
                            : cache.match('./index.html', { ignoreSearch: true });
                    }
                    return Response.error();
                }
            })()
        );
        return;
    }

    // 3. ไลบรารีภายนอกและฟอนต์: Cache-First
    event.respondWith(
        caches.match(req).then((cached) => {
            if (cached) return cached;
            return fetch(req).then((res) => {
                if (res && (res.ok || res.type === 'opaque')) {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                }
                return res;
            });
        })
    );
});

// ============================================================================
// 🔔 รับสัญญาณ Web Push จาก Firebase แม้ปัดปิดแอปไปแล้ว (แสดงเฉพาะยอดสรุป)
// ============================================================================
self.addEventListener('push', (event) => {
    let payload = {};
    try {
        const raw = event.data ? event.data.json() : {};
        payload = {
            ...(raw.notification || {}),
            ...(raw.data || {}),
            ...(!raw.notification && !raw.data ? raw : {})
        };
    } catch (e) {
        payload = { body: event.data ? event.data.text() : '' };
    }

    const title = payload.title || '🔔 แจ้งเตือนแผนงานบำรุงรักษา (PM)';
    const options = {
        body: payload.body || 'มีแผนงานบำรุงรักษาถึงกำหนด แตะเพื่อเปิดดูรายละเอียด',
        tag: payload.tag || 'pea-pm-summary-push',
        renotify: true,
        requireInteraction: true,
        vibrate: [220, 100, 220],
        data: { url: payload.url || './index.html?openPm=1' }
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetRelUrl = event.notification.data?.url || './index.html?openPm=1';
    const targetFullUrl = new URL(targetRelUrl, self.location.origin + self.location.pathname.replace(/[^/]*$/, '')).href;

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if (client.url.startsWith(self.location.origin) && 'focus' in client) {
                    client.postMessage({ type: 'OPEN_PM_FROM_PUSH' });
                    return client.focus();
                }
            }
            return self.clients.openWindow ? self.clients.openWindow(targetFullUrl) : null;
        })
    );
});
