// チアフル会計 Service Worker
const CACHE = 'cheerful-kaikei-v21';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/db.js',
  './js/export.js',
  './js/app.js',
  './lib/xlsx.full.min.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// HTML/CSS/JSはネットワーク優先（更新が即座に反映される）
// 画像・ライブラリはキャッシュ優先（変更頻度低くサイズ大）
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const cacheFirst = /\.(png|jpg|jpeg|webp|svg|woff|woff2|ico)$/i.test(url.pathname)
    || url.pathname.includes('/lib/');
  if (cacheFirst) {
    // キャッシュ優先
    e.respondWith(
      caches.match(e.request).then((cached) => cached || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }))
    );
  } else {
    // ネットワーク優先（オフライン時のみキャッシュ）
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request))
    );
  }
});
