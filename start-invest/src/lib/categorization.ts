import Anthropic from "@anthropic-ai/sdk";
import { trackAiSpend } from "@/lib/ai-cost";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { prisma } from "@/lib/prisma";
import { INTERNAL } from "@/lib/finance";

// Classement comptable des opérations bancaires.
// 1) Chaque libellé est réduit à une « clé » (sans dates, numéros de carte, références) ;
// 2) une clé connue (règle) donne directement sa catégorie ;
// 3) les clés inconnues sont classées par l'IA, par lots, puis mémorisées comme règles ;
// 4) une correction manuelle crée une règle « MANUEL » prioritaire.

export const CATEGORIES_IN = [
  "Ventes / encaissements clients",
  "Encaissements carte (TPE)",
  "Dépôts d'espèces",
  "Loyers perçus",
  "Commissions dépôt-vente",
  "Remboursements reçus",
  "Subventions / aides",
  "Apports / prêts reçus",
  "Autres entrées",
] as const;

export const CATEGORIES_OUT = [
  "Loyer",
  "Électricité / gaz / eau",
  "Salaires",
  "Charges sociales (URSSAF, retraite, mutuelle)",
  "Impôts et taxes",
  "TVA",
  "Assurances",
  "Remboursement d'emprunt",
  "Leasing / location de matériel",
  "Achats de marchandises",
  "Achats de véhicules",
  "Pièces et fournitures auto",
  "Achats alimentaires",
  "Boissons",
  "Carburant",
  "Entretien / réparations",
  "Téléphone / internet",
  "Logiciels / abonnements",
  "Honoraires (comptable, avocat...)",
  "Publicité / marketing",
  "Frais bancaires",
  "Intérêts / agios / financement de stock",
  "Transport / déplacements",
  "Repas / réceptions",
  "Fournitures / petit équipement",
  "Cartes grises (ANTS)",
  "Reversements aux vendeurs (dépôt-vente)",
  "Retraits d'espèces",
  "Rémunération / prélèvements du dirigeant",
  "Autres dépenses",
] as const;

export const ALL_CATEGORIES = [...CATEGORIES_IN, ...CATEGORIES_OUT, INTERNAL];

/** Clé d'un libellé : majuscules, sans accents, sans chiffres longs, dates, références ni numéros de carte. */
export function labelKey(label: string) {
  return label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\b(CB|CARTE|PAIEMENT|PRLV|PRELEVEMENT|SEPA|VIR|VIREMENT|INST|INSTANTANE|RECU|EMIS|FACTURE|FACT|REF|MANDAT|ECH|ECHEANCE|DU|LE|DE|DES|LA|X\d+)\b/g, " ")
    .replace(/\d{2}[/.-]\d{2}([/.-]\d{2,4})?/g, " ")
    .replace(/[A-Z]*\d[A-Z0-9]*/g, " ")
    .replace(/[^A-Z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 1)
    .slice(0, 4)
    .join(" ");
}

const upperPlain = (n: string) => n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z ]+/g, " ").replace(/\s+/g, " ").trim();
// Noms de compte génériques (« Compte courant », « Compte pro »...) : ils apparaissent dans des libellés de clients.
const GENERIC = /^((COMPTE|CPT|COURANT|PRINCIPAL|PRO|PROFESSIONNEL|EPARGNE|LIVRET|BANCAIRE|BANQUE|CHEQUES?|CARTE|SEQUESTRE|PRET|DEPOT|VENTE|EUR|EUROS)\s*)+$/;

/** Noms et IBAN des comptes du groupe, par société, pour reconnaître les virements entre sociétés du groupe. */
async function groupMarkers() {
  const [companies, accounts] = await Promise.all([
    prisma.company.findMany({ select: { id: true, name: true, activity: true } }),
    prisma.bankAccount.findMany({ select: { companyId: true, name: true, iban: true } }),
  ]);
  const names = [...companies.map((c) => ({ companyId: c.id, n: upperPlain(c.name) })), ...accounts.map((a) => ({ companyId: a.companyId, n: upperPlain(a.name) }))].filter(
    (x) => x.n.length >= 6 && !GENERIC.test(x.n)
  );
  const ibans = accounts.map((a) => ({ companyId: a.companyId, iban: (a.iban ?? "").replace(/\s/g, "").toUpperCase() })).filter((i) => i.iban.length > 10);
  // Sociétés immobilières du groupe : les virements que les autres sociétés leur font sont des LOYERS, pas des virements internes.
  const landlords = new Set(companies.filter((c) => /\bsci\b|immobili|foncier|patrimoine/i.test(`${c.name} ${c.activity ?? ""}`)).map((c) => c.id));
  return { names, ibans, landlords };
}

/** Société du groupe à l'autre bout d'un virement (null si ce n'est pas un virement du groupe). */
function groupCounterpart(label: string, companyId: string, markers: Awaited<ReturnType<typeof groupMarkers>>): string | null {
  const L = label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ");
  if (!/\bVIR|VIREMENT|TRANSFERT\b/.test(L)) return null;
  const compact = L.replace(/\s/g, "");
  const byIban = markers.ibans.find((i) => compact.includes(i.iban));
  if (byIban) return byIban.companyId;
  // Le nom de SA PROPRE société figure souvent dans le libellé d'un paiement client : seul le nom d'une AUTRE société du groupe compte.
  return markers.names.find((m) => m.companyId !== companyId && L.includes(m.n))?.companyId ?? null;
}

/**
 * Catégorie d'un virement entre comptes du groupe : virement entre comptes de la MÊME société = interne ;
 * vers / depuis la SCI = loyer (charge pour l'occupant, recette pour la SCI) ; autre société du groupe = interne.
 */
function groupFlowCategory(label: string, companyId: string, amount: number, markers: Awaited<ReturnType<typeof groupMarkers>>): string | null {
  const other = groupCounterpart(label, companyId, markers);
  if (!other) return null;
  if (other !== companyId) {
    if (markers.landlords.has(companyId) && amount > 0) return "Loyers perçus";
    if (markers.landlords.has(other) && amount < 0) return "Loyer";
  }
  return INTERNAL;
}

function isInternal(label: string, companyId: string, markers: Awaited<ReturnType<typeof groupMarkers>>) {
  return groupCounterpart(label, companyId, markers) !== null;
}

// Anciennes catégories (avant le classement comptable) -> nouvelles.
const LEGACY: Record<string, string> = {
  "Péages & parking": "Transport / déplacements",
  "Entretien véhicules": "Entretien / réparations",
  "Charges sociales": "Charges sociales (URSSAF, retraite, mutuelle)",
  "Impôts & taxes": "Impôts et taxes",
  "Logiciels & abonnements": "Logiciels / abonnements",
  "Emprunts & leasing": "Remboursement d'emprunt",
  "Énergie & eau": "Électricité / gaz / eau",
  "Pièces auto": "Pièces et fournitures auto",
  "Encaissements clients": "Ventes / encaissements clients",
  Équipement: "Fournitures / petit équipement",
  Prestataires: "Autres dépenses",
  "Honoraires & juridique": "Honoraires (comptable, avocat...)",
  Transport: "Transport / déplacements",
};

/** Applique les règles connues (MANUEL d'abord, puis règles de la société, puis du groupe). */
export async function applyRules(companyId?: string) {
  const [rules, txs, markers] = await Promise.all([
    prisma.categoryRule.findMany(),
    prisma.bankTransaction.findMany({
      where: { ...(companyId ? { companyId } : {}), account: { excluded: false } },
      select: { id: true, label: true, amount: true, category: true, companyId: true },
    }),
    groupMarkers(),
  ]);
  const byKey = new Map<string, (typeof rules)[number][]>();
  for (const r of rules) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  let changed = 0;
  for (const t of txs) {
    let cat: string | null = null;
    const groupCat = groupFlowCategory(t.label, t.companyId, t.amount, markers);
    if (groupCat) cat = groupCat;
    else {
      const key = labelKey(t.label);
      const candidates = key ? byKey.get(key) ?? [] : []; // libellé sans mot (que des chiffres) : aucune règle ne s'applique
      const pick =
        candidates.find((r) => r.source === "MANUEL" && r.companyId === t.companyId) ??
        candidates.find((r) => r.source === "MANUEL" && r.companyId === "") ??
        candidates.find((r) => r.companyId === t.companyId) ??
        candidates.find((r) => r.companyId === "");
      if (pick) cat = pick.category;
      else if (t.category && LEGACY[t.category]) cat = LEGACY[t.category];
    }
    // Une catégorie de sortie ne s'applique pas à une entrée (et inversement) : on garde le sens de l'argent.
    if (cat && cat !== INTERNAL && !groupCat) {
      const isIn = (CATEGORIES_IN as readonly string[]).includes(cat);
      if (isIn !== t.amount > 0) cat = null;
    }
    if (cat && cat !== t.category) {
      await prisma.bankTransaction.update({ where: { id: t.id }, data: { category: cat } });
      changed++;
    }
  }
  return changed + (await matchVehicleFlows(companyId));
}

const Classification = z.object({
  classements: z.array(z.object({ cle: z.string(), categorie: z.string() })),
});

/** Classe par l'IA les libellés jamais vus, mémorise les règles, puis les applique. */
export async function aiCategorize(companyId?: string) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new Error("ANTHROPIC_API_KEY manquante.");
  const [txs, rules, companies] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: { ...(companyId ? { companyId } : {}), account: { excluded: false }, NOT: { category: INTERNAL } },
      select: { label: true, amount: true, companyId: true, account: { select: { kind: true } } },
    }),
    prisma.categoryRule.findMany({ select: { key: true } }),
    prisma.company.findMany({ select: { id: true, name: true, activity: true } }),
  ]);
  const known = new Set(rules.map((r) => r.key));
  const groups = new Map<string, { key: string; example: string; count: number; total: number; inCount: number; companies: Set<string>; escrow: boolean }>();
  for (const t of txs) {
    const key = labelKey(t.label);
    if (!key || known.has(key)) continue;
    const g = groups.get(key) ?? { key, example: t.label.slice(0, 120), count: 0, total: 0, inCount: 0, companies: new Set<string>(), escrow: false };
    g.count++;
    g.total += t.amount;
    if (t.amount > 0) g.inCount++;
    g.companies.add(companies.find((c) => c.id === t.companyId)?.name ?? "?");
    if (t.account.kind === "SEQUESTRE") g.escrow = true;
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  if (!list.length) return { learned: 0, applied: await applyRules(companyId) };

  const client = new Anthropic();
  let learned = 0;
  for (let i = 0; i < list.length; i += 120) {
    const batch = list.slice(i, i + 120);
    const lines = batch
      .map((g) => `${g.key} | ex: ${g.example} | ${g.count} op. | total ${Math.round(g.total)} € | ${g.inCount === g.count ? "entrées" : g.inCount === 0 ? "sorties" : "mixte"} | ${[...g.companies].join(", ")}${g.escrow ? " | COMPTE SÉQUESTRE DÉPÔT-VENTE" : ""}`)
      .join("\n");
    const stream = client.beta.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { format: betaZodOutputFormat(Classification) },
      system: `Tu es expert-comptable français. Tu classes des libellés d'opérations bancaires de PME dans des catégories comptables.
Sociétés du groupe : ${companies.map((c) => `${c.name} (${c.activity ?? "?"})`).join(" ; ")}.
Catégories d'ENTRÉES autorisées : ${CATEGORIES_IN.join(" ; ")}.
Catégories de SORTIES autorisées : ${CATEGORIES_OUT.join(" ; ")}.
Règles : une clé « entrées » reçoit une catégorie d'entrée, « sorties » une catégorie de sortie (pour « mixte », choisis selon le sens dominant indiqué par le total).
Exemples : EDF, ENGIE, TotalEnergies électricité, Veolia -> Électricité / gaz / eau ; URSSAF, AG2R, Malakoff -> Charges sociales ; DGFIP -> Impôts et taxes (ou TVA si mentionné) ;
loyer, SCI, bail -> Loyer ; Orange, SFR, Free, Bouygues -> Téléphone / internet ; Metro, Promocash, Transgourmet -> Achats alimentaires ; France Boissons, C10 -> Boissons ;
Total, Esso, Shell, BP (station) -> Carburant ; Oscaro, Autodistribution -> Pièces et fournitures auto ; ANTS -> Cartes grises ; remise CB, encaissement carte -> Encaissements carte (TPE) ;
virement reçu d'un client -> Ventes / encaissements clients ; sur un compte séquestre dépôt-vente : sortie vers un particulier -> Reversements aux vendeurs (dépôt-vente).
Si vraiment impossible à déterminer : « Autres dépenses » ou « Autres entrées ». Réponds pour CHAQUE clé, en recopiant la clé à l'identique.`,
      messages: [{ role: "user", content: `Classe ces ${batch.length} libellés (clé | exemple | nombre | total | sens | sociétés) :\n${lines}` }],
    });
    const msg = await stream.finalMessage();
    await trackAiSpend("classement comptable", msg.model, msg.usage);
    if (msg.stop_reason === "refusal") continue;
    const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
    let parsed: z.infer<typeof Classification>;
    try {
      parsed = Classification.parse(JSON.parse(text));
    } catch {
      continue;
    }
    for (const c of parsed.classements) {
      const g = batch.find((x) => x.key === c.cle);
      if (!g || !(ALL_CATEGORIES as string[]).includes(c.categorie)) continue;
      await prisma.categoryRule.upsert({
        where: { key_companyId: { key: g.key, companyId: "" } },
        update: {},
        create: { key: g.key, companyId: "", category: c.categorie, source: "IA", example: g.example },
      });
      learned++;
    }
  }
  const applied = await applyRules(companyId);
  console.log(`[comptabilite] classement IA : ${learned} libellé(s) appris, ${applied} opération(s) reclassée(s)`);
  return { learned, applied };
}

/** Correction manuelle : la clé du libellé prend cette catégorie (pour toutes les opérations de ce libellé). */
export async function setManualCategory(label: string, category: string, companyId?: string) {
  if (!(ALL_CATEGORIES as string[]).includes(category)) throw new Error("Catégorie inconnue.");
  const key = labelKey(label);
  if (!key) throw new Error("Ce libellé ne contient aucun mot reconnaissable : impossible d'en faire une règle (elle s'appliquerait à toutes les opérations sans libellé).");
  await prisma.categoryRule.upsert({
    where: { key_companyId: { key, companyId: companyId ?? "" } },
    update: { category, source: "MANUEL", example: label.slice(0, 120) },
    create: { key, companyId: companyId ?? "", category, source: "MANUEL", example: label.slice(0, 120) },
  });
  return applyRules(companyId);
}

/** Compte de résultat de trésorerie : par catégorie et par mois, comptes courants uniquement, hors virements internes. */
export async function cashStatement(companyId: string | undefined, year: number) {
  const start = new Date(year, 0, 1);
  const end = new Date(year + 1, 0, 1);
  const txs = await prisma.bankTransaction.findMany({
    where: { date: { gte: start, lt: end }, account: { kind: "COURANT", excluded: false }, ...(companyId ? { companyId } : {}) },
    select: { date: true, amount: true, category: true },
  });
  const rows = new Map<string, number[]>();
  let internal = 0;
  const months = new Set<number>();
  for (const t of txs) {
    const m = t.date.getMonth();
    months.add(m);
    if (t.category === INTERNAL) {
      internal += t.amount;
      continue;
    }
    const cat = t.category ?? (t.amount >= 0 ? "Autres entrées" : "Autres dépenses");
    const r = rows.get(cat) ?? new Array(12).fill(0);
    r[m] += t.amount;
    rows.set(cat, r);
  }
  const make = (cats: readonly string[], sign: 1 | -1) =>
    [...rows.entries()]
      .filter(([c, r]) => (cats.includes(c) || (!ALL_CATEGORIES.includes(c) && Math.sign(r.reduce((a, b) => a + b, 0)) === sign)))
      .map(([category, r]) => ({ category, months: r.map((v) => Math.round(v * sign * 100) / 100), total: Math.round(r.reduce((a, b) => a + b, 0) * sign * 100) / 100 }))
      .filter((x) => x.total !== 0)
      .sort((a, b) => b.total - a.total);
  const entrees = make(CATEGORIES_IN, 1);
  const sorties = make(CATEGORIES_OUT, -1);
  const sumMonths = (list: { months: number[] }[]) => new Array(12).fill(0).map((_, i) => Math.round(list.reduce((s, x) => s + x.months[i], 0) * 100) / 100);
  const totIn = sumMonths(entrees);
  const totOut = sumMonths(sorties);
  return {
    year,
    monthsWithData: [...months].sort((a, b) => a - b),
    entrees,
    sorties,
    totalEntrees: { months: totIn, total: Math.round(totIn.reduce((a, b) => a + b, 0) * 100) / 100 },
    totalSorties: { months: totOut, total: Math.round(totOut.reduce((a, b) => a + b, 0) * 100) / 100 },
    solde: { months: totIn.map((v, i) => Math.round((v - totOut[i]) * 100) / 100), total: Math.round((totIn.reduce((a, b) => a + b, 0) - totOut.reduce((a, b) => a + b, 0)) * 100) / 100 },
    virementsInternesNet: Math.round(internal * 100) / 100,
  };
}

// Connaissances métier par type d'activité : l'IA classe les opérations d'UNE société avec le vocabulaire de son métier.
const METIER: Record<string, string> = {
  "La Fabrique Automobile": `Négoce de véhicules d'occasion + dépôt-vente, découvert de 250 000 € garanti par Auxiga (gage sur le stock).
- Virement reçu d'un organisme de crédit (Cetelem, Cofidis, Franfinance, Sofinco, CA Consumer Finance, Créatis, Oney, Carmine, Lixxbail, DIAC, Mobilize, Stellantis Financial, BNP Personal Finance, Younited, Floa, Cofica...) = paiement du prix d'une voiture vendue -> Ventes / encaissements clients.
- Virement reçu d'un particulier ou d'une société cliente, chèque remis, espèces versées = vente de véhicule -> Ventes / encaissements clients.
- Commission reçue d'un organisme de financement ou d'un assureur / vendeur de garantie (Opteven, Mondial Car, Icare, Garantie Plus...) -> Commissions dépôt-vente seulement si c'est du dépôt-vente, sinon Autres entrées.
- Achat aux enchères ou chez un marchand (BCA, VPauto, Alcopa, Autobid, Aramis, Autorola, Openlane, Adesa, Macadam, CarOnSale, concessionnaires) -> Achats de véhicules.
- Virement émis vers un particulier : rachat de son véhicule -> Achats de véhicules ; s'il s'agit d'un véhicule en dépôt-vente (libellé dépôt, reversement, solde vente) -> Reversements aux vendeurs (dépôt-vente).
- Auxiga, frais de gage, intérêts du découvert, agios, commission d'intervention -> Intérêts / agios / financement de stock.
- ANTS, SIV, carte grise, certificat d'immatriculation -> Cartes grises (ANTS).
- Autodistribution, Oscaro, carrossier, pneus, contrôle technique (Dekra, Autosur, Securitest), préparation esthétique -> Pièces et fournitures auto (ou Entretien / réparations pour une prestation).
- La Centrale, Leboncoin, AutoScout24, Spoticar, ParuVendu, Autohero (abonnement d'annonces) -> Publicité / marketing.
- Auto Cerfa, GTA Pro, logiciels -> Logiciels / abonnements.`,
  "Auto Rac Ives": `Atelier de mécanique automobile. Encaissements carte et virements clients = réparations -> Ventes / encaissements clients ou Encaissements carte (TPE). Pièces (Autodistribution, Oscaro, Partner, Doyen, Groupauto, Alliance, Gefa, Würth) -> Pièces et fournitures auto. WebDataBays, GTA Pro -> Logiciels / abonnements.`,
  "La Fabrique Restaurant": `Restaurant. Remises CB / TPE / Sumup / Zettle -> Encaissements carte (TPE) ; tickets restaurant (Edenred, Swile, Up, Pluxee) -> Ventes / encaissements clients ; Metro, Promocash, Transgourmet, primeurs, boucherie -> Achats alimentaires ; boissons -> Boissons.`,
  "Le Bar L'Usine": `Bar. Remises CB / TPE -> Encaissements carte (TPE) ; brasseur, France Boissons, C10, cavistes -> Boissons ; SACEM, licences -> Impôts et taxes.`,
  "SCI Mapo": `Société civile immobilière. Loyers reçus des locataires (souvent les sociétés du groupe) -> Loyers perçus ; échéance de prêt immobilier -> Remboursement d'emprunt ; taxe foncière -> Impôts et taxes ; assurance PNO -> Assurances ; syndic, travaux -> Entretien / réparations.`,
  "Start Invest": `Holding. Dividendes / management fees reçus des filiales -> Autres entrées ; honoraires comptables / juridiques -> Honoraires.`,
};

/**
 * Reclasse TOUTE une société avec son métier : l'IA revoit chaque libellé (pas seulement les nouveaux) et crée des
 * règles propres à la société, prioritaires sur les règles du groupe. Les corrections manuelles du fondateur restent prioritaires.
 */
export async function reclassifyCompany(companyId: string) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new Error("ANTHROPIC_API_KEY manquante.");
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  const [txs, manual, markers] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: { companyId, account: { excluded: false } },
      select: { label: true, amount: true, account: { select: { kind: true } } },
    }),
    prisma.categoryRule.findMany({ where: { source: "MANUEL", companyId: { in: [companyId, ""] } }, select: { key: true } }),
    groupMarkers(),
  ]);
  const manualKeys = new Set(manual.map((r) => r.key));
  // Les BILANS de la société disent quels postes existent vraiment (emprunts, loyers, assurances, achats de stock...) :
  // l'IA s'en sert pour reconnaître à quoi correspond chaque libellé de banque.
  const [statements, bilanDocs] = await Promise.all([
    prisma.financialStatement.findMany({ where: { companyId }, orderBy: { year: "desc" }, take: 3 }),
    prisma.document.findMany({ where: { companyId, type: "BILAN", status: "DONE" }, orderBy: { year: "desc" }, take: 3, select: { year: true, summary: true } }),
  ]);
  const fmt = (n: number | null) => (n === null ? "?" : `${Math.round(n).toLocaleString("fr-FR")} €`);
  const bilans = [
    ...statements.map((b) => `Bilan ${b.year} : CA ${fmt(b.revenue)}, salaires ${fmt(b.payroll)}, EBE ${fmt(b.ebitda)}, résultat net ${fmt(b.netIncome)}, emprunts ${fmt(b.debt)}, stock ${fmt(b.stock)}, trésorerie ${fmt(b.cash)}${b.notes ? ` — ${b.notes.slice(0, 600)}` : ""}`),
    ...bilanDocs.filter((d) => d.summary).map((d) => `Analyse du bilan ${d.year ?? ""} : ${d.summary!.slice(0, 1500)}`),
  ].join("\n");
  const groups = new Map<string, { key: string; examples: string[]; count: number; total: number; inCount: number; escrow: boolean }>();
  for (const t of txs) {
    if (isInternal(t.label, companyId, markers)) continue;
    const key = labelKey(t.label);
    if (!key || manualKeys.has(key)) continue;
    const g = groups.get(key) ?? { key, examples: [], count: 0, total: 0, inCount: 0, escrow: false };
    g.count++;
    g.total += t.amount;
    if (t.amount > 0) g.inCount++;
    if (g.examples.length < 2 && !g.examples.includes(t.label.slice(0, 100))) g.examples.push(t.label.slice(0, 100));
    if (t.account.kind === "SEQUESTRE") g.escrow = true;
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  const client = new Anthropic();
  let learned = 0;
  for (let i = 0; i < list.length; i += 100) {
    const batch = list.slice(i, i + 100);
    const lines = batch
      .map((g) => `${g.key} | ex: ${g.examples.join(" / ")} | ${g.count} op. | total ${Math.round(g.total)} € | ${g.inCount === g.count ? "entrées" : g.inCount === 0 ? "sorties" : "mixte"}${g.escrow ? " | COMPTE SÉQUESTRE DÉPÔT-VENTE" : ""}`)
      .join("\n");
    const stream = client.beta.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { format: betaZodOutputFormat(Classification) },
      system: `Tu es l'expert-comptable de ${company.name} (${company.activity ?? "activité non précisée"}). Tu classes les libellés de SES opérations bancaires.
${METIER[company.name] ?? ""}
${bilans ? `Ce que disent les BILANS de la société (utilise-les pour reconnaître les postes : un prélèvement mensuel d'une banque quand le bilan montre un emprunt = Remboursement d'emprunt ; des virements réguliers de locataires quand le bilan montre des loyers = Loyers perçus, etc.) :\n${bilans}\n` : ""}Catégories d'ENTRÉES autorisées : ${CATEGORIES_IN.join(" ; ")}.
Catégories de SORTIES autorisées : ${CATEGORIES_OUT.join(" ; ")}.
Une clé « entrées » reçoit une catégorie d'entrée, « sorties » une catégorie de sortie (« mixte » : selon le sens du total). Ne devine pas un fournisseur inconnu : « Autres dépenses » / « Autres entrées ». Réponds pour CHAQUE clé, recopiée à l'identique.`,
      messages: [{ role: "user", content: `Classe ces ${batch.length} libellés (clé | exemples | nombre | total | sens) :\n${lines}` }],
    });
    const msg = await stream.finalMessage();
    await trackAiSpend("classement comptable", msg.model, msg.usage);
    if (msg.stop_reason === "refusal") continue;
    const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
    let parsed: z.infer<typeof Classification>;
    try {
      parsed = Classification.parse(JSON.parse(text));
    } catch {
      continue;
    }
    for (const c of parsed.classements) {
      const g = batch.find((x) => x.key === c.cle);
      if (!g || !(ALL_CATEGORIES as string[]).includes(c.categorie)) continue;
      await prisma.categoryRule.upsert({
        where: { key_companyId: { key: g.key, companyId } },
        update: { category: c.categorie, source: "IA", example: g.examples[0] },
        create: { key: g.key, companyId, category: c.categorie, source: "IA", example: g.examples[0] },
      });
      learned++;
    }
  }
  const applied = await applyRules(companyId);
  const left = await prisma.bankTransaction.count({ where: { companyId, category: null, account: { excluded: false } } });
  console.log(`[comptabilite] ${company.name} reclassée : ${learned} libellé(s), ${applied} opération(s) modifiée(s), ${left} sans catégorie`);
  return { libelles: learned, operationsModifiees: applied, sansCategorie: left };
}

/**
 * Négoce auto : une sortie d'argent du MONTANT EXACT du prix d'achat d'un véhicule d'Auto Cerfa, autour de sa date
 * d'entrée en stock, EST l'achat de ce véhicule (quelle que soit la règle du libellé : virement à un particulier,
 * enchères...). Idem pour l'encaissement du prix de vente autour de la date de vente. Basé sur les données réelles.
 */
export async function matchVehicleFlows(companyId?: string) {
  const vehicles = await prisma.vehicle.findMany({
    where: { ...(companyId ? { companyId } : {}), OR: [{ purchasePrice: { gt: 0 } }, { salePrice: { gt: 0 } }] },
    select: { companyId: true, mode: true, purchasePrice: true, entryDate: true, salePrice: true, saleDate: true },
  });
  if (!vehicles.length) return 0;
  const DAY = 86400000;
  let changed = 0;
  const used = new Set<string>();
  const find = async (cid: string, amount: number, around: Date, sign: 1 | -1) => {
    const list = await prisma.bankTransaction.findMany({
      where: { companyId: cid, date: { gte: new Date(around.getTime() - 25 * DAY), lte: new Date(around.getTime() + 25 * DAY) }, amount: sign > 0 ? { gte: amount - 1, lte: amount + 1 } : { gte: -amount - 1, lte: -amount + 1 }, NOT: { category: INTERNAL } },
      orderBy: { date: "asc" },
    });
    return list.filter((t) => !used.has(t.id)).sort((a, b) => Math.abs(a.date.getTime() - around.getTime()) - Math.abs(b.date.getTime() - around.getTime()))[0];
  };
  for (const v of vehicles) {
    if (v.mode === "ACHAT" && v.purchasePrice && v.entryDate) {
      const t = await find(v.companyId, v.purchasePrice, v.entryDate, -1);
      if (t) {
        used.add(t.id);
        if (t.category !== "Achats de véhicules") {
          await prisma.bankTransaction.update({ where: { id: t.id }, data: { category: "Achats de véhicules" } });
          changed++;
        }
      }
    }
    if (v.salePrice && v.saleDate) {
      const t = await find(v.companyId, v.salePrice, v.saleDate, 1);
      if (t) {
        used.add(t.id);
        if (t.category !== "Ventes / encaissements clients") {
          await prisma.bankTransaction.update({ where: { id: t.id }, data: { category: "Ventes / encaissements clients" } });
          changed++;
        }
      }
    }
  }
  return changed;
}
