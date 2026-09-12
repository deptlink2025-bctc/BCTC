/* Service worker: cache vỏ app để mở được khi mất mạng. KHÔNG cache API VNDirect —
 * số liệu nằm trong IndexedDB rồi. Đổi VERSION mỗi lần sửa file tĩnh để điện thoại nhận bản mới. */
const VERSION = "v1.0.0";
const CACHE = "bctc-radar-" + VERSION;
const SHELL = ["./", "index.html", "styles.css", "manifest.webmanifest", "data/seed.json",
  "js/metrics.js", "js/rules.js", "js/store.js", "js/finfo.js", "js/sync.js", "js/charts.js", "js/app.js",
  "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;            // API, font: đi thẳng mạng
  // vỏ app: mạng trước để nhận bản mới, mất mạng thì lấy cache
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))));
});
