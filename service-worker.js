// アプリ本体のキャッシュ
const CACHE = 'syukatsu-os-v8';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './drive-sync.js',
  './data-validation.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
];

// 初回インストール
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

// 旧バージョンのキャッシュ整理
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('syukatsu-os-') && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// 通信とオフライン表示
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  url.hash = '';
  const assetURLs = ASSETS.map((path) => new URL(path, self.registration.scope).href);
  if (event.request.method !== 'GET' || !assetURLs.includes(url.href)) return;
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(event.request, response.clone());
        }
        return response;
      } catch {
        return (
          (await caches.match(event.request)) ||
          (event.request.mode === 'navigate'
            ? await caches.match('./index.html')
            : Response.error())
        );
      }
    })(),
  );
});
