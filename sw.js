/* Offline support for the landing page and the printables page (service worker).
   Same approach as the games' sw.js: the first visit caches the page and everything it loaded, then serves it from
   the cache and refreshes it in the background when online (except the font files, which never change). This worker's scope is the whole site, so it handles
   only the landing page's own files and Google Fonts and leaves every game path to the network (each game that
   works offline has its own sw.js, which takes precedence for its folder).
   On a development server (this computer, *.localhost / *.test, or the laptop's address on the home network) it's the
   other way round: everything comes from the server first and the cache is only the fallback when the server is
   stopped, so an edit shows on the next reload and offline still works.
   Bump CACHE only when this file's logic changes; activate deletes the landing page's older caches. */
const PREFIX = 'landing-';
const CACHE = PREFIX + 'v4';
const HOST = self.location.hostname;
const DEV = HOST === 'localhost' || HOST === '127.0.0.1' || HOST === '[::1]' || HOST.endsWith('.localhost') || HOST.endsWith('.test')
  || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(HOST);
const SHELL = ['./', 'index.html', 'print.html', 'manifest.webmanifest', 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'icon-512.png'];
const OWN = new Set(SHELL.map((p) => new URL(p, self.registration.scope).pathname));
const mine = (url) => {
  const u = new URL(url);
  if (u.origin === self.location.origin) return OWN.has(u.pathname);
  return u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com';
};

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// files whose content never changes at the same URL: ?v=N is bumped whenever the file changes, and Google's font
// files are named by their content
const fixed = (url) => { const u = new URL(url); return u.searchParams.has('v') || u.hostname === 'fonts.gstatic.com'; };

// never an unreadable (opaque) copy: it counts as several MB against the shared storage quota, and every file this
// worker handles comes from this site or Google Fonts, which answer the CORS request store() makes
const keep = (res) => res.ok && !res.redirected;

// drop the copies of a file kept under another query (each ?v= bump is a new cache key); pages are left alone, so
// the shell's './' stays as the offline fallback
async function prune(cache, url) {
  const u = new URL(url);
  if (/(\/|\.html)$/.test(u.pathname)) return;
  for (const req of await cache.keys(url, { ignoreSearch: true, ignoreVary: true })) {
    const r = new URL(req.url);
    if (r.origin === u.origin && r.pathname === u.pathname && r.search !== u.search) await cache.delete(req, { ignoreVary: true });
  }
}

async function save(cache, req, res) {
  await cache.put(req, res);
  await prune(cache, typeof req === 'string' ? req : req.url);
}

async function store(cache, url) {
  if (await cache.match(url, { ignoreVary: true })) return;
  try {
    const res = await fetch(url, { mode: 'cors', cache: 'no-cache' }).catch(() => fetch(url, { mode: 'no-cors', cache: 'no-cache' }));
    if (keep(res)) await save(cache, url, res);
  } catch { /* offline or blocked: try again on a later visit */ }
}

// the font files named in a cached Google Fonts stylesheet (the page's list can miss them when the browser
// already had them in memory)
async function storeFonts(cache) {
  for (const req of await cache.keys()) {
    if (!req.url.includes('fonts.googleapis.com/css')) continue;
    const css = await (await cache.match(req)).text().catch(() => '');
    for (const m of css.matchAll(/url\((https:[^)]+)\)/g)) await store(cache, m[1]);
  }
}

self.addEventListener('message', (e) => {   // { cache: [urls] } from the page: everything it loaded
  const urls = e.data && Array.isArray(e.data.cache) ? e.data.cache.filter(mine) : [];
  if (urls.length) e.waitUntil(caches.open(CACHE).then((c) => Promise.all(urls.map((u) => store(c, u))).then(() => storeFonts(c))));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith('http') || !mine(req.url)) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const nav = req.mode === 'navigate';
    const hit = await cache.match(req, { ignoreSearch: nav, ignoreVary: true });
    if (hit && !nav && !DEV && fixed(req.url)) return hit;   // can't have changed: no need to ask the server
    // (the refresh always asks the server, so the browser's own cache can't hand back a stale copy: a local server
    // sends no caching rules, and a page would otherwise stay old for days)
    const net = fetch(nav ? req.url : req, { cache: 'no-cache' }).then((res) => {
      if (keep(res)) e.waitUntil(save(cache, req, res.clone()).catch(() => {}));
      return res;
    });
    if (DEV) return net.catch(async () => hit || (nav && await cache.match('./')) || Response.error());   // dev: server first
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }   // cached: answer now, refresh in the background
    return net.catch(async () => (nav && await cache.match('./')) || Response.error());
  }));
});
