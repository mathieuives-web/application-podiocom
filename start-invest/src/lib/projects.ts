import { prisma } from "@/lib/prisma";

// Projets connus au démarrage (le fondateur les complète et en ajoute dans la page Projets).
const DEFAULTS = [
  {
    name: "CLEAN",
    description:
      "Marketplace de services d'entretien et de propreté pour particuliers et professionnels (maison, bureaux, Airbnb, vitres, jardin, véhicules, camping-cars, nautisme, BTP) : demandes, offres, missions, paiements Stripe Connect, preuves qualité. Application web (React/Vite, Supabase « Clean deal1 ») et mobile (Capacitor Android / iOS).",
    goal: "Lancement public avec paiements réels : Stripe de bout en bout (paiement, webhook, Connect, versement, remboursement), applications publiées sur l'App Store et le Play Store, premiers prestataires et clients actifs.",
    repo: "mathieuives-web/Clean",
    website: null,
    status: "EN_COURS",
    notes: "Ne jamais déployer le site contre l'ancien Supabase (xjuplwmkccmcjbpyiluu). Aucun secret dans les variables VITE_*. Suivre la liste « Ce qui reste à prouver avant lancement public » du README.",
  },
  {
    name: "Vente Auto Sécurité",
    description:
      "Service pour garages VO et particuliers : PV de livraison signé par l'acheteur sur téléphone, pièces de la vente verrouillées, aide quand un litige arrive (courrier d'assurance). Particuliers : dossier de vente signé, 29 € TTC.",
    goal: "Premiers garages abonnés et ventes particuliers réguliers ; site venteautosecurite.fr qui convertit et se place sur Google.",
    repo: "mathieuives-web/vente-auto-securite",
    website: "https://venteautosecurite.fr/",
    status: "EN_COURS",
    notes: "Premier client naturel : La Fabrique Automobile (et Auto Rac Ives).",
  },
  {
    name: "Inspectly",
    description: null,
    goal: null,
    repo: null,
    website: null,
    status: "IDEE",
    notes: "À compléter par le fondateur : description, objectif, dépôt GitHub ou site.",
  },
];

export async function ensureDefaultProjects() {
  if ((await prisma.project.count()) > 0) return;
  for (const p of DEFAULTS) await prisma.project.create({ data: p }).catch(() => undefined);
}
