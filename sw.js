// Offline support. Registered from index.html as sw.js?v=<deploy hash> (tools/stamp.py),
// so every deploy gets a fresh cache and the old one is dropped.
const V = new URL(self.location).searchParams.get('v') || 'dev';
const CACHE = `fraczilla-${V}`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('fraczilla-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const keep = (req, res) => {
  if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
  return res;
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // the page: network first, so a new deploy shows at once; the cached copy only when offline
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => keep(new Request('./'), res)).catch(() => caches.match('./')));
    return;
  }
  // our files carry ?v=<hash>, so a URL never changes its content: cache first. The font too.
  if (url.origin === self.location.origin || /(^|\.)(gstatic|googleapis)\.com$/.test(url.hostname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => keep(req, res))));
  }
});
