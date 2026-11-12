// ============================================================================
// ⚡ PEA SMART GRID — SERVICE WORKER v95 (sw.js)
// แก้แคชค้างบน GitHub Pages (บังคับ no-cache ไฟล์ระบบ + กัน cache.addAll พังจากไฟล์ 404)
// ============================================================================
const CACHE_NAME = 'pea-smart-tools-v97';
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
    './manifest.json',
    './manifest-main.json',
    'https://cdn.tailwindcss.com',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://unpkg.com/mqtt@5.3.4/dist/mqtt.min.js',
    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
];

const BYPASS_HOSTS = [
    'script.google.com',
    'script.googleusercontent.com',
    'generativelanguage.googleapis.com',
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
                APP_SHELL_ASSETS.map((url) =>
                    fetch(url, { cache: 'reload' })
                        .then((res) => (res && (res.ok || res.type === 'opaque') ? cache.put(url, res) : null))
                        .catch(() => null)
                )
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

    // 2. ไฟล์ระบบ HTML / JS / JSON: บังคับดึงสดจากเซิร์ฟเวอร์ (no-cache) ไม่ติดแคช GitHub Pages
    const isAppShellFile = url.origin === self.location.origin &&
        (req.mode === 'navigate' || /\.(?:html|js|json)$/i.test(url.pathname) || url.pathname.endsWith('/'));

    if (isAppShellFile) {
        event.respondWith(
            fetch(req, { cache: 'no-cache' }).then((res) => {
                if (res && res.ok) {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                }
                return res;
            }).catch(async () => {
                const cache = await caches.open(CACHE_NAME);
                const exact = await cache.match(req, { ignoreSearch: true });
                if (exact) return exact;
                if (req.mode === 'navigate') {
                    return url.pathname.includes('page2')
                        ? cache.match('./page2.html', { ignoreSearch: true })
                        : cache.match('./index.html', { ignoreSearch: true });
                }
                return Response.error();
            })
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
