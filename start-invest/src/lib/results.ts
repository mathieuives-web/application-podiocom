import { prisma } from "@/lib/prisma";
import { cashStatement } from "@/lib/categorization";
import { vehicleMargin } from "@/lib/vehicles";

// « Combien on gagne » société par société, uniquement à partir des données réelles enregistrées :
// banque (opérations catégorisées), Auto Cerfa (véhicules), GTA Pro / factures, loyers, bilans.
// Une donnée absente est signalée comme manquante, jamais estimée.

const r2 = (n: number) => Math.round(n * 100) / 100;
// Mouvements qui ne sont ni un gain ni une charge : argent prêté/apporté, emprunt remboursé, prélèvements du dirigeant.
const FINANCEMENT_IN = ["Apports / prêts reçus"];
const FINANCEMENT_OUT = ["Remboursement d'emprunt", "Rémunération / prélèvements du dirigeant"];

export type CompanyResults = Awaited<ReturnType<typeof companyResults>>;

export async function companyResults(companyId: string, year = new Date().getFullYear()) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yStart = new Date(year, 0, 1);
  const yEnd = new Date(year + 1, 0, 1);
  const [company, cash, accounts, vehicles, invoices, statements, lastTx, uncategorized] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: companyId } }),
    cashStatement(companyId, year),
    prisma.bankAccount.findMany({ where: { companyId, excluded: false } }),
    prisma.vehicle.findMany({ where: { companyId } }),
    prisma.invoice.findMany({ where: { companyId, kind: "CLIENT", issueDate: { gte: yStart, lt: yEnd } } }),
    prisma.financialStatement.findMany({ where: { companyId }, orderBy: { year: "desc" } }),
    prisma.bankTransaction.findFirst({ where: { companyId }, orderBy: { date: "desc" }, select: { date: true } }),
    prisma.bankTransaction.count({ where: { companyId, date: { gte: yStart, lt: yEnd }, category: null } }),
  ]);

  // --- Banque : ce qui est entré et sorti, puis le résultat « d'activité » (hors financement).
  const sum = (list: { category: string; total: number }[], cats: string[]) => list.filter((x) => cats.includes(x.category)).reduce((s, x) => s + x.total, 0);
  const finIn = sum(cash.entrees, FINANCEMENT_IN);
  const finOut = sum(cash.sorties, FINANCEMENT_OUT);
  const activiteEntrees = cash.totalEntrees.total - finIn;
  const activiteSorties = cash.totalSorties.total - finOut;
  const months = cash.monthsWithData.length;
  const banque = {
    comptes: accounts.length,
    soldeActuel: r2(accounts.reduce((s, a) => s + a.balance, 0)),
    decouvertAutorise: r2(accounts.reduce((s, a) => s + (a.overdraftLimit ?? 0), 0)),
    derniereOperation: lastTx?.date ?? null,
    moisCouverts: months,
    entrees: r2(cash.totalEntrees.total),
    sorties: r2(cash.totalSorties.total),
    resultatActivite: r2(activiteEntrees - activiteSorties),
    resultatMoyenParMois: months ? r2((activiteEntrees - activiteSorties) / months) : null,
    financement: { apportsPretsRecus: r2(finIn), remboursementsEtPrelevementsDirigeant: r2(finOut) },
    parMois: cash.monthsWithData.map((m) => ({ mois: m + 1, entrees: cash.totalEntrees.months[m], sorties: cash.totalSorties.months[m], solde: cash.solde.months[m] })),
    principalesDepenses: cash.sorties.slice(0, 8).map((x) => ({ categorie: x.category, montant: x.total })),
    principalesEntrees: cash.entrees.slice(0, 6).map((x) => ({ categorie: x.category, montant: x.total })),
    operationsNonClassees: uncategorized,
    loyersPercus: r2(sum(cash.entrees, ["Loyers perçus"])),
    loyersPayes: r2(sum(cash.sorties, ["Loyer"])),
  };

  // --- Véhicules (Auto Cerfa)
  const sold = vehicles.filter((v) => v.status === "VENDU" && v.saleDate && v.saleDate >= yStart && v.saleDate < yEnd);
  const soldMonth = sold.filter((v) => v.saleDate! >= monthStart);
  const margins = sold.map((v) => vehicleMargin(v)).filter((m): m is number => m !== null);
  const stock = vehicles.filter((v) => v.status !== "VENDU");
  const vehicules = vehicles.length
    ? {
        vendusAnnee: sold.length,
        vendusMois: soldMonth.length,
        dontDepotVente: sold.filter((v) => v.mode === "DEPOT_VENTE").length,
        chiffreAffairesVentes: r2(sold.reduce((s, v) => s + (v.salePrice ?? 0), 0)),
        margeTotaleConnue: r2(margins.reduce((s, m) => s + m, 0)),
        margeMoyenne: margins.length ? r2(margins.reduce((s, m) => s + m, 0) / margins.length) : null,
        ventesSansMargeConnue: sold.length - margins.length,
        financementsVendus: sold.filter((v) => v.financingSold).length,
        garantiesVendues: sold.filter((v) => v.warrantySold).length,
        enStock: stock.length,
        valeurStockAchat: r2(stock.reduce((s, v) => s + (v.mode === "ACHAT" ? (v.purchasePrice ?? 0) + v.costs : 0), 0)),
      }
    : null;

  // --- Factures clients (GTA Pro pour l'atelier, Shine / Pennylane / import pour les autres)
  const invMonth = invoices.filter((i) => i.issueDate >= monthStart);
  const factures = invoices.length
    ? {
        source: [...new Set(invoices.map((i) => i.provider))].join(", "),
        nombreAnnee: invoices.length,
        nombreMois: invMonth.length,
        montantAnneeTTC: r2(invoices.reduce((s, i) => s + i.amount, 0)),
        montantMoisTTC: r2(invMonth.reduce((s, i) => s + i.amount, 0)),
        panierMoyenTTC: r2(invoices.reduce((s, i) => s + i.amount, 0) / invoices.length),
        resteAEncaisser: r2(invoices.reduce((s, i) => s + Math.max(0, i.amount - i.paidAmount), 0)),
      }
    : null;

  // --- Bilans
  const bilans = statements.map((s) => ({ annee: s.year, chiffreAffaires: s.revenue, resultatNet: s.netIncome, ebe: s.ebitda, tresorerie: s.cash, dettes: s.debt, stock: s.stock }));

  // --- Ce qui manque pour répondre juste (dit clairement plutôt qu'estimé)
  const manques: string[] = [];
  if (!accounts.length) manques.push("Aucun compte bancaire relié.");
  else if (!months) manques.push(`Aucune opération bancaire en ${year}.`);
  if (uncategorized > 0) manques.push(`${uncategorized} opération(s) bancaire(s) pas encore classée(s) : le détail des dépenses est incomplet.`);
  if (company.name === "La Fabrique Automobile" && !vehicles.length) manques.push("Stock Auto Cerfa pas encore importé : nombre de véhicules vendus inconnu.");
  if (vehicules && vehicules.ventesSansMargeConnue > 0) manques.push(`${vehicules.ventesSansMargeConnue} vente(s) sans prix d'achat ou de reversement dans Auto Cerfa : marge inconnue pour celles-ci.`);
  if (company.name === "Auto Rac Ives" && !invoices.some((i) => i.provider === "GTAPRO")) manques.push("Factures GTA Pro pas encore lues : nombre de factures de l'atelier inconnu.");
  if (!statements.length) manques.push("Aucun bilan archivé.");

  const redo = await prisma.appSetting.findUnique({ where: { key: `remise-a-plat:${companyId}` } });
  const redoInfo = redo ? (JSON.parse(redo.value) as { at: string; classement?: { erreur?: string } }) : null;
  const remiseAPlat = redoInfo?.at ?? null;
  if (redoInfo?.classement?.erreur) manques.push(`Dernière remise à plat : le reclassement a échoué (${redoInfo.classement.erreur}).`);
  return { id: company.id, societe: company.name, annee: year, banque, vehicules, factures, bilans, manques, remiseAPlat };
}

export async function groupResults(year = new Date().getFullYear()) {
  const companies = await prisma.company.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  return Promise.all(companies.map((c) => companyResults(c.id, year)));
}
