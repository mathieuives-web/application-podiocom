// Service worker minimal : rend l'application installable et affiche une page claire hors connexion.
// Aucune donnée n'est mise en cache (chiffres, factures, salariés restent uniquement sur le serveur).
const OFFLINE = "/offline.html";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open("si-offline-v1").then((c) => c.add(OFFLINE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== "si-offline-v1").map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return; // tout le reste passe directement au réseau
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});
