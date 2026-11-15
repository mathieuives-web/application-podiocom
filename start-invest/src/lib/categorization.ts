import Anthropic from "@anthropic-ai/sdk";
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
    prisma.company.findMany({ select: { id: true, name: true } }),
    prisma.bankAccount.findMany({ select: { companyId: true, name: true, iban: true } }),
  ]);
  const names = [...companies.map((c) => ({ companyId: c.id, n: upperPlain(c.name) })), ...accounts.map((a) => ({ companyId: a.companyId, n: upperPlain(a.name) }))].filter(
    (x) => x.n.length >= 6 && !GENERIC.test(x.n)
  );
  const ibans = accounts.map((a) => (a.iban ?? "").replace(/\s/g, "").toUpperCase()).filter((i) => i.length > 10);
  return { names, ibans: [...new Set(ibans)] };
}

function isInternal(label: string, companyId: string, markers: Awaited<ReturnType<typeof groupMarkers>>) {
  const L = label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ");
  if (!/\bVIR|VIREMENT|TRANSFERT\b/.test(L)) return false;
  if (markers.ibans.some((i) => L.replace(/\s/g, "").includes(i))) return true;
  // Le nom de SA PROPRE société figure souvent dans le libellé d'un paiement client : seul le nom d'une AUTRE société du groupe compte.
  return markers.names.some((m) => m.companyId !== companyId && L.includes(m.n));
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
    if (isInternal(t.label, t.companyId, markers)) cat = INTERNAL;
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
    if (cat && cat !== INTERNAL) {
      const isIn = (CATEGORIES_IN as readonly string[]).includes(cat);
      if (isIn !== t.amount > 0) cat = null;
    }
    if (cat && cat !== t.category) {
      await prisma.bankTransaction.update({ where: { id: t.id }, data: { category: cat } });
      changed++;
    }
  }
  return changed;
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
