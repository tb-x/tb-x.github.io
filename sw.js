/* Offline support for the landing page (service worker).
   Same approach as the games' sw.js: the first visit caches the page and everything it loaded, then serves it from
   the cache and refreshes it in the background when online. This worker's scope is the whole site, so it handles
   only the landing page's own files and Google Fonts and leaves every game path to the network (each game that
   works offline has its own sw.js, which takes precedence for its folder).
   Bump CACHE only when this file's logic changes; activate deletes the landing page's older caches. */
const PREFIX = 'landing-';
const CACHE = PREFIX + 'v2';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'icon-512.png'];
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

const keep = (res) => (res.ok && !res.redirected) || res.type === 'opaque';

async function store(cache, url) {
  if (await cache.match(url, { ignoreVary: true })) return;
  try {
    const res = await fetch(url, { mode: 'cors', cache: 'no-cache' }).catch(() => fetch(url, { mode: 'no-cors', cache: 'no-cache' }));
    if (keep(res)) await cache.put(url, res);
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
    // (the refresh always asks the server, so the browser's own cache can't hand back a stale copy: a local server
    // sends no caching rules, and a page would otherwise stay old for days)
    const net = fetch(nav ? req.url : req, { cache: 'no-cache' }).then((res) => { if (keep(res)) cache.put(req, res.clone()); return res; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }   // cached: answer now, refresh in the background
    return net.catch(async () => (nav && await cache.match('./')) || Response.error());
  }));
});
