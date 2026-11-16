import { prisma } from "@/lib/prisma";

const DAY = 24 * 3600 * 1000;

// Catégorisation automatique des opérations bancaires par mots-clés du libellé.
const RULES: [string, RegExp][] = [
  ["Achats alimentaires", /metro|promocash|transgourmet|pomona|sysco|episaveurs|davigel|boucherie|primeur|poissonn/i],
  ["Boissons", /france boissons|c10|brasserie|brasseur|heineken|kronenbourg|ab inbev|pernod|ricard|bacardi|cave|vins?\b|spiritueux/i],
  ["Électricité / gaz / eau", /\bedf\b|engie|ekwateur|totalenergies electricite|veolia|suez|saur|eau de/i],
  ["Pièces et fournitures auto", /oscaro|autodistribution|groupauto|alliance automotive|d[ée]p[ôo]t pi[èe]ces|pi[èe]ces auto|mister auto|bosch car/i],
  ["Cartes grises (ANTS)", /ants|carte grise|immatriculation/i],
  ["Carburant", /total ?energies|esso|shell|\bbp\b|avia|carburant|station|gazole|diesel|as24|dkv/i],
  ["Transport / déplacements", /p[ée]age|vinci|sanef|aprr|autoroute|parking|indigo/i],
  ["Entretien / réparations", /garage|pneu|euromaster|norauto|feu vert|m[ée]cani|carrosserie|contr[ôo]le technique|dekra|autovista/i],
  ["Assurances", /assurance|axa|allianz|maif|macif|generali|groupama|hiscox/i],
  ["Salaires", /salaire|paie|virement.*salari/i],
  ["Charges sociales (URSSAF, retraite, mutuelle)", /urssaf|retraite|pr[ée]voyance|mutuelle/i],
  ["Impôts et taxes", /dgfip|imp[ôo]t|tva|cfe|tr[ée]sor public/i],
  ["Loyer", /loyer|bail/i],
  ["Logiciels / abonnements", /google|microsoft|apple\.com|adobe|notion|slack|ovh|orange|sfr|bouygues|free mobile|abonnement|stripe fee|qonto/i],
  ["Intérêts / agios / financement de stock", /auxiga|agios|int[ée]r[êe]ts? d[ée]biteurs?|commission (de )?(plus fort d[ée]couvert|d.?immobilisation)|gage (sur )?stock|frais de gage/i],
  ["Frais bancaires", /frais|commission|cotisation carte/i],
  ["Remboursement d'emprunt", /pr[êe]t|[ée]ch[ée]ance|leasing|lld|loa|cr[ée]dit bail/i],
];

export const INTERNAL = "Virements internes";

export function categorize(label: string, amount: number): string {
  if (/virement (interne|entre comptes)|vir(ement)? (de|vers) (start invest|sci mapo|la fabrique|auto rac|le bar|bar l.?usine)/i.test(label)) return INTERNAL;
  for (const [cat, re] of RULES) if (re.test(label)) return cat;
  return amount >= 0 ? "Ventes / encaissements clients" : "Autres dépenses";
}

export function invoiceStatus(inv: { amount: number; paidAmount: number; dueDate: Date | null }) {
  if (inv.paidAmount >= inv.amount - 0.01) return "PAYEE" as const;
  if (inv.dueDate && inv.dueDate.getTime() < Date.now()) return "EN_RETARD" as const;
  return "A_PAYER" as const;
}

const FINANCING = ["Apports / prêts reçus", "Remboursement d'emprunt", "Rémunération / prélèvements du dirigeant"];

export type CompanySummary = Awaited<ReturnType<typeof financeSummary>>["companies"][number];

/** Vue consolidée : trésorerie, flux 30 jours, factures, par société + total groupe. */
export async function financeSummary(opts: { companyId?: string; days?: number } = {}) {
  const days = opts.days ?? 30;
  const since = new Date(Date.now() - days * DAY);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const from = since < monthStart ? since : monthStart;
  const companies = await prisma.company.findMany({
    where: { active: true, ...(opts.companyId ? { id: opts.companyId } : {}) },
    include: {
      bankAccounts: { where: { excluded: false } },
      invoices: true,
      transactions: { where: { date: { gte: from }, NOT: { category: INTERNAL }, account: { kind: "COURANT", excluded: false } } },
      vehicles: { where: { status: "VENDU", mode: "ACHAT", saleDate: { gte: from } }, select: { saleDate: true, purchasePrice: true } },
      _count: { select: { vehicles: true } },
    },
    orderBy: { name: "asc" },
  });

  // Résultat = entrées − sorties, MAIS : un véhicule acheté pour le stock n'est pas une perte (on retire l'achat et on
  // compte à la place le prix d'achat des véhicules VENDUS sur la période), et les prêts reçus, remboursements
  // d'emprunt et prélèvements du dirigeant ne sont ni un gain ni une charge.
  const result = (txs: { amount: number; category: string | null }[], sold: { purchasePrice: number | null }[], dealer: boolean) => {
    const cash = txs.reduce((s, t) => s + t.amount, 0);
    const stockCats = dealer ? ["Achats de véhicules", "Achats de marchandises"] : ["Achats de véhicules"];
    const stockBuys = -txs.filter((t) => stockCats.includes(t.category ?? "")).reduce((s, t) => s + t.amount, 0);
    const financing = txs.filter((t) => FINANCING.includes(t.category ?? "")).reduce((s, t) => s + t.amount, 0);
    const costOfSold = sold.reduce((s, v) => s + (v.purchasePrice ?? 0), 0);
    const adjusted = stockBuys > 0 && sold.length > 0;
    // Négoce : sans les ventes ET les achats de véhicules identifiés, la banque seule ne dit pas si on gagne ou perd
    // (un mois où l'on achète beaucoup de stock paraît en perte). On ne publie alors PAS de résultat.
    const known = !dealer || adjusted;
    return {
      cashNet: cash,
      stockBuys,
      costOfSold,
      soldCount: sold.length,
      soldWithoutPrice: sold.filter((v) => v.purchasePrice === null).length,
      net: cash - financing + (adjusted ? stockBuys - costOfSold : 0),
      adjusted,
      known,
      unknownReason: known ? null : sold.length === 0 ? "ventes de véhicules de la période absentes d'Auto Cerfa" : "achats de véhicules non identifiés dans la banque",
    };
  };
  const rows = companies.map((c) => {
    const dealer = c._count.vehicles > 0 || /automobile|v[ée]hicule|\bvo\b|n[ée]goce/i.test(`${c.name} ${c.activity ?? ""}`) && !/atelier|m[ée]canique|r[ée]paration/i.test(c.activity ?? "");
    const month = c.transactions.filter((t) => t.date >= monthStart);
    const monthNet = result(month, c.vehicles.filter((v) => v.saleDate! >= monthStart), dealer).net;
    c.transactions = c.transactions.filter((t) => t.date >= since);
    const res = result(c.transactions, c.vehicles.filter((v) => v.saleDate! >= since), dealer);
    const current = c.bankAccounts.filter((a) => a.kind === "COURANT");
    const cash = current.reduce((s, a) => s + a.balance, 0);
    // Découvert autorisé : marge de manœuvre réelle = solde + découvert ; utilisé = part négative du solde.
    const overdraftLimit = current.reduce((s, a) => s + (a.overdraftLimit ?? 0), 0);
    const overdraftUsed = current.reduce((s, a) => s + Math.max(0, -a.balance), 0);
    const financing = current.filter((a) => a.overdraftLimit > 0 || a.financingNote).map((a) => ({
      account: a.name,
      solde: a.balance,
      decouvertAutorise: a.overdraftLimit,
      decouvertUtilise: Math.max(0, -a.balance),
      tauxUtilisation: a.overdraftLimit > 0 ? Math.round((Math.max(0, -a.balance) / a.overdraftLimit) * 100) : null,
      note: a.financingNote,
    }));
    // Fonds de tiers (séquestre dépôt-vente) et emprunts : suivis à part, jamais comptés comme trésorerie.
    const escrow = c.bankAccounts.filter((a) => a.kind === "SEQUESTRE").reduce((s, a) => s + a.balance, 0);
    const loans = c.bankAccounts.filter((a) => a.kind === "PRET").reduce((s, a) => s + a.balance, 0);
    const inflow = c.transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const outflow = Math.abs(c.transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0));
    const byCategory: Record<string, number> = {};
    for (const t of c.transactions.filter((t) => t.amount < 0)) {
      const k = t.category ?? "Autres dépenses";
      byCategory[k] = (byCategory[k] ?? 0) - t.amount;
    }
    const open = (kind: "CLIENT" | "SUPPLIER") =>
      c.invoices.filter((i) => i.kind === kind && invoiceStatus(i) !== "PAYEE");
    const due = (list: typeof c.invoices) => list.reduce((s, i) => s + (i.amount - i.paidAmount), 0);
    const receivables = open("CLIENT");
    const payables = open("SUPPLIER");
    const late = receivables.filter((i) => invoiceStatus(i) === "EN_RETARD");
    return {
      id: c.id,
      name: c.name,
      activity: c.activity,
      color: c.color,
      accounts: c.bankAccounts.length,
      cash,
      overdraftLimit,
      overdraftUsed,
      available: cash + overdraftLimit,
      financing,
      escrow,
      loans,
      inflow,
      outflow,
      net: res.net,
      cashNet: res.cashNet,
      stockBuys: res.stockBuys,
      costOfSold: res.costOfSold,
      soldCount: res.soldCount,
      soldWithoutPrice: res.soldWithoutPrice,
      stockAdjusted: res.adjusted,
      resultKnown: res.known,
      unknownReason: res.unknownReason,
      monthNet,
      profitable: res.known ? res.net >= 0 : true,
      hasData: current.length > 0,
      byCategory: Object.entries(byCategory)
        .sort((a, b) => b[1] - a[1])
        .map(([category, amount]) => ({ category, amount })),
      receivables: due(receivables),
      receivablesLate: due(late),
      lateInvoices: late.length,
      payables: due(payables),
      lastSync: c.bankAccounts.map((a) => a.lastSyncAt).filter(Boolean).sort().pop() ?? null,
    };
  });

  const total = rows.reduce(
    (s, r) => ({
      escrow: s.escrow + r.escrow,
      loans: s.loans + r.loans,
      cash: s.cash + r.cash,
      overdraftLimit: s.overdraftLimit + r.overdraftLimit,
      available: s.available + r.available,
      inflow: s.inflow + r.inflow,
      outflow: s.outflow + r.outflow,
      receivables: s.receivables + r.receivables,
      receivablesLate: s.receivablesLate + r.receivablesLate,
      payables: s.payables + r.payables,
      net: s.net + (r.resultKnown ? r.net : 0),
      stockBuys: s.stockBuys + r.stockBuys,
    }),
    { escrow: 0, loans: 0, cash: 0, overdraftLimit: 0, available: 0, inflow: 0, outflow: 0, receivables: 0, receivablesLate: 0, payables: 0, net: 0, stockBuys: 0 }
  );

  return { periodDays: days, companies: rows, total: { ...total, unknown: rows.filter((r) => r.hasData && !r.resultKnown).map((r) => r.name) } };
}

/** Flux mensuels (entrées / sorties) sur N mois, toutes sociétés ou une seule. */
export async function monthlyFlows(months = 6, companyId?: string) {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  start.setMonth(start.getMonth() - (months - 1));
  const txs = await prisma.bankTransaction.findMany({
    where: { date: { gte: start }, NOT: { category: INTERNAL }, account: { kind: "COURANT", excluded: false }, ...(companyId ? { companyId } : {}) },
    select: { date: true, amount: true },
  });
  const buckets = Array.from({ length: months }, (_, i) => {
    const d = new Date(start);
    d.setMonth(start.getMonth() + i);
    return { key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString("fr-FR", { month: "short" }), inflow: 0, outflow: 0 };
  });
  for (const t of txs) {
    const b = buckets.find((x) => x.key === `${t.date.getFullYear()}-${t.date.getMonth()}`);
    if (!b) continue;
    if (t.amount >= 0) b.inflow += t.amount;
    else b.outflow -= t.amount;
  }
  return buckets;
}

function norm(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Rapprochement automatique : relie une opération bancaire non rapprochée à une facture
 * non payée du bon sens, de même montant (± 1 €), proche en date (± 60 j), en privilégiant
 * celle dont le nom du tiers ou le numéro apparaît dans le libellé.
 */
export async function autoReconcile(companyId?: string) {
  const [txs, invoices] = await Promise.all([
    prisma.bankTransaction.findMany({ where: { invoiceId: null, ...(companyId ? { companyId } : {}) } }),
    prisma.invoice.findMany({ where: companyId ? { companyId } : {} }),
  ]);
  const open = invoices.filter((i) => invoiceStatus(i) !== "PAYEE");
  let matched = 0;
  for (const t of txs) {
    const kind = t.amount > 0 ? "CLIENT" : "SUPPLIER";
    const label = norm(t.label + " " + (t.counterparty ?? ""));
    const candidates = open
      .filter(
        (i) =>
          i.companyId === t.companyId &&
          i.kind === kind &&
          i.paidAmount < i.amount - 0.01 &&
          Math.abs(i.amount - i.paidAmount - Math.abs(t.amount)) <= 1 &&
          Math.abs(t.date.getTime() - (i.dueDate ?? i.issueDate).getTime()) <= 60 * DAY
      )
      .map((i) => {
        let score = 0;
        const name = norm(i.counterparty);
        if (name && label.includes(name)) score += 2;
        else if (name.split(" ").some((w) => w.length > 3 && label.includes(w))) score += 1;
        if (i.number && label.includes(norm(i.number))) score += 3;
        return { i, score };
      })
      .sort((a, b) => b.score - a.score);
    const best = candidates[0];
    // Un seul candidat au montant exact suffit ; sinon on exige un indice dans le libellé.
    if (!best || (candidates.length > 1 && best.score === 0)) continue;
    await prisma.$transaction([
      prisma.bankTransaction.update({ where: { id: t.id }, data: { invoiceId: best.i.id } }),
      prisma.invoice.update({ where: { id: best.i.id }, data: { paidAmount: best.i.amount } }),
    ]);
    best.i.paidAmount = best.i.amount;
    matched++;
  }
  return matched;
}

export const eur = (n: number) =>
  n.toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

/** Tableau de bord des comptes séquestres (fonds de tiers, ex. dépôt-vente). */
export async function escrowSummary(companyId?: string) {
  const accounts = await prisma.bankAccount.findMany({
    where: { kind: "SEQUESTRE", excluded: false, ...(companyId ? { companyId } : {}) },
    include: { company: { select: { name: true } } },
  });
  const since30 = new Date(Date.now() - 30 * DAY);
  const since365 = new Date(Date.now() - 365 * DAY);
  return Promise.all(
    accounts.map(async (a) => {
      const txs = await prisma.bankTransaction.findMany({ where: { accountId: a.id, date: { gte: since365 } }, orderBy: { date: "desc" } });
      const sum = (list: typeof txs, sign: 1 | -1) => list.filter((t) => (sign > 0 ? t.amount > 0 : t.amount < 0)).reduce((s, t) => s + Math.abs(t.amount), 0);
      const last30 = txs.filter((t) => t.date >= since30);
      return {
        id: a.id,
        company: a.company.name,
        name: a.name,
        iban: a.iban,
        balance: a.balance,
        received30: sum(last30, 1),
        paidOut30: sum(last30, -1),
        received365: sum(txs, 1),
        paidOut365: sum(txs, -1),
        recent: txs.slice(0, 25).map((t) => ({ date: t.date, label: t.label, amount: t.amount })),
        largestIn: txs.filter((t) => t.amount > 0).sort((x, y) => y.amount - x.amount).slice(0, 5).map((t) => ({ date: t.date, label: t.label, amount: t.amount })),
      };
    })
  );
}
