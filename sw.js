// ============================================================================
// ⚡ PEA SMART GRID — SERVICE WORKER v116 (sw.js)
// เปลี่ยนเฉพาะเลข CACHE_NAME บรรทัดเดียว บังคับอัปเดต HTML/JS ทะลุแคชทุกเครื่องอัตโนมัติ
// ============================================================================
const CACHE_NAME = 'pea-smart-tools-v116';
const TILE_CACHE_NAME = 'pea-map-tiles-v2';
const MAX_TILE_CACHE_ENTRIES = 120;

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

const REQUIRED_LOCAL_SHELL = new Set([
    './',
    './index.html',
    './page2.html',
    './shared-core.js',
    './main-app.js',
    './tech-jobs.js',
    './scada-engine.js',
    './pm-calendar.js'
]);

const STATIC_CDN_HOSTS = [
    'cdn.tailwindcss.com',
    'unpkg.com',
    'cdn.jsdelivr.net',
    'cdnjs.cloudflare.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'www.gstatic.com'
];

const MAP_TILE_HOST_RE = /^(?:(?:mt|khms)\d?\.google\.com|(?:[a-z0-9-]+\.)?tile\.openstreetmap\.org|(?:[a-z0-9-]+\.)?basemaps\.cartocdn\.com|server\.arcgisonline\.com)$/i;

const BYPASS_HOSTS = [
    'script.google.com',
    'script.googleusercontent.com',
    'generativelanguage.googleapis.com',
    'firebaseinstallations.googleapis.com',
    'fcmregistrations.googleapis.com',
    'firebasedatabase.app',
    'firebaseio.com',
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

let isTrimmingTiles = false;

async function fetchWithTimeout(resource, options = {}, timeoutMs = 8000) {
    if (typeof AbortController === 'undefined') return fetch(resource, options);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(resource, { ...options, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

function isValidAssetResponse(pathname, res, destination = '') {
    if (!res || res.type === 'opaque') return true;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const isNonHtmlDest = ['script', 'style', 'image', 'font', 'manifest', 'audio', 'video'].includes(destination);
    const isNonHtmlExt = /\.(?:js|mjs|json|webmanifest|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)$/i.test(pathname);
    if ((isNonHtmlDest || isNonHtmlExt) && ct.includes('text/html')) {
        return false;
    }
    return true;
}

function isValidShellPayload(pathname, res, buf, destination = '') {
    if (!isValidAssetResponse(pathname, res, destination)) return false;
    const baseDirPath = self.location.pathname.replace(/[^/]*$/, '');
    const isMainHtml = pathname === baseDirPath ||
                       /(?:^\/$|\/index\.html$|\/page2\.html$|^\.\/$|^\.\/index\.html$|^\.\/page2\.html$)/i.test(pathname);
    if (isMainHtml && buf) {
        try {
            const text = new TextDecoder('utf-8').decode(buf);
            if (!/(?:shared-core|main-app|tech-jobs|scada-engine|pm-calendar)\.js/i.test(text)) {
                return false;
            }
        } catch (e) {}
    }
    return true;
}

async function cleanRedirectedResponse(res, preReadBuffer = null) {
    const buf = preReadBuffer !== null ? preReadBuffer : await res.arrayBuffer();
    const cleanHeaders = new Headers(res.headers);
    cleanHeaders.delete('content-encoding');
    cleanHeaders.delete('content-length');
    const bodyPayload = [101, 204, 205, 304].includes(res.status) ? null : buf;
    return new Response(bodyPayload, {
        status: res.status,
        statusText: res.statusText,
        headers: cleanHeaders
    });
}

async function trimCacheEntries(cacheName, maxItems) {
    if (isTrimmingTiles) return;
    isTrimmingTiles = true;
    try {
        const cache = await caches.open(cacheName);
        const keys = await cache.keys();
        if (keys.length > maxItems) {
            const deleteCount = keys.length - maxItems;
            await Promise.all(keys.slice(0, deleteCount).map((k) => cache.delete(k)));
        }
    } catch (e) {
    } finally {
        isTrimmingTiles = false;
    }
}

function resolveAppTargetUrl(rawUrl) {
    const baseDirPath = self.location.pathname.replace(/[^/]*$/, '');
    const baseDir = self.location.origin + baseDirPath;
    let rel = String(rawUrl || './index.html?openPm=1').trim();
    if (/^https?:\/\//i.test(rel)) return rel;
    if (rel.startsWith('/') && !rel.startsWith(baseDirPath)) {
        rel = './' + rel.replace(/^\/+/, '');
    }
    return new URL(rel, baseDir).href;
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            try {
                const cache = await caches.open(CACHE_NAME);
                const localAssets = APP_SHELL_ASSETS.filter((u) => u.startsWith('./'));
                const externalAssets = APP_SHELL_ASSETS.filter((u) => !u.startsWith('./'));

                // 1. ไฟล์หลักของแอปต้องโหลดครบและปลอดภัยจาก Captive Portal ก่อนยอมสลับเวอร์ชันแคช
                await Promise.all(
                    localAssets.map(async (assetUrl) => {
                        const isRequired = REQUIRED_LOCAL_SHELL.has(assetUrl);
                        const fetchUrl = `${assetUrl}${assetUrl.includes('?') ? '&' : '?'}_sw=${encodeURIComponent(CACHE_NAME)}`;
                        const cleanPath = assetUrl.split('?')[0];
                        try {
                            let res = await fetchWithTimeout(fetchUrl, { cache: 'no-store' }, 10000);
                            if (!res || res.status !== 200) {
                                if (!isRequired && res && res.status === 404) return;
                                throw new Error(`HTTP ${res ? res.status : 'ERR'}: ${assetUrl}`);
                            }
                            if (res.redirected && res.url && new URL(res.url).origin !== self.location.origin) {
                                throw new Error(`Cross-origin redirect blocked: ${assetUrl}`);
                            }
                            const buf = await res.clone().arrayBuffer();
                            if (!isValidShellPayload(cleanPath, res, buf, '')) {
                                throw new Error(`Invalid payload blocked: ${assetUrl}`);
                            }
                            if (res.redirected) {
                                res = await cleanRedirectedResponse(res, buf);
                            }
                            await cache.put(assetUrl, res);
                        } catch (err) {
                            if (isRequired) throw err;
                        }
                    })
                );

                // 2. ไลบรารี CDN ภายนอก: มี Timeout 8 วิ หากค้างดึงแคชเก่ามาสำรองทันทีไม่บล็อกการอัปเดต
                await Promise.allSettled(
                    externalAssets.map(async (assetUrl) => {
                        const cleanPath = assetUrl.split('?')[0];
                        try {
                            let res = await fetchWithTimeout(assetUrl, { cache: 'reload' }, 8000);
                            if (res && res.status === 200) {
                                const buf = await res.clone().arrayBuffer();
                                if (!isValidShellPayload(cleanPath, res, buf, 'script')) return;
                                if (res.redirected) res = await cleanRedirectedResponse(res, buf);
                                await cache.put(assetUrl, res).catch(() => {});
                                return;
                            }
                        } catch (err) {}

                        const prevCached = await caches.match(assetUrl, { ignoreVary: true }).catch(() => null);
                        if (prevCached) {
                            await cache.put(assetUrl, prevCached).catch(() => {});
                            return;
                        }
                        try {
                            const opaqueRes = await fetchWithTimeout(assetUrl, { mode: 'no-cors', cache: 'reload' }, 5000);
                            if (opaqueRes && (opaqueRes.status === 200 || opaqueRes.type === 'opaque')) {
                                await cache.put(assetUrl, opaqueRes).catch(() => {});
                            }
                        } catch (e) {}
                    })
                );

                await self.skipWaiting();
            } catch (installErr) {
                await caches.delete(CACHE_NAME).catch(() => {});
                throw installErr;
            }
        })()
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.map((key) => (key !== CACHE_NAME && key !== TILE_CACHE_NAME ? caches.delete(key) : null))
            )
        )
        .then(() => trimCacheEntries(TILE_CACHE_NAME, MAX_TILE_CACHE_ENTRIES))
        .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    if (req.headers.has('range')) return;
    if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

    const url = new URL(req.url);
    if (!url.protocol.startsWith('http')) return;
    if (/\/sw\.js$/i.test(url.pathname)) return;
    if (BYPASS_HOSTS.some((host) => url.hostname.includes(host))) return;

    // 1. แผ่นแผนที่ (Google / OSM / CartoDB / Esri): Cache-First + คุมโควตา 120 แผ่น
    if (MAP_TILE_HOST_RE.test(url.hostname)) {
        event.respondWith(
            caches.open(TILE_CACHE_NAME).then(async (tileCache) => {
                const cachedTile = await tileCache.match(req, { ignoreVary: true });
                if (cachedTile && !(cachedTile.type === 'opaque' && req.mode === 'cors')) {
                    return cachedTile;
                }
                try {
                    const res = await fetch(req);
                    if (res && (res.status === 200 || res.type === 'opaque')) {
                        const copy = res.clone();
                        event.waitUntil(
                            tileCache.put(req, copy)
                                .then(() => {
                                    if (Math.random() < 0.15) return trimCacheEntries(TILE_CACHE_NAME, MAX_TILE_CACHE_ENTRIES);
                                })
                                .catch(() => {})
                        );
                    }
                    return res;
                } catch (e) {
                    if (cachedTile && !(cachedTile.type === 'opaque' && req.mode === 'cors')) return cachedTile;
                    return Response.error();
                }
            }).catch(() => fetch(req).catch(() => Response.error()))
        );
        return;
    }

    // 2. ไฟล์ระบบ HTML / JS / CSS / JSON: โหลดครบทั้งไฟล์ภายใน 5 วิ + กัน Captive Portal ทับแคช
    const isAppShellFile = url.origin === self.location.origin &&
        (req.mode === 'navigate' || /\.(?:html|js|mjs|css|json|webmanifest)$/i.test(url.pathname) || url.pathname.endsWith('/'));

    if (isAppShellFile) {
        const baseDirPath = self.location.pathname.replace(/[^/]*$/, '');
        const cleanCacheKey = url.origin + url.pathname;
        const isRootOrIndex = url.pathname === baseDirPath || url.pathname === baseDirPath + 'index.html';
        const mirrorIndexKey = isRootOrIndex
            ? url.origin + (url.pathname === baseDirPath ? baseDirPath + 'index.html' : baseDirPath)
            : '';

        event.respondWith(
            (async () => {
                let cache = null;
                let cachedFallback = null;
                try {
                    cache = await caches.open(CACHE_NAME);
                    cachedFallback = await cache.match(cleanCacheKey, { ignoreSearch: true, ignoreVary: true }) ||
                                     await cache.match(req, { ignoreSearch: true, ignoreVary: true }) ||
                                     (mirrorIndexKey ? await cache.match(mirrorIndexKey, { ignoreSearch: true, ignoreVary: true }) : null);
                } catch (e) {}

                const ctrl = cachedFallback && typeof AbortController !== 'undefined' ? new AbortController() : null;
                const timer = ctrl ? setTimeout(() => ctrl.abort(), 5000) : null;

                try {
                    let netRes;
                    if (req.mode === 'navigate') {
                        netRes = await fetch(req.url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
                    } else {
                        const bustUrl = new URL(req.url);
                        bustUrl.searchParams.set('_sw', CACHE_NAME);
                        netRes = await fetch(bustUrl.href, { cache: 'no-cache', signal: ctrl ? ctrl.signal : undefined });
                    }

                    if (netRes && netRes.redirected && netRes.url) {
                        let resOrigin = self.location.origin;
                        try { resOrigin = new URL(netRes.url).origin; } catch (e) {}
                        if (resOrigin !== self.location.origin) {
                            if (timer) clearTimeout(timer);
                            return cachedFallback || Response.redirect(netRes.url, 302);
                        }
                        const cleanReqUrl = req.url.split('#')[0];
                        const cleanResUrl = netRes.url.split('#')[0];
                        if (req.mode === 'navigate' && cleanResUrl && cleanResUrl !== cleanReqUrl) {
                            if (timer) clearTimeout(timer);
                            return Response.redirect(netRes.url, 302);
                        }
                    }

                    if (netRes && netRes.ok) {
                        const buf = await netRes.clone().arrayBuffer();
                        if (timer) clearTimeout(timer);

                        if (!isValidShellPayload(url.pathname, netRes, buf, req.destination)) {
                            return cachedFallback || Response.error();
                        }

                        const finalRes = netRes.redirected
                            ? await cleanRedirectedResponse(netRes, buf)
                            : netRes;

                        if (cache && finalRes.status === 200) {
                            const copyMain = finalRes.clone();
                            const copyMirror = mirrorIndexKey ? finalRes.clone() : null;
                            event.waitUntil(
                                Promise.all([
                                    cache.put(cleanCacheKey, copyMain).catch(() => {}),
                                    copyMirror ? cache.put(mirrorIndexKey, copyMirror).catch(() => {}) : null
                                ])
                            );
                        }
                        return finalRes;
                    }

                    if (timer) clearTimeout(timer);
                    if (netRes && netRes.status >= 500 && cachedFallback) {
                        return cachedFallback;
                    }
                    return netRes || cachedFallback || Response.error();
                } catch (err) {
                    if (timer) clearTimeout(timer);
                    if (cachedFallback) return cachedFallback;
                    if (req.mode === 'navigate' && cache) {
                        const fallbackPage = url.pathname.includes('page2')
                            ? await cache.match('./page2.html', { ignoreSearch: true, ignoreVary: true })
                            : (await cache.match('./index.html', { ignoreSearch: true, ignoreVary: true }) ||
                               await cache.match('./', { ignoreSearch: true, ignoreVary: true }));
                        return fallbackPage || Response.error();
                    }
                    return Response.error();
                }
            })()
        );
        return;
    }

    // 3. ไฟล์ Static ในเว็บตัวเอง และ CDN ไลบรารีมาตรฐานเท่านั้น (ไม่ดักแคช API ภายนอก)
    const isSameOriginStatic = url.origin === self.location.origin;
    const isStaticCdn = STATIC_CDN_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith('.' + host));
    if (!isSameOriginStatic && !isStaticCdn) return;

    event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            const cached = await cache.match(req, { ignoreVary: true }) ||
                           (isSameOriginStatic ? await cache.match(req, { ignoreSearch: true, ignoreVary: true }) : null);
            if (cached && !(cached.type === 'opaque' && req.mode === 'cors')) {
                return cached;
            }
            try {
                const res = await fetch(req);
                if (res && (res.status === 200 || res.type === 'opaque') && isValidAssetResponse(url.pathname, res, req.destination)) {
                    const copy = res.clone();
                    event.waitUntil(cache.put(req, copy).catch(() => {}));
                }
                return res;
            } catch (err) {
                if (cached && !(cached.type === 'opaque' && req.mode === 'cors')) {
                    return cached;
                }
                return Response.error();
            }
        }).catch(() => fetch(req).catch(() => Response.error()))
    );
});

// ============================================================================
// 🔔 รับสัญญาณ Web Push จาก Firebase แม้ปัดปิดแอปไปแล้ว + แจ้งเตือนจาก PM Calendar
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
    const baseDir = self.location.origin + self.location.pathname.replace(/[^/]*$/, '');
    const targetFullUrl = resolveAppTargetUrl(event.notification.data?.url);

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            const appClients = clientList.filter((c) => c.url.startsWith(baseDir) && c.frameType !== 'nested');
            const topClient = appClients.find((c) => c.focused) ||
                              appClients.find((c) => c.visibilityState === 'visible') ||
                              appClients[0];
            if (topClient && 'focus' in topClient) {
                topClient.postMessage({ type: 'OPEN_PM_FROM_PUSH' });
                return topClient.focus().catch(() =>
                    self.clients.openWindow ? self.clients.openWindow(targetFullUrl) : null
                );
            }
            return self.clients.openWindow ? self.clients.openWindow(targetFullUrl) : null;
        })
    );
});