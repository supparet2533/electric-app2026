// ============================================================================
// ⚡ PEA SMART GRID — SERVICE WORKER v97 (sw.js)
// รองรับการแคชไฟล์โมดูล shared-core.js, tech-jobs.js, scada-engine.js, main-app.js
// ============================================================================
const CACHE_NAME = 'pea-smart-tools-v98';
const TILE_CACHE_NAME = 'pea-map-tiles-v2';

const CORE_ASSETS = [
    './',
    './index.html',
    './page2.html',
    './manifest.json',
    './shared-core.js',
    './tech-jobs.js',
    './scada-engine.js'
    './pm-calendar.js'
];

const OPTIONAL_ASSETS = [
    './manifest-main.json',
    './main-app.js',
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
        caches.open(CACHE_NAME).then(async (cache) => {
            await cache.addAll(CORE_ASSETS);
            await Promise.allSettled(
                OPTIONAL_ASSETS.map((url) => cache.add(url).catch(() => null))
            );
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME && key !== TILE_CACHE_NAME) {
                        return caches.delete(key);
                    }
                    return null;
                })
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

    // 1. แผ่นแผนที่ (Map Tiles): ใช้ Cache-First พร้อมอัปเดตฉากหลังเพื่อดูผังตอนอับสัญญาณได้
    if (url.hostname.includes('mt1.google.com') || url.hostname.includes('tile.openstreetmap.org')) {
        event.respondWith(
            caches.open(TILE_CACHE_NAME).then(async (tileCache) => {
                const cachedTile = await tileCache.match(req);
                const networkFetch = fetch(req).then((res) => {
                    if (res && (res.ok || res.type === 'opaque')) {
                        tileCache.put(req, res.clone());
                    }
                    return res;
                }).catch(() => cachedTile);
                return cachedTile || networkFetch;
            })
        );
        return;
    }

    // 2. ไฟล์ HTML และโมดูล JS ของระบบ: ใช้ Network-First เพื่อให้ได้โค้ดล่าสุดเสมอ และสลับเข้าแคชทันทีเมื่อออฟไลน์
    const isAppShellFile = url.origin === self.location.origin &&
        (req.mode === 'navigate' || /\.(?:html|js|json)$/i.test(url.pathname) || url.pathname.endsWith('/'));

    if (isAppShellFile) {
        event.respondWith(
            fetch(req).then((res) => {
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
                        ? cache.match('./page2.html')
                        : cache.match('./index.html');
                }
                return Response.error();
            })
        );
        return;
    }

    // 3. ไลบรารี CDN และฟอนต์: ใช้ Cache-First เพื่อเปิดหน้าเว็บได้ไวทันใจ
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
