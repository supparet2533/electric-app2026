const CACHE_NAME = 'pea-smart-tools-v80';

// ไฟล์หลักที่ต้องการเก็บไว้ให้เปิดตอนออฟไลน์ได้ทันที (ครบทั้งหน้าหลักและหน้าช่าง)
const STATIC_ASSETS = [
  './',
  './index.html',
  './page2.html',
  './manifest-main.json',
  './manifest.json',
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Prompt:wght@300;400;500;600;700&display=swap',
  'https://cdn.jsdelivr.net/npm/sortablejs@latest/Sortable.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// รายชื่อโดเมน API ข้อมูลสดที่ห้ามแคชเด็ดขาด (ต้องดึงใหม่จากเน็ตเสมอ)
const BYPASS_HOSTS = [
  'script.google.com',
  'script.googleusercontent.com',
  'api.open-meteo.com',
  'generativelanguage.googleapis.com',
  'nominatim.openstreetmap.org',
  'router.project-osrm.org',
  'api.allorigins.win',
  'api.codetabs.com',
  'unshorten.me'
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

  // 1. หากเป็น API ซิงค์ข้อมูลสด ให้วิ่งตรงผ่านอินเทอร์เน็ตเสมอ (ห้ามแคช)
  if (BYPASS_HOSTS.some((host) => url.hostname.includes(host))) {
    return;
  }

  // 2. สำหรับหน้าเว็บ HTML (index.html, page2.html) ใช้ระบบ Network-First
  // (ถ้ามีเน็ตให้ดึงโค้ดล่าสุดเสมอและอัปเดตแคช ถ้าไม่มีเน็ตให้ดึงจากแคชตามชื่อไฟล์จริง)
  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => {
          return caches.match(req, { ignoreSearch: true }).then((cachedRes) => {
            if (cachedRes) return cachedRes;
            if (url.pathname.endsWith('page2.html')) {
              return caches.match('./page2.html');
            }
            return caches.match('./index.html');
          });
        })
    );
    return;
  }

  // 3. สำหรับไฟล์สคริปต์ ฟอนต์ ไอคอน และแผนที่ ใช้ Stale-While-Revalidate (เปิดไวทันใจ)
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
        .catch(() => {
          return cachedRes || new Response('', { status: 408, statusText: 'Offline' });
        });

      return cachedRes || fetchPromise;
    })
  );
});