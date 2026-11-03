const CACHE_NAME = 'pea-smart-tools-v49';

// ไฟล์หลักที่ต้องการเก็บไว้ให้เปิดตอนออฟไลน์ได้ทันที
const STATIC_ASSETS = [
  './',
  './index.html',
  './page2.html',
  './manifest-main.json',
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Prompt:wght@300;400;500;600;700&display=swap',
  'https://cdn.jsdelivr.net/npm/sortablejs@latest/Sortable.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
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

  // ข้ามคำขอที่เป็น POST (เช่น การส่งงานขึ้น Google Sheets)
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1. หากเป็น API ซิงค์ข้อมูลสด ให้วิ่งตรงผ่านอินเทอร์เน็ตเสมอ (ห้ามแคช)
  if (BYPASS_HOSTS.some((host) => url.hostname.includes(host))) {
    return;
  }

  // 2. สำหรับหน้าเว็บ HTML (index.html, page2.html) ใช้ระบบ Network-First
  // (ถ้ามีเน็ตให้ดึงโค้ดล่าสุดเสมอและอัปเดตแคช ถ้าไม่มีเน็ตให้ดึงจากแคชมาเปิดแทน)
  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          return networkRes;
        })
        .catch(() => {
          return caches.match(req).then((cachedRes) => {
            return cachedRes || caches.match('./index.html');
          });
        })
    );
    return;
  }

  // 3. สำหรับไฟล์สคริปต์ ฟอนต์ และไอคอน ใช้ Stale-While-Revalidate (เปิดไวทันใจ)
  event.respondWith(
    caches.match(req).then((cachedRes) => {
      const fetchPromise = fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
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
