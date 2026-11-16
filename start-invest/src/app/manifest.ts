import type { MetadataRoute } from "next";

// Application installable sur le téléphone (« Ajouter à l'écran d'accueil »).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Start Invest – pilotage du groupe",
    short_name: "Start Invest",
    description: "Finances, atelier, agents IA et alertes du groupe Start Invest",
    start_url: "/aujourdhui",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0c0a09",
    theme_color: "#0c0a09",
    lang: "fr",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Aujourd'hui", url: "/aujourdhui" },
      { name: "Atelier", url: "/atelier" },
      { name: "Finances", url: "/finances" },
    ],
  };
}
