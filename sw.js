const CACHE_NAME = 'pea-smart-tools-v91';

// 1. ไฟล์หลักของแอป (บังคับดึงสดจากเซิร์ฟเวอร์ทุกครั้งที่เปลี่ยนเลขเวอร์ชัน CACHE_NAME)
const STATIC_ASSETS = [
  './',
  './index.html',
  './page2.html',
  './manifest-main.json',
  './manifest.json'
];

// 2. ไลบรารีจำเป็นสำหรับเปิดใช้งานหน้าฟอร์มและแผนที่ SCADA ตอนออฟไลน์ทันทีหลังอัปเดต
const CDN_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Prompt:wght@300;400;500;600;700&display=swap',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/mqtt@5.3.4/dist/mqtt.min.js',
  'https://cdn.jsdelivr.net/npm/sortablejs@latest/Sortable.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
];

// 3. รายชื่อโดเมน API ข้อมูลสด เส้นทางถนน และแผ่นแผนที่ที่ให้วิ่งตรงผ่านอินเทอร์เน็ตเสมอ
const BYPASS_HOSTS = [
  'script.google.com',
  'script.googleusercontent.com',
  'api.open-meteo.com',
  'generativelanguage.googleapis.com',
  'nominatim.openstreetmap.org',
  'router.project-osrm.org',
  'routing.openstreetmap.de',
  'api.allorigins.win',
  'api.codetabs.com',
  'api.microlink.io',
  'corsproxy.io',
  'unshorten.me',
  'mt0.google.com',
  'mt1.google.com',
  'mt2.google.com',
  'mt3.google.com',
  'maps.googleapis.com',
  'maps.gstatic.com',
  'tile.openstreetmap.org',
  'embed.windy.com'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // ดึงไฟล์ HTML/Manifest ใหม่จากเซิร์ฟเวอร์โดยข้าม HTTP Cache เดิมของเบราว์เซอร์
      const localTasks = STATIC_ASSETS.map(async (url) => {
        try {
          const res = await fetch(new Request(url, { cache: 'reload' }));
          if (res && res.ok) await cache.put(url, res);
        } catch (e) {}
      });

      // เก็บไลบรารี CDN หลักไว้กันเหนียวตอนออกหน้างานออฟไลน์
      const cdnTasks = CDN_ASSETS.map(async (url) => {
        try {
          const res = await fetch(new Request(url, { mode: 'no-cors' }));
          if (res && (res.status === 200 || res.type === 'opaque')) {
            await cache.put(url, res);
          }
        } catch (e) {}
      });

      await Promise.allSettled([...localTasks, ...cdnTasks]);
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

  // ข้ามโปรโตคอลพิเศษ เช่น blob:, data:, wss:, chrome-extension:
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 1. หากเป็น API ซิงค์ข้อมูลสด เส้นทางถนน หรือแผ่นแผนที่ ให้วิ่งตรงผ่านอินเทอร์เน็ตเสมอ
  if (BYPASS_HOSTS.some((host) => url.hostname.includes(host))) {
    return;
  }

  const isSameOrigin = (url.origin === self.location.origin);

  // ข้ามการนำทางข้ามโดเมนภายนอก (เช่น เปิดลิงก์ Google Maps / LINE / Iframe นอกระบบ)
  if (req.mode === 'navigate' && !isSameOrigin) {
    return;
  }

  // 2. หน้าเว็บ HTML ในโดเมนของเราเอง: ดึงโค้ดล่าสุดเสมอ และซิงค์คีย์แคชให้ตรงกันแม้มีพารามิเตอร์ต่อท้ายลิงก์
  if (isSameOrigin && (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/'))) {
    const cleanUrl = url.origin + url.pathname;

    event.respondWith((async () => {
      try {
        const networkRes = await fetch(req.url, { cache: 'no-cache' });
        if (networkRes && networkRes.status === 200) {
          const copyMain = networkRes.clone();
          const copyAlias = networkRes.clone();

          caches.open(CACHE_NAME).then((cache) => {
            cache.put(cleanUrl, copyMain);
            // ซิงค์แคชระหว่าง './' กับ './index.html' ให้เป็นเวอร์ชันเดียวกันเสมอ
            if (url.pathname.endsWith('/index.html')) {
              cache.put(url.origin + url.pathname.replace(/index\.html$/, ''), copyAlias);
            } else if (url.pathname.endsWith('/')) {
              cache.put(cleanUrl + 'index.html', copyAlias);
            }
          }).catch(() => {});

          return networkRes;
        }
        throw new Error('Fallback to cache');
      } catch (err) {
        const cachedRes = (await caches.match(cleanUrl, { ignoreSearch: true })) ||
                          (await caches.match(req, { ignoreSearch: true }));
        if (cachedRes) return cachedRes;

        if (url.pathname.includes('page2.html')) {
          return (await caches.match('./page2.html')) || new Response('Offline', { status: 503 });
        }
        return (await caches.match('./index.html')) ||
               (await caches.match('./')) ||
               new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // 3. ไฟล์สคริปต์ ฟอนต์ และไอคอนภายนอก: โหลดไวจากแคชพร้อมอัปเดตเบื้องหลัง และไม่แครชเมื่อออฟไลน์
  event.respondWith((async () => {
    const cachedRes = await caches.match(req);

    const networkPromise = fetch(req)
      .then((networkRes) => {
        if (networkRes && (networkRes.status === 200 || networkRes.type === 'opaque')) {
          const resClone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone)).catch(() => {});
        }
        return networkRes;
      })
      .catch(() => null);

    if (cachedRes) return cachedRes;

    const liveRes = await networkPromise;
    return liveRes || new Response('', { status: 503, statusText: 'Offline' });
  })());
});
