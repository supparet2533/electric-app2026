const CACHE_NAME = 'pea-smart-tools-v89';

// ไฟล์หลักของแอปที่ต้องการเก็บไว้เปิดตอนออฟไลน์
const STATIC_ASSETS = [
  './',
  './index.html',
  './page2.html',
  './manifest-main.json',
  './manifest.json'
];

// รายชื่อโดเมน API ข้อมูลสดและแผนที่ที่ให้วิ่งตรงผ่านอินเทอร์เน็ตเสมอ
const BYPASS_HOSTS = [
  'script.google.com',
  'script.googleusercontent.com',
  'api.open-meteo.com',
  'generativelanguage.googleapis.com',
  'nominatim.openstreetmap.org',
  'router.project-osrm.org',
  'api.allorigins.win',
  'api.codetabs.com',
  'api.microlink.io',
  'corsproxy.io',
  'unshorten.me',
  'mt1.google.com',
  'tile.openstreetmap.org'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        STATIC_ASSETS.map((url) => cache.add(url).catch(() => {}))
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // ข้ามคำขอที่ไม่ใช่ GET (เช่น POST ส่งงานขึ้น Google Sheets)
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // ข้ามโปรโตคอลพิเศษ เช่น blob:, data:, chrome-extension:
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 1. หากเป็น API ซิงค์ข้อมูลสดหรือแผ่นแผนที่ ให้วิ่งตรงผ่านอินเทอร์เน็ตเสมอ
  if (BYPASS_HOSTS.some((host) => url.hostname.includes(host))) {
    return;
  }

  // 2. เฉพาะหน้าเว็บ HTML ในโดเมนของเราเองเท่านั้น (ป้องกันไม่ให้ไปบล็อก cdn.tailwindcss.com)
  const isSameOrigin = (url.origin === self.location.origin);
  if (isSameOrigin && (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/'))) {
    event.respondWith(
      fetch(req.url, { cache: 'no-cache' })
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
            return networkRes;
          }
          throw new Error('Fallback to cache');
        })
        .catch(() => {
          return caches.match(req, { ignoreSearch: true }).then((cachedRes) => {
            if (cachedRes) return cachedRes;
            if (url.pathname.includes('page2.html')) {
              return caches.match('./page2.html');
            }
            return caches.match('./index.html');
          });
        })
    );
    return;
  }

  // 3. สำหรับไฟล์สคริปต์ภายนอก (เช่น Tailwind CSS, Leaflet, Fonts) ให้ดึงด้วยโหมดปกติของเบราว์เซอร์
  event.respondWith(
    caches.match(req).then((cachedRes) => {
      const fetchPromise = fetch(req)
        .then((networkRes) => {
          if (networkRes && (networkRes.status === 200 || networkRes.type === 'opaque')) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => cachedRes);

      return cachedRes || fetchPromise;
    })
  );
});