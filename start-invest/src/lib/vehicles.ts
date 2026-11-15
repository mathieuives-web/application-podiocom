import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { prisma } from "@/lib/prisma";
import { parseAmount, parseDate } from "@/lib/statement-import";

// Stock de véhicules importé depuis les exports Excel / CSV d'Auto Cerfa (export du stock, des ventes,
// export comptable). Auto Cerfa n'a pas d'API de stock ouverte : on lit ses exports.
// La première fois qu'un format d'export est vu, l'IA reconnaît les colonnes ; la correspondance est
// mémorisée et réutilisée ensuite (import 100 % déterministe, sans IA).

export const VEHICLE_FIELDS = {
  ref: "N° de stock / n° de dossier / n° livre de police",
  plate: "Immatriculation",
  vin: "N° de série (VIN)",
  make: "Marque",
  model: "Modèle",
  version: "Version / finition",
  year: "Année / date de 1re mise en circulation",
  mileage: "Kilométrage",
  mode: "Type d'entrée : achat ou dépôt-vente (mandat)",
  status: "Statut (en stock, vendu, réservé...)",
  entryDate: "Date d'entrée en stock / date d'achat",
  purchasePrice: "Prix d'achat",
  costs: "Frais sur le véhicule (préparation, mécanique, carrosserie, CT, transport, frais de remise en route...) — plusieurs colonnes possibles, elles sont additionnées",
  costsTotal: "Total des frais déjà calculé (si l'export le donne)",
  askingPrice: "Prix de vente affiché / prix public",
  saleDate: "Date de vente / de facture de vente",
  salePrice: "Prix de vente réel (TTC facturé)",
  sellerPayout: "Dépôt-vente : montant reversé au propriétaire",
  depotFee: "Dépôt-vente : commission / frais de dépôt gardés par la société",
  margin: "Marge déjà calculée par le logiciel (sert de contrôle)",
  financingSold: "Crédit / financement vendu (oui/non ou organisme)",
  financingIncome: "Commission de financement perçue",
  warrantySold: "Garantie vendue (oui/non ou nom de la garantie)",
  warrantyPrice: "Prix de la garantie vendue",
  buyerName: "Salarié qui a acheté / rentré le véhicule (acheteur)",
  sellerName: "Salarié qui a vendu le véhicule (vendeur, commercial)",
  customer: "Client acheteur / propriétaire (dépôt-vente)",
  ignore: "Colonne inutile",
} as const;
type Field = keyof typeof VEHICLE_FIELDS;

const MappingSchema = z.object({
  ligne_entetes: z.number().int().describe("Index (0 = première ligne) de la ligne qui contient les en-têtes de colonnes"),
  colonnes: z.array(z.object({ index: z.number().int(), champ: z.enum(Object.keys(VEHICLE_FIELDS) as [Field, ...Field[]]) })),
  type_par_defaut: z.enum(["ACHAT", "DEPOT_VENTE", "INCONNU"]).describe("Si aucune colonne ne dit achat / dépôt-vente : ce que contient le fichier"),
});
type Mapping = z.infer<typeof MappingSchema>;

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

const norm = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

async function detectMapping(rows: unknown[][], fileName: string): Promise<Mapping> {
  // Signature = première ligne « riche » du fichier : même export Auto Cerfa -> même correspondance.
  const headerGuess = rows.slice(0, 15).find((r) => r.filter((c) => String(c ?? "").trim()).length >= 4) ?? rows[0] ?? [];
  const sig = createHash("sha1").update(headerGuess.map(norm).join("|")).digest("hex").slice(0, 16);
  const key = `vehicle-mapping:${sig}`;
  const saved = await prisma.appSetting.findUnique({ where: { key } });
  if (saved) return MappingSchema.parse(JSON.parse(saved.value));
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("Reconnaissance des colonnes impossible : ANTHROPIC_API_KEY manquante.");
  }
  const sample = rows.slice(0, 25).map((r, i) => `${i}: ${r.map((c, j) => `[${j}] ${String(c instanceof Date ? c.toISOString().slice(0, 10) : c ?? "").slice(0, 40)}`).join(" ")}`).join("\n");
  const fields = Object.entries(VEHICLE_FIELDS).map(([k, v]) => `- ${k} : ${v}`).join("\n");
  const stream = anthropic().beta.messages.stream({
    model: "claude-opus-5-5",
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { format: betaZodOutputFormat(MappingSchema) },
    messages: [
      {
        role: "user",
        content: `Voici le début d'un export Excel du logiciel de gestion de véhicules d'occasion Auto Cerfa (fichier « ${fileName} »).
Indique la ligne d'en-têtes, puis pour CHAQUE colonne utile le champ correspondant parmi :
${fields}
Plusieurs colonnes de frais -> toutes en « costs ». Ne mets une colonne dans un champ que si tu en es sûr ; sinon « ignore ».

${sample}`,
      },
    ],
  });
  const msg = await stream.finalMessage();
  const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
  const mapping = MappingSchema.parse(JSON.parse(text));
  await prisma.appSetting.upsert({ where: { key }, update: { value: JSON.stringify(mapping) }, create: { key, value: JSON.stringify(mapping) } });
  return mapping;
}

const yes = (v: unknown) => {
  const s = norm(v);
  if (!s || /^(non|no|n|0|false|-|aucun|aucune|sans)$/.test(s)) return false;
  const n = parseAmount(v);
  return n === null ? true : n > 0;
};

function rowToVehicle(r: unknown[], m: Mapping) {
  const get = (f: Field) => m.colonnes.filter((c) => c.champ === f).map((c) => r[c.index]);
  const one = (f: Field) => get(f).find((v) => String(v ?? "").trim() !== "");
  const text = (f: Field) => {
    const v = one(f);
    return v === undefined ? null : String(v instanceof Date ? v.toISOString().slice(0, 10) : v).trim().slice(0, 200) || null;
  };
  const amount = (f: Field) => {
    const v = one(f);
    const n = v === undefined ? null : parseAmount(v);
    return n === null ? null : Math.abs(n);
  };
  const date = (f: Field) => {
    const v = one(f);
    if (v instanceof Date) return v;
    return v === undefined ? null : parseDate(v);
  };
  const costParts = m.colonnes
    .filter((c) => c.champ === "costs")
    .map((c) => ({ libelle: "", montant: parseAmount(r[c.index]) ?? 0, index: c.index }))
    .filter((c) => c.montant);
  const costsTotal = amount("costsTotal");
  const modeText = norm([text("mode"), text("status")].join(" "));
  const mode = /depot|d\.?v\b|mandat|confi/.test(modeText) ? "DEPOT_VENTE" : /achat|rachat|reprise|propre/.test(modeText) ? "ACHAT" : m.type_par_defaut === "DEPOT_VENTE" ? "DEPOT_VENTE" : "ACHAT";
  const saleDate = date("saleDate");
  const salePrice = amount("salePrice");
  const statusText = norm(text("status"));
  const sold = Boolean(saleDate) || /vendu|livre|facture|sorti/.test(statusText);
  const yearRaw = one("year");
  const year = yearRaw instanceof Date ? yearRaw.getFullYear() : Number(String(yearRaw ?? "").match(/(19|20)\d{2}/)?.[0]) || null;
  const plate = text("plate")?.toUpperCase().replace(/\s/g, "") ?? null;
  const vin = text("vin")?.toUpperCase().replace(/\s/g, "") ?? null;
  const ref = text("ref") ?? plate ?? vin;
  return {
    ref,
    plate,
    vin,
    make: text("make"),
    model: text("model"),
    version: text("version"),
    year,
    mileage: (() => {
      const n = parseAmount(one("mileage"));
      return n === null ? null : Math.round(Math.abs(n));
    })(),
    mode,
    status: sold ? "VENDU" : "STOCK",
    entryDate: date("entryDate"),
    purchasePrice: amount("purchasePrice"),
    costs: costsTotal ?? costParts.reduce((s, c) => s + Math.abs(c.montant), 0),
    costsDetail: costParts.length > 1 ? JSON.stringify(costParts.map((c) => ({ colonne: c.index, montant: Math.abs(c.montant) }))) : null,
    askingPrice: amount("askingPrice"),
    saleDate,
    salePrice,
    sellerPayout: amount("sellerPayout"),
    depotFee: amount("depotFee"),
    financingSold: get("financingSold").some(yes) || (amount("financingIncome") ?? 0) > 0,
    financingIncome: amount("financingIncome"),
    warrantySold: get("warrantySold").some(yes) || (amount("warrantyPrice") ?? 0) > 0,
    warrantyPrice: amount("warrantyPrice"),
    buyerName: text("buyerName"),
    sellerName: text("sellerName"),
    customer: text("customer"),
  };
}
export type VehicleData = ReturnType<typeof rowToVehicle>;

/** Associe un nom écrit dans l'export (« Kevin », « K. Martin », « MARTIN Kevin ») à un salarié. */
export async function matchEmployee(companyId: string, name: string | null) {
  if (!name) return null;
  const n = norm(name);
  const emps = await prisma.employee.findMany({ where: { companyId } });
  const hits = emps.filter((e) => {
    const f = norm(e.firstName);
    const l = norm(e.lastName);
    return (f && new RegExp(`\\b${f}\\b`).test(n)) || (l.length > 2 && new RegExp(`\\b${l}\\b`).test(n)) || n === norm(`${f} ${l}`);
  });
  return hits.length === 1 ? hits[0].id : null;
}

/** Relie aux salariés les véhicules dont l'acheteur / le vendeur n'était pas encore connu (contrat déposé après l'export). */
export async function relinkStaff(companyId?: string) {
  const list = await prisma.vehicle.findMany({
    where: { ...(companyId ? { companyId } : {}), OR: [{ sellerId: null, sellerName: { not: null } }, { buyerId: null, buyerName: { not: null } }] },
  });
  let n = 0;
  for (const v of list) {
    const locked = v.manualFields.split(",");
    const sellerId = !v.sellerId && !locked.includes("sellerId") ? await matchEmployee(v.companyId, v.sellerName) : null;
    const buyerId = !v.buyerId && !locked.includes("buyerId") ? await matchEmployee(v.companyId, v.buyerName) : null;
    if (sellerId || buyerId) {
      await prisma.vehicle.update({ where: { id: v.id }, data: { ...(sellerId ? { sellerId } : {}), ...(buyerId ? { buyerId } : {}) } });
      n++;
    }
  }
  return n;
}

export async function importVehicleSheet(companyId: string, rows: unknown[][], fileName: string) {
  const m = await detectMapping(rows, fileName);
  const fieldsFound = new Set(m.colonnes.map((c) => c.champ));
  if (!fieldsFound.has("ref") && !fieldsFound.has("plate") && !fieldsFound.has("vin")) {
    throw new Error("Aucune colonne d'identification du véhicule (n° de stock, immatriculation ou VIN) n'a été trouvée dans ce fichier.");
  }
  let created = 0;
  let updated = 0;
  const unknownStaff = new Set<string>();
  for (const r of rows.slice(m.ligne_entetes + 1)) {
    if (!r.some((c) => String(c ?? "").trim())) continue;
    const v = rowToVehicle(r, m);
    if (!v.ref) continue;
    const existing = await prisma.vehicle.findUnique({ where: { companyId_ref: { companyId, ref: v.ref } } });
    const locked = new Set((existing?.manualFields ?? "").split(",").filter(Boolean));
    const buyerId = await matchEmployee(companyId, v.buyerName);
    const sellerId = await matchEmployee(companyId, v.sellerName);
    if (v.buyerName && !buyerId) unknownStaff.add(v.buyerName);
    if (v.sellerName && !sellerId) unknownStaff.add(v.sellerName);
    const data: Record<string, unknown> = { ...v, buyerId, sellerId };
    // Une colonne absente de cet export ne doit pas effacer ce qu'un autre export a apporté.
    for (const [k, val] of Object.entries(data)) {
      if (locked.has(k) || ((val === null || val === undefined || val === "" || val === false || val === 0) && existing)) delete data[k];
    }
    if (existing && existing.status === "VENDU" && data.status === "STOCK") delete data.status; // l'export du stock ne « dévend » pas un véhicule
    if (existing) {
      await prisma.vehicle.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.vehicle.create({ data: { ...(data as typeof v), ref: v.ref, companyId } });
      created++;
    }
  }
  return { created, updated, unknownStaff: [...unknownStaff] };
}

// ------------------------------------------------------------------ marges

type V = {
  mode: string;
  status: string;
  purchasePrice: number | null;
  costs: number;
  salePrice: number | null;
  sellerPayout: number | null;
  depotFee: number | null;
  financingIncome: number | null;
  warrantyPrice: number | null;
  entryDate: Date | null;
  saleDate: Date | null;
};

/** Marge réelle d'un véhicule vendu (hors crédit et garantie, comptés à part). null si une donnée manque. */
export function vehicleMargin(v: V): number | null {
  if (v.status !== "VENDU" || v.salePrice === null) return null;
  if (v.mode === "DEPOT_VENTE") {
    if (v.depotFee !== null) return v.depotFee - v.costs;
    if (v.sellerPayout !== null) return v.salePrice - v.sellerPayout - v.costs;
    return null;
  }
  if (v.purchasePrice === null) return null;
  return v.salePrice - v.purchasePrice - v.costs;
}

export function daysInStock(v: V, now = new Date()) {
  if (!v.entryDate) return null;
  const end = v.saleDate ?? now;
  return Math.max(0, Math.round((end.getTime() - v.entryDate.getTime()) / 86400000));
}

/** Synthèse stock et ventes d'une société (ou du groupe) pour les agents et les pages. */
export async function vehicleSummary(companyId?: string, months = 12) {
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  const vehicles = await prisma.vehicle.findMany({
    where: { ...(companyId ? { companyId } : {}), OR: [{ status: "STOCK" }, { saleDate: { gte: since } }] },
    include: { seller: true, buyer: true },
    orderBy: { entryDate: "asc" },
  });
  const stock = vehicles.filter((v) => v.status === "STOCK");
  const sold = vehicles.filter((v) => v.status === "VENDU");
  const margins = sold.map((v) => vehicleMargin(v)).filter((m): m is number => m !== null);
  const round = (n: number) => Math.round(n);
  return {
    stock: {
      total: stock.length,
      achats: stock.filter((v) => v.mode === "ACHAT").length,
      depotsVente: stock.filter((v) => v.mode === "DEPOT_VENTE").length,
      valeurAchatImmobilisee: round(stock.filter((v) => v.mode === "ACHAT").reduce((s, v) => s + (v.purchasePrice ?? 0) + v.costs, 0)),
      plusDe90Jours: stock.filter((v) => (daysInStock(v) ?? 0) > 90).map((v) => ({ ref: v.ref, vehicule: [v.make, v.model].filter(Boolean).join(" "), jours: daysInStock(v), mode: v.mode, prixAchat: v.purchasePrice, frais: v.costs, prixAffiche: v.askingPrice })),
    },
    ventes: {
      periodeMois: months,
      nombre: sold.length,
      chiffreAffaires: round(sold.reduce((s, v) => s + (v.salePrice ?? 0), 0)),
      margeTotale: round(margins.reduce((s, m) => s + m, 0)),
      margeMoyenne: margins.length ? round(margins.reduce((s, m) => s + m, 0) / margins.length) : null,
      margeInconnue: sold.length - margins.length,
      creditsVendus: sold.filter((v) => v.financingSold).length,
      garantiesVendues: sold.filter((v) => v.warrantySold).length,
      revenusFinancement: round(sold.reduce((s, v) => s + (v.financingIncome ?? 0), 0)),
      revenusGaranties: round(sold.reduce((s, v) => s + (v.warrantyPrice ?? 0), 0)),
      dureeMoyenneEnStock: (() => {
        const d = sold.map((v) => daysInStock(v)).filter((x): x is number => x !== null);
        return d.length ? round(d.reduce((s, x) => s + x, 0) / d.length) : null;
      })(),
      ventesAPerte: sold.filter((v) => (vehicleMargin(v) ?? 0) < 0).map((v) => ({ ref: v.ref, vehicule: [v.make, v.model].filter(Boolean).join(" "), marge: vehicleMargin(v) })),
    },
  };
}
