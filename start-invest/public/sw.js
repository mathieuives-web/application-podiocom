// Service worker minimal : rend l'application installable et affiche une page claire hors connexion.
// Aucune donnée n'est mise en cache (chiffres, factures, salariés restent uniquement sur le serveur).
const OFFLINE = "/offline.html";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open("si-offline-v2").then((c) => c.add(OFFLINE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== "si-offline-v2").map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  // Seulement l’ouverture d’une page (GET) : les envois de formulaire (connexion, déconnexion...) ne passent jamais par ici.
  if (e.request.mode !== "navigate" || e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});
