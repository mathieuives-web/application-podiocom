import Anthropic from "@anthropic-ai/sdk";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import path from "path";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { prisma } from "@/lib/prisma";
import { categorize, autoReconcile } from "@/lib/finance";
import { importVehicleSheet } from "@/lib/vehicles";
import { ContractSchema, CONTRACT_INSTRUCTION, computeCommissions } from "@/lib/team";
import { parseStatementBuffer, readSheet, parseAmount, parseDate, type ParsedLine } from "@/lib/statement-import";

// Archives : bilans, relevés bancaires et exports de factures.
// Chaque fichier est chiffré (AES-256-GCM) avant d'être écrit sur le disque ; la clé est dérivée de
// AUTH_SECRET et n'est jamais stockée. L'IA lit les PDF pour en extraire les chiffres utiles aux agents.

export const DOC_TYPES = {
  BILAN: "Bilan / liasse fiscale / compte de résultat",
  RELEVE: "Relevé bancaire",
  FACTURES: "Export de factures (CSV / Excel)",
  VEHICULES: "Export Auto Cerfa : stock / ventes de véhicules (Excel / CSV)",
  CONTRAT: "Contrat de travail d'un salarié (PDF)",
  TERRAIN: "Photo / pièce du terrain (frais, besoin, intervention)",
  FACTURE_FOURNISSEUR: "Facture fournisseur (PDF ou photo)",
  AUTRE: "Autre document",
} as const;
export type DocType = keyof typeof DOC_TYPES;

const MAX_SIZE = 30 * 1024 * 1024;
const ALLOWED = /\.(pdf|csv|txt|xls|xlsx|jpg|jpeg|png|webp|gif)$/i;

function dataDir() {
  return path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "documents");
}

function key() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET manquant : impossible de chiffrer les documents.");
  return createHash("sha256").update(`start-invest-documents:${secret}`).digest();
}

function encrypt(buf: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

function decrypt(buf: Buffer) {
  const d = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}

export async function readDocument(id: string) {
  const doc = await prisma.document.findUniqueOrThrow({ where: { id } });
  return { doc, content: decrypt(await readFile(path.join(dataDir(), doc.storagePath))) };
}

export async function saveDocument(
  file: File,
  meta: { companyId: string; type: DocType; year?: number | null; accountId?: string | null; uploadedBy?: string | null }
) {
  if (!ALLOWED.test(file.name)) throw new Error(`${file.name} : format non accepté (PDF, CSV, XLS, XLSX, photo JPG / PNG).`);
  if (file.size > MAX_SIZE) throw new Error(`${file.name} : fichier trop lourd (30 Mo maximum).`);
  const buf = Buffer.from(await file.arrayBuffer());
  if (/\.pdf$/i.test(file.name) && buf.subarray(0, 5).toString() !== "%PDF-") throw new Error(`${file.name} : ce n'est pas un vrai PDF.`);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const existing = await prisma.document.findUnique({ where: { companyId_sha256: { companyId: meta.companyId, sha256 } } });
  if (existing) return { doc: existing, duplicate: true };
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const storagePath = `${randomBytes(16).toString("hex")}.enc`;
  await writeFile(path.join(dataDir(), storagePath), encrypt(buf), { mode: 0o600 });
  const doc = await prisma.document.create({
    data: {
      companyId: meta.companyId,
      type: meta.type,
      year: meta.year ?? null,
      accountId: meta.accountId ?? null,
      fileName: file.name.slice(0, 200),
      mime: file.type || "application/octet-stream",
      size: file.size,
      sha256,
      storagePath,
      uploadedBy: meta.uploadedBy ?? null,
    },
  });
  return { doc, duplicate: false };
}

export async function deleteDocument(id: string) {
  const doc = await prisma.document.findUniqueOrThrow({ where: { id } });
  await unlink(path.join(dataDir(), doc.storagePath)).catch(() => undefined);
  await prisma.document.delete({ where: { id } });
}

// ------------------------------------------------------------------ extraction par l'IA

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

const num = z.number().nullable();
const BilanSchema = z.object({
  exercices: z.array(
    z.object({
      annee: z.number().int().describe("Année de clôture de l'exercice"),
      chiffre_affaires: num,
      marge_brute: num,
      salaires_et_charges_sociales: num,
      ebe: num.describe("Excédent brut d'exploitation"),
      resultat_exploitation: num,
      resultat_net: num,
      capitaux_propres: num,
      total_bilan: num,
      disponibilites: num,
      emprunts_et_dettes_financieres: num,
      creances_clients: num,
      dettes_fournisseurs: num,
      stocks: num,
    })
  ),
  points_attention: z.string().describe("3 à 6 observations courtes d'un directeur financier sur ces comptes"),
});

const ReleveSchema = z.object({
  operations: z.array(
    z.object({
      date: z.string().describe("AAAA-MM-JJ"),
      libelle: z.string(),
      montant: z.number().describe("Positif pour un crédit (entrée d'argent), négatif pour un débit"),
    })
  ),
  solde_final: num.describe("Solde à la fin du relevé, si indiqué"),
  date_solde_final: z.string().nullable(),
});

async function extract<T>(pdf: Buffer, schema: z.ZodType<T>, instruction: string, mime = "application/pdf"): Promise<T> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("Lecture des PDF par l'IA impossible : ANTHROPIC_API_KEY manquante.");
  }
  const stream = anthropic().beta.messages.stream({
    model: "claude-opus-5-5",
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // Le convertisseur du SDK adapte le schéma aux contraintes des réponses structurées (pas de min/max, pas de $schema...).
    output_config: { format: betaZodOutputFormat(schema) },
    messages: [
      {
        role: "user",
        content: [
          /^image\/(jpeg|png|gif|webp)$/.test(mime)
            ? { type: "image", source: { type: "base64", media_type: mime as "image/jpeg", data: pdf.toString("base64") } }
            : { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
          { type: "text", text: instruction },
        ],
      },
    ],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("Le document n'a pas pu être lu par l'IA.");
  if (msg.stop_reason === "max_tokens") throw new Error("Document trop long : découpez-le (par exemple un relevé par trimestre).");
  const text = msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return schema.parse(JSON.parse(text));
}

const SupplierInvoiceSchema = z.object({
  est_une_facture: z.boolean().describe("false si ce n'est pas une facture (devis, bon de livraison, publicité...)"),
  fournisseur: z.string(),
  numero: z.string().nullable(),
  date: z.string().nullable().describe("AAAA-MM-JJ"),
  echeance: z.string().nullable().describe("AAAA-MM-JJ"),
  montant_ttc: z.number().nullable(),
  montant_ht: z.number().nullable(),
  deja_payee: z.boolean().describe("true si la facture indique « payée », « acquittée » ou un prélèvement / paiement CB déjà fait"),
  objet: z.string().describe("Ce qui est facturé, en une phrase (ex. « plaquettes + disques AV, réf. ..., pour AB-123-CD »)"),
  immatriculation: z.string().nullable(),
});

const lineId = (l: ParsedLine, n: number) =>
  "rel-" + createHash("sha1").update(`${l.date.toISOString().slice(0, 10)}|${l.label}|${l.amount.toFixed(2)}|${n}`).digest("hex").slice(0, 20);

/** Importe des lignes de relevé sans doublon, ni avec un import précédent ni avec la synchro bancaire. */
export async function importLines(accountId: string, lines: ParsedLine[]) {
  const account = await prisma.bankAccount.findUniqueOrThrow({ where: { id: accountId } });
  // Sur un compte synchronisé (Shine, Qonto...), on n'importe que l'historique ANTÉRIEUR à la synchro.
  const firstSynced = await prisma.bankTransaction.findFirst({
    where: { accountId, NOT: { externalId: { startsWith: "rel-" } } },
    orderBy: { date: "asc" },
  });
  const seen = new Map<string, number>();
  let created = 0;
  let skipped = 0;
  for (const l of lines) {
    if (firstSynced && l.date >= firstSynced.date) {
      skipped++;
      continue;
    }
    const base = `${l.date.toISOString().slice(0, 10)}|${l.label}|${l.amount.toFixed(2)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const externalId = lineId(l, n);
    const exists = await prisma.bankTransaction.findUnique({ where: { accountId_externalId: { accountId, externalId } } });
    if (exists) continue;
    await prisma.bankTransaction.create({
      data: { accountId, companyId: account.companyId, externalId, date: l.date, label: l.label, amount: l.amount, category: categorize(l.label, l.amount) },
    });
    created++;
  }
  return { created, skipped };
}

function parseInvoicesSheet(rows: unknown[][]) {
  const norm = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const h = rows[i].map(norm);
    const find = (re: RegExp) => h.findIndex((c) => re.test(c));
    const col = {
      number: find(/num|n°|^no\b|reference|facture/),
      client: find(/client|tiers|raison sociale|destinataire|nom/),
      email: find(/e-?mail|courriel/),
      date: find(/^date( (de )?(facture|emission))?$|date facture|emission|^date/),
      due: find(/echeance|due|limite/),
      amount: find(/ttc|montant|total|amount/),
      rest: find(/reste|restant|solde du|du$/),
      status: find(/statut|etat|status|paye/),
    };
    if (col.client < 0 || col.amount < 0) continue;
    return rows.slice(i + 1).flatMap((r) => {
      const amount = parseAmount(r[col.amount]);
      const client = String(r[col.client] ?? "").trim();
      if (!client || amount === null || amount === 0) return [];
      const status = col.status >= 0 ? norm(r[col.status]) : "";
      const rest = col.rest >= 0 ? parseAmount(r[col.rest]) : null;
      const paid = /pay|regle|solde|encaiss/.test(status) && !/non|impay|partiel/.test(status);
      return [
        {
          number: col.number >= 0 ? String(r[col.number] ?? "").trim() || null : null,
          counterparty: client.slice(0, 200),
          counterpartyEmail: col.email >= 0 ? String(r[col.email] ?? "").trim() || null : null,
          issueDate: (col.date >= 0 && parseDate(r[col.date])) || new Date(),
          dueDate: col.due >= 0 ? parseDate(r[col.due]) : null,
          amount,
          paidAmount: paid ? amount : rest !== null ? Math.max(0, amount - rest) : 0,
        },
      ];
    });
  }
  throw new Error("Colonnes non reconnues : il faut au moins Client et Montant TTC (et idéalement Numéro, Date, Échéance, Statut ou Reste dû, E-mail).");
}

/** Traite un document : lecture, extraction, import. Appelé en arrière-plan après le dépôt. */
export async function processDocument(id: string) {
  const { doc, content } = await readDocument(id);
  await prisma.document.update({ where: { id }, data: { status: "PROCESSING", error: null } });
  const isPdf = /\.pdf$/i.test(doc.fileName);
  try {
    let summary = "Archivé.";
    if (doc.type === "BILAN") {
      if (!isPdf) throw new Error("Déposez le bilan en PDF.");
      const r = await extract(
        content,
        BilanSchema,
        "Tu es directeur financier. Ce document est un bilan / une liasse fiscale / un compte de résultat d'une société française. Extrais les chiffres clés en euros pour CHAQUE exercice présent (souvent N et N-1). Mets null pour une valeur absente : n'invente rien. Les pertes sont négatives."
      );
      for (const e of r.exercices) {
        const data = {
          documentId: doc.id,
          revenue: e.chiffre_affaires,
          grossMargin: e.marge_brute,
          payroll: e.salaires_et_charges_sociales,
          ebitda: e.ebe,
          operatingIncome: e.resultat_exploitation,
          netIncome: e.resultat_net,
          equity: e.capitaux_propres,
          totalAssets: e.total_bilan,
          cash: e.disponibilites,
          debt: e.emprunts_et_dettes_financieres,
          receivables: e.creances_clients,
          payables: e.dettes_fournisseurs,
          stock: e.stocks,
          notes: r.points_attention,
        };
        await prisma.financialStatement.upsert({
          where: { companyId_year: { companyId: doc.companyId, year: e.annee } },
          update: data,
          create: { ...data, companyId: doc.companyId, year: e.annee },
        });
      }
      const years = r.exercices.map((e) => e.annee).join(", ");
      summary = `Exercice(s) ${years || "?"} extrait(s). ${r.points_attention}`;
    } else if (doc.type === "RELEVE") {
      if (!doc.accountId) throw new Error("Choisissez le compte bancaire du relevé.");
      let lines: ParsedLine[];
      let closing: { amount: number; date: Date } | null = null;
      if (isPdf) {
        const r = await extract(
          content,
          ReleveSchema,
          "Ce document est un relevé bancaire. Liste TOUTES les opérations, dans l'ordre, sans en oublier ni en inventer : date (AAAA-MM-JJ), libellé complet, montant (positif pour un crédit, négatif pour un débit). Ignore les lignes de solde, de total et de report. Donne le solde final s'il est indiqué."
        );
        lines = r.operations.flatMap((o) => {
          const date = parseDate(o.date);
          return date && o.libelle && o.montant ? [{ date, label: o.libelle.replace(/\s+/g, " ").trim(), amount: o.montant }] : [];
        });
        if (r.solde_final !== null && r.date_solde_final) {
          const d = parseDate(r.date_solde_final);
          if (d) closing = { amount: r.solde_final, date: d };
        }
      } else {
        lines = parseStatementBuffer(content, doc.fileName, doc.mime);
      }
      const { created, skipped } = await importLines(doc.accountId, lines);
      const account = await prisma.bankAccount.findUniqueOrThrow({ where: { id: doc.accountId } });
      // Le solde du relevé ne remplace le solde du compte que pour un compte saisi à la main, et s'il est plus récent.
      if (closing && account.provider === "MANUAL" && (!account.lastSyncAt || closing.date >= account.lastSyncAt)) {
        await prisma.bankAccount.update({ where: { id: account.id }, data: { balance: closing.amount, lastSyncAt: closing.date } });
      }
      const matched = await autoReconcile(doc.companyId);
      summary = `${lines.length} opération(s) lue(s), ${created} importée(s)${skipped ? `, ${skipped} ignorée(s) car déjà fournies par la synchronisation bancaire` : ""}, ${matched} facture(s) rapprochée(s).`;
    } else if (doc.type === "FACTURES") {
      if (isPdf) throw new Error("Déposez l'export des factures en CSV ou Excel (export depuis votre logiciel de facturation).");
      const invoices = parseInvoicesSheet(readSheet(content, doc.fileName, doc.mime));
      let n = 0;
      for (const inv of invoices) {
        const externalId = "imp-" + createHash("sha1").update(`${doc.companyId}|${inv.number ?? ""}|${inv.counterparty}|${inv.amount}|${inv.issueDate.toISOString().slice(0, 10)}`).digest("hex").slice(0, 20);
        await prisma.invoice.upsert({
          where: { provider_externalId: { provider: "IMPORT", externalId } },
          update: { paidAmount: inv.paidAmount, dueDate: inv.dueDate, counterpartyEmail: inv.counterpartyEmail },
          create: { ...inv, kind: "CLIENT", provider: "IMPORT", externalId, companyId: doc.companyId },
        });
        n++;
      }
      const matched = await autoReconcile(doc.companyId);
      summary = `${n} facture(s) importée(s) ou mises à jour, ${matched} rapprochée(s) avec la banque.`;
    } else if (doc.type === "FACTURE_FOURNISSEUR") {
      const isImg = /\.(jpe?g|png|webp|gif)$/i.test(doc.fileName);
      if (!isPdf && !isImg) throw new Error("Déposez la facture en PDF ou en photo.");
      const mime = isImg ? (doc.mime.startsWith("image/") ? doc.mime : "image/jpeg") : "application/pdf";
      const r = await extract(content, SupplierInvoiceSchema, "Ce document a été reçu par une entreprise (garage, restaurant, bar...). Si c'est une facture d'un fournisseur, extrais exactement ce qui est écrit. N'invente aucun chiffre : null si absent.", mime);
      if (!r.est_une_facture || r.montant_ttc === null) {
        summary = `Pas une facture exploitable (${r.objet}).`;
      } else {
        const externalId = "ff-" + createHash("sha1").update(`${doc.companyId}|${r.fournisseur}|${r.numero ?? ""}|${r.montant_ttc}|${r.date ?? ""}`).digest("hex").slice(0, 20);
        await prisma.invoice.upsert({
          where: { provider_externalId: { provider: "DOCUMENT", externalId } },
          update: {},
          create: {
            companyId: doc.companyId,
            kind: "SUPPLIER",
            provider: "DOCUMENT",
            externalId,
            number: r.numero,
            counterparty: r.fournisseur.slice(0, 200),
            label: `${r.objet}${r.immatriculation ? ` — ${r.immatriculation}` : ""}`.slice(0, 300),
            issueDate: (r.date && parseDate(r.date)) || new Date(),
            dueDate: r.echeance ? parseDate(r.echeance) : null,
            amount: r.montant_ttc,
            paidAmount: r.deja_payee ? r.montant_ttc : 0,
          },
        });
        const matched = await autoReconcile(doc.companyId);
        summary = `Facture ${r.fournisseur}${r.numero ? ` n° ${r.numero}` : ""} : ${r.montant_ttc} € TTC${r.echeance ? `, échéance ${r.echeance}` : ""}${r.deja_payee ? " (déjà payée)" : ""}. ${r.objet}.${matched ? ` ${matched} rapprochement(s) bancaire(s).` : ""}`;
      }
    } else if (doc.type === "VEHICULES") {
      if (isPdf) throw new Error("Déposez l'export Auto Cerfa en Excel ou CSV (menu Stock → Export Excel, ou export des ventes / export comptable).");
      const r = await importVehicleSheet(doc.companyId, readSheet(content, doc.fileName, doc.mime), doc.fileName);
      const c = await computeCommissions(doc.companyId);
      summary = `${r.created} véhicule(s) ajouté(s), ${r.updated} mis à jour. Commissions recalculées (${c.changed} modifiée(s)).${r.unknownStaff.length ? ` Salariés non reconnus : ${r.unknownStaff.slice(0, 10).join(", ")} — déposez leur contrat ou créez-les dans Équipe, puis relisez ce fichier.` : ""}`;
    } else if (doc.type === "CONTRAT") {
      if (!isPdf) throw new Error("Déposez le contrat de travail en PDF.");
      const r = await extract(content, ContractSchema, CONTRACT_INSTRUCTION);
      const rules = Object.fromEntries(Object.entries(r.commissions).filter(([, v]) => v));
      const startDate = r.date_entree ? parseDate(r.date_entree) : null;
      const data = {
        role: r.poste,
        startDate,
        grossSalary: r.salaire_brut_mensuel,
        leaveDaysPerYear: r.conges_jours_par_an ?? 25,
        rules: JSON.stringify(rules),
        rulesNote: r.conditions,
        contractDocumentId: doc.id,
      };
      const firstName = r.prenom.trim().replace(/^./, (x) => x.toUpperCase());
      const lastName = (r.nom ?? "").trim().toUpperCase();
      const emp = await prisma.employee.upsert({
        where: { companyId_firstName_lastName: { companyId: doc.companyId, firstName, lastName } },
        update: data,
        create: { ...data, companyId: doc.companyId, firstName, lastName },
      });
      await computeCommissions(doc.companyId);
      summary = `Salarié ${emp.firstName} ${emp.lastName} : ${Object.keys(rules).length} règle(s) de commission (${Object.keys(rules).join(", ") || "aucune"}). ${r.conditions}`;
    }
    await prisma.document.update({ where: { id }, data: { status: "DONE", summary } });
  } catch (e) {
    const message = e instanceof Anthropic.APIError ? `Erreur API Claude (${e.status}) : ${e.message}` : (e as Error).message;
    console.log(`[document] ${doc.fileName} ÉCHEC : ${message.slice(0, 400)}`);
    await prisma.document.update({ where: { id }, data: { status: "ERROR", error: message.slice(0, 500) } });
  }
}
