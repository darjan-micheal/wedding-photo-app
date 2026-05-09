const CACHE_NAME = 'weddingsnap-v1';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/manifest.json'
];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)));
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // Network-Only for dynamic data and Sockets
    if (url.pathname.startsWith('/api/') || 
        url.pathname.startsWith('/photos/') || 
        url.pathname.startsWith('/download/') ||
        url.pathname.startsWith('/socket.io/')) {
        return; // Browser handles it normally
    }

    // Cache-First for static shell
    e.respondWith(
        caches.match(e.request).then(response => response || fetch(e.request))
    );
});