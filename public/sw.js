// Service worker de Juez.
//
// Reglas de oro aqui:
//  1. /api/* NUNCA se cachea. Las respuestas del juez son de un solo uso y una
//     respuesta guardada seria peor que ninguna.
//  2. El HTML va primero a la red. Si esta app queda detras de Cloudflare
//     Access, la red puede devolver una redireccion a la pantalla de login:
//     esas respuestas no se guardan jamas, o acabariamos sirviendo el login
//     como si fuera la app.
//  3. Las fuentes y los iconos se sirven de cache y se refrescan por detras.

const VERSION = "juez-v1";
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

const PRECACHE = [
  "/",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/favicon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  );
});

function esCacheable(res) {
  return res && res.ok && res.status === 200 && !res.redirected && res.type !== "opaqueredirect";
}

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // 1. La API siempre a la red, sin tocar la cache
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return;

  // 2. Navegacion: red primero, cache como red de seguridad si no hay conexion
  if (request.mode === "navigate") {
    e.respondWith(
      fetch(request)
        .then((res) => {
          if (esCacheable(res)) {
            const copia = res.clone();
            caches.open(SHELL).then((c) => c.put("/", copia));
          }
          return res;
        })
        .catch(() => caches.match("/").then((r) => r || Response.error()))
    );
    return;
  }

  // 3. Fuentes, iconos e imagenes de carta: cache primero, refresco por detras
  const estatico =
    url.origin === location.origin ||
    url.hostname.endsWith("fonts.googleapis.com") ||
    url.hostname.endsWith("fonts.gstatic.com") ||
    url.hostname.endsWith("scryfall.io");

  if (!estatico) return;

  e.respondWith(
    caches.match(request).then((guardada) => {
      const red = fetch(request)
        .then((res) => {
          if (esCacheable(res)) {
            const copia = res.clone();
            caches.open(ASSETS).then((c) => c.put(request, copia));
          }
          return res;
        })
        .catch(() => guardada);
      return guardada || red;
    })
  );
});
