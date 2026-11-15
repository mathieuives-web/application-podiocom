import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { relinkStaff, vehicleMargin } from "@/lib/vehicles";

// Salariés commissionnés (La Fabrique Automobile) : règles tirées du contrat de travail,
// calcul des commissions chaque mois, historique (même payées plusieurs mois après) et congés.

export const EVENTS = {
  ACHAT: "Achat / rentrée d'un véhicule",
  VENTE: "Vente d'un véhicule",
  CREDIT: "Vente d'un crédit / financement",
  GARANTIE: "Vente d'une garantie",
} as const;
export type CommissionEvent = keyof typeof EVENTS;

export const MODES = {
  AUCUNE: "Pas de commission",
  FIXE: "Montant fixe (€)",
  POURCENT_MARGE: "% de la marge du véhicule",
  POURCENT_PRIX: "% du prix (achat ou vente)",
  POURCENT_MONTANT: "% du montant (commission de financement / prix de la garantie)",
} as const;
export type Mode = keyof typeof MODES;

export const RuleSchema = z.object({
  mode: z.enum(["AUCUNE", "FIXE", "POURCENT_MARGE", "POURCENT_PRIX", "POURCENT_MONTANT"]),
  valeur: z.number().describe("Montant en euros (FIXE) ou pourcentage (ex. 10 pour 10 %)"),
  vehicules: z.enum(["TOUS", "ACHAT", "DEPOT_VENTE"]).describe("Véhicules concernés : tous, seulement ceux achetés, ou seulement les dépôts-ventes"),
  minimum_marge: z.number().nullable().describe("Marge minimale du véhicule pour toucher la commission, sinon null"),
});
export type Rule = z.infer<typeof RuleSchema>;
export type Rules = Partial<Record<CommissionEvent, Rule>>;

export function parseRules(raw: string | null | undefined): Rules {
  try {
    const o = JSON.parse(raw || "{}");
    const out: Rules = {};
    for (const k of Object.keys(EVENTS) as CommissionEvent[]) {
      const r = RuleSchema.safeParse(o[k]);
      if (r.success) out[k] = r.data;
    }
    return out;
  } catch {
    return {};
  }
}

export function describeRule(r?: Rule) {
  if (!r || r.mode === "AUCUNE") return "—";
  const v = r.mode === "FIXE" ? `${r.valeur} €` : `${r.valeur} % ${r.mode === "POURCENT_MARGE" ? "de la marge" : r.mode === "POURCENT_PRIX" ? "du prix" : "du montant"}`;
  const scope = r.vehicules === "TOUS" ? "" : r.vehicules === "ACHAT" ? " (véhicules achetés)" : " (dépôts-ventes)";
  return `${v}${scope}${r.minimum_marge ? `, si marge ≥ ${r.minimum_marge} €` : ""}`;
}

// ------------------------------------------------------------------ contrat de travail lu par l'IA

export const ContractSchema = z.object({
  prenom: z.string(),
  nom: z.string().nullable(),
  poste: z.string().nullable(),
  date_entree: z.string().nullable().describe("AAAA-MM-JJ"),
  salaire_brut_mensuel: z.number().nullable(),
  conges_jours_par_an: z.number().nullable().describe("Jours ouvrés de congés payés par an (25 par défaut en France si non précisé)"),
  commissions: z.object({
    ACHAT: RuleSchema.nullable(),
    VENTE: RuleSchema.nullable(),
    CREDIT: RuleSchema.nullable(),
    GARANTIE: RuleSchema.nullable(),
  }),
  conditions: z.string().describe("Conditions particulières de commission en clair (paliers, objectifs, délai de versement, cas d'exclusion), ou « aucune »"),
});

export const CONTRACT_INSTRUCTION = `Ce document est un contrat de travail (ou un avenant) d'un salarié d'un négoce de véhicules d'occasion.
Extrais l'identité, le poste, la date d'entrée, le salaire brut mensuel fixe et SURTOUT la rémunération variable :
commission sur l'ACHAT (ou la rentrée) d'un véhicule, sur la VENTE d'un véhicule, sur la vente d'un CRÉDIT / financement,
sur la vente d'une GARANTIE. Pour chacune : mode (FIXE en euros, POURCENT_MARGE, POURCENT_PRIX, POURCENT_MONTANT pour un % de
la commission de financement ou du prix de la garantie), valeur, véhicules concernés, marge minimale éventuelle.
Mets null pour une commission absente du contrat. N'invente rien. Décris en clair dans « conditions » tout ce qui ne rentre
pas dans ce format (paliers, objectifs, primes, délais de versement).`;

// ------------------------------------------------------------------ calcul des commissions

const monthKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit" }).format(d);
export const previousMonth = (d = new Date()) => {
  const x = new Date(d);
  x.setDate(1);
  x.setMonth(x.getMonth() - 1);
  return monthKey(x);
};
export const currentMonth = () => monthKey(new Date());

type Computed = { employeeId: string; vehicleId: string; event: CommissionEvent; month: string; base: number | null; amount: number; detail: string; warning: string | null };

function apply(rule: Rule | undefined, event: CommissionEvent, v: Parameters<typeof vehicleMargin>[0] & { purchasePrice: number | null; salePrice: number | null }) {
  if (!rule || rule.mode === "AUCUNE") return null;
  if (rule.vehicules !== "TOUS" && rule.vehicules !== v.mode) return null;
  const margin = vehicleMargin(v);
  if (rule.minimum_marge !== null && margin !== null && margin < rule.minimum_marge) return { base: margin, amount: 0, detail: `marge ${Math.round(margin)} € < minimum ${rule.minimum_marge} €`, warning: null };
  if (rule.mode === "FIXE") return { base: null, amount: rule.valeur, detail: `${rule.valeur} € fixe`, warning: rule.minimum_marge !== null && margin === null ? "marge inconnue : minimum de marge non vérifiable" : null };
  let base: number | null = null;
  let what = "";
  if (rule.mode === "POURCENT_MARGE") [base, what] = [margin, "de la marge"];
  else if (rule.mode === "POURCENT_PRIX") [base, what] = [event === "ACHAT" ? (v.mode === "ACHAT" ? v.purchasePrice : v.salePrice) : v.salePrice, "du prix"];
  else if (rule.mode === "POURCENT_MONTANT") [base, what] = [event === "CREDIT" ? v.financingIncome : event === "GARANTIE" ? v.warrantyPrice : null, "du montant"];
  if (base === null) return { base: null, amount: 0, detail: `${rule.valeur} % ${what}`, warning: `donnée manquante pour calculer ${rule.valeur} % ${what}` };
  const amount = Math.round(Math.max(0, base) * rule.valeur) / 100;
  return { base, amount, detail: `${rule.valeur} % ${what} (${Math.round(base)} €)`, warning: null };
}

/**
 * (Re)calcule toutes les commissions dues : vente, crédit et garantie au mois de la vente ; achat au mois
 * d'entrée (montant fixe) ou au mois de la vente (si calculé sur la marge ou le prix de vente).
 * Une commission déjà VERSÉE n'est jamais modifiée.
 */
export async function computeCommissions(companyId?: string) {
  await relinkStaff(companyId);
  const vehicles = await prisma.vehicle.findMany({
    where: { ...(companyId ? { companyId } : {}), OR: [{ sellerId: { not: null } }, { buyerId: { not: null } }] },
    include: { seller: true, buyer: true },
  });
  const out: Computed[] = [];
  for (const v of vehicles) {
    const sold = v.status === "VENDU" && v.saleDate;
    if (v.buyer) {
      const rule = parseRules(v.buyer.rules).ACHAT;
      const onSale = rule && rule.mode !== "FIXE";
      const when = onSale ? (sold ? v.saleDate : null) : v.entryDate;
      const r = when ? apply(rule, "ACHAT", v) : null;
      if (r && when && (r.amount || r.warning)) out.push({ employeeId: v.buyer.id, vehicleId: v.id, event: "ACHAT", month: monthKey(when), ...r });
    }
    if (v.seller && sold) {
      const rules = parseRules(v.seller.rules);
      for (const ev of ["VENTE", "CREDIT", "GARANTIE"] as const) {
        if (ev === "CREDIT" && !v.financingSold) continue;
        if (ev === "GARANTIE" && !v.warrantySold) continue;
        const r = apply(rules[ev], ev, v);
        if (r && (r.amount || r.warning)) out.push({ employeeId: v.seller.id, vehicleId: v.id, event: ev, month: monthKey(v.saleDate!), ...r });
      }
    }
  }
  let changed = 0;
  for (const c of out) {
    const existing = await prisma.commission.findUnique({ where: { employeeId_vehicleId_event: { employeeId: c.employeeId, vehicleId: c.vehicleId, event: c.event } } });
    if (existing?.status === "VERSE") continue;
    if (existing && existing.amount === c.amount && existing.month === c.month && existing.warning === c.warning) continue;
    await prisma.commission.upsert({
      where: { employeeId_vehicleId_event: { employeeId: c.employeeId, vehicleId: c.vehicleId, event: c.event } },
      update: { month: c.month, base: c.base, amount: c.amount, detail: c.detail, warning: c.warning },
      create: c,
    });
    changed++;
  }
  // Commissions devenues sans objet (vendeur changé, vente annulée) et jamais versées : supprimées.
  const keep = new Set(out.map((c) => `${c.employeeId}|${c.vehicleId}|${c.event}`));
  const stale = await prisma.commission.findMany({ where: { status: "A_VERSER", event: { not: "MANUEL" }, ...(companyId ? { employee: { companyId } } : {}) } });
  for (const s of stale) if (!keep.has(`${s.employeeId}|${s.vehicleId}|${s.event}`)) await prisma.commission.delete({ where: { id: s.id } });
  return { computed: out.length, changed };
}

/** Relevé à verser : par salarié, ce qui est dû pour le mois et tout ce qui reste impayé des mois précédents. */
export async function commissionStatement(month: string, companyId?: string) {
  const emps = await prisma.employee.findMany({
    where: { ...(companyId ? { companyId } : {}) },
    include: {
      commissions: { where: { OR: [{ month }, { status: "A_VERSER", month: { lt: month } }] }, include: { vehicle: true }, orderBy: { month: "asc" } },
      company: { select: { name: true } },
    },
    orderBy: { firstName: "asc" },
  });
  return emps
    .map((e) => {
      const dueNow = e.commissions.filter((c) => c.status === "A_VERSER");
      return {
        employeeId: e.id,
        salarie: `${e.firstName} ${e.lastName}`.trim(),
        societe: e.company.name,
        aVerser: Math.round(dueNow.reduce((s, c) => s + c.amount, 0) * 100) / 100,
        dontMoisPrecedents: Math.round(dueNow.filter((c) => c.month < month).reduce((s, c) => s + c.amount, 0) * 100) / 100,
        dejaVerseCeMois: Math.round(e.commissions.filter((c) => c.status === "VERSE" && c.month === month).reduce((s, c) => s + c.amount, 0) * 100) / 100,
        aVerifier: e.commissions.filter((c) => c.warning).length,
        lignes: e.commissions.map((c) => ({
          id: c.id,
          mois: c.month,
          type: c.event,
          vehicule: c.vehicle ? [c.vehicle.make, c.vehicle.model, c.vehicle.plate ?? c.vehicle.ref].filter(Boolean).join(" ") : "—",
          calcul: c.detail,
          montant: c.amount,
          statut: c.status,
          aVerifier: c.warning,
        })),
      };
    })
    .filter((e) => e.lignes.length);
}

// ------------------------------------------------------------------ congés

/** Nombre de jours ouvrés (lundi-vendredi) entre deux dates incluses. */
export function workingDays(start: Date, end: Date) {
  let n = 0;
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const e = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (d.getTime() <= e && n < 400) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return n;
}

/** Période de référence des congés payés : du 1er juin au 31 mai. */
export function leaveYear(now = new Date()) {
  const y = now.getMonth() >= 5 ? now.getFullYear() : now.getFullYear() - 1;
  return { start: new Date(Date.UTC(y, 5, 1)), end: new Date(Date.UTC(y + 1, 4, 31, 23, 59)) , label: `juin ${y} – mai ${y + 1}` };
}

/** Fiche complète d'un salarié pour son agent et pour la page Équipe. */
export async function employeeFile(employeeId: string, months = 12) {
  const e = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, include: { company: { select: { name: true } } } });
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  const [sold, bought, commissions, leaves] = await Promise.all([
    prisma.vehicle.findMany({ where: { sellerId: e.id, saleDate: { gte: since } }, orderBy: { saleDate: "desc" } }),
    prisma.vehicle.findMany({ where: { buyerId: e.id, entryDate: { gte: since } }, orderBy: { entryDate: "desc" } }),
    prisma.commission.findMany({ where: { employeeId: e.id, OR: [{ createdAt: { gte: since } }, { status: "A_VERSER" }] }, include: { vehicle: true }, orderBy: { month: "desc" } }),
    prisma.leave.findMany({ where: { employeeId: e.id }, orderBy: { start: "desc" }, take: 50 }),
  ]);
  const ly = leaveYear();
  const taken = leaves.filter((l) => l.type === "CP" && l.start >= ly.start && l.start <= ly.end).reduce((s, l) => s + l.days, 0);
  const label = (v: { make: string | null; model: string | null; plate: string | null; ref: string }) => [v.make, v.model, v.plate ?? v.ref].filter(Boolean).join(" ");
  return {
    salarie: { prenom: e.firstName, nom: e.lastName, poste: e.role, societe: e.company.name, entree: e.startDate?.toISOString().slice(0, 10) ?? null, salaireBrut: e.grossSalary },
    reglesCommission: Object.fromEntries(Object.entries(parseRules(e.rules)).map(([k, r]) => [k, describeRule(r)])),
    conditions: e.rulesNote,
    vehiculesVendus: sold.map((v) => ({ vehicule: label(v), date: v.saleDate?.toISOString().slice(0, 10), prix: v.salePrice, marge: vehicleMargin(v), credit: v.financingSold, garantie: v.warrantySold })),
    vehiculesAchetes: bought.map((v) => ({ vehicule: label(v), date: v.entryDate?.toISOString().slice(0, 10), mode: v.mode, prixAchat: v.purchasePrice, statut: v.status })),
    commissions: commissions.map((c) => ({ mois: c.month, type: c.event, vehicule: c.vehicle ? label(c.vehicle) : "—", montant: c.amount, statut: c.status, versele: c.paidAt?.toISOString().slice(0, 10) ?? null, calcul: c.detail, aVerifier: c.warning })),
    totalAVerser: Math.round(commissions.filter((c) => c.status === "A_VERSER").reduce((s, c) => s + c.amount, 0) * 100) / 100,
    conges: {
      periode: ly.label,
      droitAnnuel: e.leaveDaysPerYear,
      pris: taken,
      restant: e.leaveDaysPerYear - taken,
      poses: leaves.map((l) => ({ du: l.start.toISOString().slice(0, 10), au: l.end.toISOString().slice(0, 10), jours: l.days, type: l.type, note: l.note })),
    },
  };
}
