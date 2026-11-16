import { prisma } from "@/lib/prisma";

const VAS_DESCRIPTION =
  "Sécurise les ventes de voitures d'occasion. Garages / marchands VO : à la remise des clés, sur téléphone, les papiers en photo (bon de commande, facture, CT, annonce, carte grise lue automatiquement), 34 photos guidées datées et scellées, signature de l'acheteur vérifiée par e-mail, dossier PDF verrouillé à vie. Quand un courrier d'assurance / mise en demeure arrive : litige ouvert depuis la livraison, avis technique sous 48 h ouvrées, un seul interlocuteur. Particuliers : dossier de vente signé, 29 € TTC. Offres : Sécurité 65 € HT/mois (12 mois, livraisons illimitées ; 10 garages fondateurs à 49 € HT/mois à vie), Sérénité 180 € HT/mois (6 litiges/an, dossier technique, revue des annonces), dossier technique complet 350 € HT à l'unité, présence à l'expertise sur devis.";
const VAS_NOTES =
  "Positionnement légal à respecter strictement : assistance technique et information juridique générale uniquement — pas de consultation juridique ni de rédaction d'actes (réservées aux avocats), pas de titre d'« expert en automobile ». Maquette du site : https://claude.ai/artifact/YQSTAxoi5H8CRxzQrT4uT1 . Premiers clients naturels : La Fabrique Automobile et Auto Rac Ives (garages du groupe).";

const INSPECTLY_DESCRIPTION =
  "Marketplace d'inspection avant achat : l'acheteur poste une mission (ex. une voiture d'occasion vue sur une annonce, avec ville et lien), un expert de la zone et de la catégorie lui est proposé (matching), il réserve, l'expert inspecte et un rapport structuré est produit (note globale, sections notées, points rouges, points positifs, valeur estimée, recommandation d'achat), puis notes croisées acheteur / expert. Application web mobile (PWA) en Next.js 14 + Supabase (profils, missions, avis, temps réel), IA Claude pour le rapport et le matching (repli automatique sans clé). Paiement Stripe pas encore branché (prévu dès l'immatriculation de la société).";
const INSPECTLY_NOTES =
  "Code reçu en archive « inspectly-glisser » (pas encore de dépôt GitHub : en créer un pour que le chef de projet le suive). FAILLES À CORRIGER AVANT TOUT VRAI CLIENT : (1) l'API /api/ai/report utilise la clé service_role sans vérifier qui appelle : n'importe qui peut marquer n'importe quelle mission terminée, y écrire un rapport et choisir l'expert — exiger la session Supabase et vérifier que l'appelant est l'expert de la mission ; (2) règle Supabase « maj par les parties ou acceptation » : tout utilisateur connecté peut modifier TOUTE mission en attente (prix, acheteur, rapport...) — limiter l'acceptation à la seule colonne expert_id / statut, via une fonction serveur ; (3) les avis : n'importe qui peut noter n'importe qui sans mission commune — exiger une mission terminée entre l'auteur et la cible, un seul avis par mission. Aussi : confirmation d'e-mail désactivée pour la démo, à réactiver au lancement ; position (lat/lng) des profils visible de tous les connectés. Cadre légal : ne pas utiliser le titre réglementé d'« expert en automobile » sans qualification ; CGU, assurance RC pro des inspecteurs, statut d'intermédiaire de paiement (Stripe Connect).";

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
    description: INSPECTLY_DESCRIPTION,
    goal: "Démo investisseur réussie, puis lancement avec paiement Stripe (Connect : l'acheteur paie, l'expert est versé après le rapport) et premiers experts actifs sur l'automobile autour de Rennes.",
    repo: null,
    website: null,
    status: "EN_COURS",
    notes: INSPECTLY_NOTES,
  },
];

export async function ensureDefaultProjects() {
  await ensureKnownPresence().catch(() => undefined);
  if ((await prisma.project.count()) === 0) {
    for (const p of DEFAULTS) await prisma.project.create({ data: p }).catch(() => undefined);
    return;
  }
  // Inspectly : fiche complétée à partir du code reçu.
  const insp = await prisma.project.findUnique({ where: { name: "Inspectly" } });
  if (insp && !insp.description) {
    const d = DEFAULTS.find((x) => x.name === "Inspectly")!;
    await prisma.project.update({ where: { id: insp.id }, data: { description: d.description, goal: insp.goal ?? d.goal, status: insp.status === "IDEE" ? "EN_COURS" : insp.status, notes: d.notes } });
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

// ------------------------------------------------------------------ présence en ligne connue des sociétés

const SITE_BAR_RESTO = "https://lafabrique-lusine-montreuil.vercel.app/";
const PRESENCE: Record<string, { website: string; instagram?: string; facebook?: string; googleBusiness?: string }> = {
  "La Fabrique Restaurant": {
    website: SITE_BAR_RESTO,
    instagram: "https://www.instagram.com/restaurant_lafabrique/",
    facebook: "https://www.facebook.com/people/Restaurant-La-Fabrique/61552648811250/",
    googleBusiness: "https://www.google.com/maps/place/?q=place_id:ChIJawcZwk7DDkgRwuc6tCQvFk0",
  },
  "Le Bar L'Usine": {
    website: SITE_BAR_RESTO,
    instagram: "https://www.instagram.com/lusine_bar_montreuil_sur_ille/",
    googleBusiness: "https://www.google.com/maps/place/?q=place_id:ChIJUeEjyirDDkgRCrWhG9NS9e4",
  },
};

const SITE_AUDIT = `Audit initial du site commun ${SITE_BAR_RESTO} (16/11/2026) — à traiter dans l'ordre :
- Le site est sur une adresse vercel.app : acheter un vrai nom de domaine (ex. lafabrique-lusine.fr) et le relier au projet Vercel ; ajouter <link rel="canonical"> vers ce domaine. C'est le frein n°1 au référencement.
- Données structurées : les « @id », « url » et « image » sont relatifs (/#pizzeria, /img/...) : Google les veut en adresses complètes. og:image aussi est relative : les aperçus Facebook / WhatsApp / Instagram ne s'affichent pas.
- Retirer « aggregateRating » (notes 4,8 et 5,0) des données structurées : Google n'accepte pas les notes affichées par l'établissement sur son propre site pour un restaurant / bar (pas d'étoiles, risque de pénalité). Garder les notes en texte visible.
- Aucun prix de pizza sur le site (seulement la carte du bar) : mettre la carte complète avec prix, idéalement une page /carte (requêtes « pizzeria Montreuil-sur-Ille carte / menu »).
- Réservation uniquement par téléphone : ajouter une réservation en ligne (formulaire ou TheFork / Google Réserver) et un bouton « Commander à emporter » ; mesurer les clics.
- Agenda : baliser chaque soirée en données structurées « Event » (date, heure, lieu, prix) pour apparaître dans les résultats d'événements Google ; une page par grosse soirée.
- Mots-clés locaux à travailler (titres, textes, page séminaire) : pizzeria Montreuil-sur-Ille, pizza à emporter Saint-Aubin-d'Aubigné / Melesse / Chevaigné / Saint-Germain-sur-Ille, bar à cocktails nord de Rennes, salle de séminaire près de Rennes, privatisation salle anniversaire Ille-et-Vilaine, traiteur pizza Rennes.
- Vérifier sitemap.xml et robots.txt, puis déclarer le site dans Google Search Console ; lier le site aux deux fiches Google.
- Polices Google Fonts chargées depuis Google : les héberger sur le site (vitesse et RGPD).
- Points forts à garder : titre et description bons, FAQ balisée, horaires, téléphone et adresse visibles, liens « Laisser un avis », mention Loi Évin.`;

/** Renseigne les sites / réseaux connus si le fondateur ne l'a pas fait, et donne l'audit initial aux agents Site & réseaux. */
export async function ensureKnownPresence() {
  for (const [name, p] of Object.entries(PRESENCE)) {
    const c = await prisma.company.findFirst({ where: { name } });
    if (!c) continue;
    const data: Record<string, string> = {};
    if (!c.website) data.website = p.website;
    if (!c.instagram && p.instagram) data.instagram = p.instagram;
    if (!c.facebook && p.facebook) data.facebook = p.facebook;
    if (!c.googleBusiness && p.googleBusiness) data.googleBusiness = p.googleBusiness;
    if (Object.keys(data).length) await prisma.company.update({ where: { id: c.id }, data });
  }
  for (const agent of ["web-reseaux-fabrique-restaurant", "web-reseaux-bar-lusine"]) {
    const mem = await prisma.agentMemory.findUnique({ where: { agent } });
    if (!mem) await prisma.agentMemory.create({ data: { agent, content: `${SITE_AUDIT}\n- Le site est commun à La Fabrique (pizzeria) et L'Usine (bar) : se coordonner avec l'autre agent Site & réseaux.` } });
  }
}
