// Service Worker di CrudoDesign — abilita l'uso offline.
// Strategia: precache di tutti i file al primo caricamento (app shell),
// poi "cache-first" così l'app funziona senza rete.

const CACHE = 'crudodesign-v2';

// Tutti i file necessari all'app (percorsi relativi allo scope).
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './js/main.js',
  './js/doc.js',
  './js/brush.js',
  './js/fill.js',
  './js/color.js',
  './js/storage.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

// Installazione: scarica e memorizza tutti gli asset
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Attivazione: elimina le cache vecchie
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first con fallback alla rete (e aggiornamento cache)
self.addEventListener('fetch', (event) => {
  const req = event.request;
  // gestiamo solo GET dello stesso origine
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // salva in cache le nuove richieste valide dello stesso origine
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          // offline e non in cache: per le navigazioni, torna alla home
          if (req.mode === 'navigate') return caches.match('./index.html');
        });
    })
  );
});
