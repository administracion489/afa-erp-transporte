// public/sw.js — Caché offline del shell para las apps conductor/pasajero (estilo Uber).
// Tras la 1ª carga, la interfaz queda en el dispositivo: arranques instantáneos y
// resistentes a microcortes de red. SOLO intercepta estáticos de Next y la navegación
// de /conductor y /pasajero. El resto (ERP, APIs, Supabase) va directo a la red.

// Súbele el número en cada deploy que deba invalidar assets cacheados: el handler
// `activate` borra todos los cachés cuya clave no termine en VERSION, forzando que los
// navegadores ya instalados re-descarguen los chunks de Next (evita quedar pegado en una
// versión vieja del ERP/app tras un deploy).
const VERSION = "afa-v3";
const STATIC_CACHE = `afa-static-${VERSION}`;
const SHELL_CACHE = `afa-shell-${VERSION}`;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;

  // 1) Estáticos inmutables de Next → cache-first (instantáneo).
  if (url.pathname.startsWith("/_next/static/")) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res && res.status === 200) (await caches.open(STATIC_CACHE)).put(req, res.clone());
      return res;
    })());
    return;
  }

  // 2) Navegación de las apps (conductor/pasajero) → network-first con fallback a caché.
  const esApp = req.mode === "navigate" &&
    (url.pathname.startsWith("/conductor") || url.pathname.startsWith("/pasajero"));
  if (esApp) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.status === 200) (await caches.open(SHELL_CACHE)).put(req, res.clone());
        return res;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        throw new Error("offline sin caché");
      }
    })());
    return;
  }

  // 3) Todo lo demás (ERP, APIs, etc.): red normal, sin interceptar.
});
