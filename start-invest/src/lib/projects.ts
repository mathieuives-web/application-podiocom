import { prisma } from "@/lib/prisma";

const VAS_DESCRIPTION =
  "Sécurise les ventes de voitures d'occasion. Garages / marchands VO : à la remise des clés, sur téléphone, les papiers en photo (bon de commande, facture, CT, annonce, carte grise lue automatiquement), 34 photos guidées datées et scellées, signature de l'acheteur vérifiée par e-mail, dossier PDF verrouillé à vie. Quand un courrier d'assurance / mise en demeure arrive : litige ouvert depuis la livraison, avis technique sous 48 h ouvrées, un seul interlocuteur. Particuliers : dossier de vente signé, 29 € TTC. Offres : Sécurité 65 € HT/mois (12 mois, livraisons illimitées ; 10 garages fondateurs à 49 € HT/mois à vie), Sérénité 180 € HT/mois (6 litiges/an, dossier technique, revue des annonces), dossier technique complet 350 € HT à l'unité, présence à l'expertise sur devis.";
const VAS_NOTES =
  "Positionnement légal à respecter strictement : assistance technique et information juridique générale uniquement — pas de consultation juridique ni de rédaction d'actes (réservées aux avocats), pas de titre d'« expert en automobile ». Maquette du site : https://claude.ai/artifact/YQSTAxoi5H8CRxzQrT4uT1 . Premiers clients naturels : La Fabrique Automobile et Auto Rac Ives (garages du groupe).";

// Projets connus au démarrage (le fondateur les complète et en ajoute dans la page Projets).
const DEFAULTS = [
  {
    name: "CLEAN",
    description:
      "Marketplace de services d'entretien et de propreté pour particuliers et professionnels (maison, bureaux, Airbnb, vitres, jardin, véhicules, camping-cars, nautisme, BTP) : demandes, offres, missions, paiements Stripe Connect, preuves qualité. Application web (React/Vite, Supabase « Clean deal1 ») et mobile (Capacitor Android / iOS).",
    goal: "Lancement public avec paiements réels : Stripe de bout en bout (paiement, webhook, Connect, versement, remboursement), applications publiées sur l'App Store et le Play Store, premiers prestataires et clients actifs.",
    repo: "mathieuives-web/Clean",
    website: "https://cleanmarketplace.fr/",
    status: "EN_COURS",
    notes: "Ne jamais déployer le site contre l'ancien Supabase (xjuplwmkccmcjbpyiluu). Aucun secret dans les variables VITE_*. Suivre la liste « Ce qui reste à prouver avant lancement public » du README. Domaine cleanmarketplace.fr acheté et en ligne (vérifier qu'il pointe bien vers le bon projet Vercel et le Supabase « Clean deal1 »). À vérifier en priorité : le site annonce « une aide financière pouvant aller jusqu'à 50 % » — c'est le crédit d'impôt des services à la personne, qui n'est possible que pour des prestataires déclarés SAP et des services éligibles : préciser les conditions ou retirer la mention.",
  },
  {
    name: "Vente Auto Sécurité",
    description: VAS_DESCRIPTION,
    goal: "10 garages fondateurs abonnés (49 € HT/mois à vie), puis abonnements Sécurité / Sérénité réguliers et ventes « particuliers » à 29 € chaque semaine ; site venteautosecurite.fr qui convertit et se place sur Google (« PV de livraison voiture », « litige vente voiture occasion », « vice caché garage »).",
    repo: "mathieuives-web/vente-auto-securite",
    website: "https://venteautosecurite.fr/",
    status: "EN_COURS",
    notes: VAS_NOTES,
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
  if ((await prisma.project.count()) === 0) {
    for (const p of DEFAULTS) await prisma.project.create({ data: p }).catch(() => undefined);
    return;
  }
  // Site CLEAN : domaine acheté et en ligne.
  const clean = await prisma.project.findUnique({ where: { name: "CLEAN" } });
  if (clean && !clean.website) {
    const d = DEFAULTS.find((x) => x.name === "CLEAN")!;
    await prisma.project.update({ where: { id: clean.id }, data: { website: d.website, notes: clean.notes?.includes("cleanmarketplace.fr") ? clean.notes : d.notes } });
  }
  // Fiche Vente Auto Sécurité complétée (offres, prix, cadre légal) tant que le fondateur ne l'a pas réécrite.
  const vas = await prisma.project.findUnique({ where: { name: "Vente Auto Sécurité" } });
  if (vas && !vas.notes?.includes("Positionnement légal") && (!vas.description || vas.description.startsWith("Service pour garages VO"))) {
    const d = DEFAULTS.find((x) => x.name === "Vente Auto Sécurité")!;
    await prisma.project.update({ where: { id: vas.id }, data: { description: d.description, goal: d.goal, notes: [d.notes, vas.notes && !vas.notes.startsWith("Premier client naturel") ? vas.notes : null].filter(Boolean).join("\n") } });
  }
}
