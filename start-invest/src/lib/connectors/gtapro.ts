import Anthropic from "@anthropic-ai/sdk";
import { trackAiSpend } from "@/lib/ai-cost";
import { createHash } from "crypto";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { prisma } from "@/lib/prisma";
import { encryptJson, decryptJson } from "@/lib/crypto";
import { parseDate } from "@/lib/statement-import";
import { fillDocument, readScreens, withSite, type SiteAccess } from "./web-operator";
import type { SyncResult } from "./types";

// GTA Pro (logiciel d'atelier d'Auto Rac'Ives) : pas d'API. Le robot se connecte (session gardée chiffrée
// ou identifiants chiffrés) :
// - plusieurs fois par jour, il LIT les factures (payées / reste dû) -> contrôle des paiements, rapprochement
//   bancaire et relances, et la liste des devis et ordres de réparation en cours ;
// - il SAISIT les devis et OR préparés par l'agent de l'atelier, une fois VALIDÉS par le fondateur.

export type GtaProCreds = { login?: string; password?: string; url?: string; storageState?: string };
export const GTAPRO_DEFAULT_URL = "https://portail.gta-pro.fr/ORDI_3000_Portail/";
const MIN_INTERVAL = 5 * 3600 * 1000; // lecture des paiements environ 3 fois par jour
const running = new Set<string>();

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

const Lists = z.object({
  factures: z.array(z.object({
    numero: z.string(),
    client: z.string(),
    date: z.string().describe("AAAA-MM-JJ"),
    echeance: z.string().nullable(),
    montant_ttc: z.number(),
    reste_du: z.number().nullable().describe("Reste à payer ; 0 si payée ; null si inconnu"),
    statut: z.string().nullable(),
  })),
  devis_et_or: z.array(z.object({
    type: z.enum(["DEVIS", "OR"]),
    numero: z.string(),
    client: z.string(),
    vehicule: z.string().nullable(),
    date: z.string().nullable(),
    montant_ttc: z.number().nullable(),
    statut: z.string().nullable(),
  })),
});

async function extract(text: string) {
  const stream = anthropic().beta.messages.stream({
    model: "claude-opus-5-5",
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { format: betaZodOutputFormat(Lists) },
    messages: [{ role: "user", content: `Voici le texte des écrans du logiciel d'atelier GTA Pro (listes de factures, de devis et d'ordres de réparation). Extrais TOUTES les lignes, sans en inventer. Montants en euros TTC. Pour une facture, « reste_du » = 0 si elle est réglée.\n\n${text.slice(0, 180000)}` }],
  });
  const msg = await stream.finalMessage();
  await trackAiSpend("robot GTA Pro", msg.model, msg.usage);
  return Lists.parse(JSON.parse(msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("")));
}

function access(creds: GtaProCreds): SiteAccess {
  if (!creds.storageState && !creds.password) throw new Error("Pas encore connecté : cliquez « se connecter moi-même ».");
  return { site: "gtapro", startUrl: creds.url || GTAPRO_DEFAULT_URL, username: creds.login ?? "", password: creds.password ?? "", storageState: creds.storageState };
}

async function saveState(integrationId: string, creds: GtaProCreds, storageState: string | null) {
  if (storageState) await prisma.integration.update({ where: { id: integrationId }, data: { credentials: encryptJson({ ...creds, storageState }) } });
}

export async function syncGtaPro(integration: { id: string; companyId: string; lastSyncAt: Date | null }, creds: GtaProCreds, force = false): Promise<SyncResult & { skipped?: boolean }> {
  const skipped = { accounts: 0, transactions: 0, invoices: 0, skipped: true };
  if (running.has(integration.id)) return skipped;
  const attemptKey = `gtapro-attempt:${integration.id}`;
  if (!force) {
    const attempt = await prisma.appSetting.findUnique({ where: { key: attemptKey } });
    const last = Math.max(integration.lastSyncAt?.getTime() ?? 0, Number(attempt?.value) || 0);
    if (last && Date.now() - last < MIN_INTERVAL) {
      await runPendingTasks(integration.companyId).catch(() => undefined);
      return skipped;
    }
  }
  const acc = access(creds);
  await prisma.appSetting.upsert({ where: { key: attemptKey }, update: { value: String(Date.now()) }, create: { key: attemptKey, value: String(Date.now()) } });
  running.add(integration.id);
  try {
    const { value: text, storageState } = await withSite(acc, async (page) => {
      const factures = await readScreens(page, acc, "factures", "Afficher la liste des FACTURES clients des 4 derniers mois (menu Factures / Facturation / Historique), avec pour chacune le numéro, le client, la date, l'échéance, le montant TTC et l'état du règlement (réglée, reste dû). Lis toutes les pages de la liste.");
      await page.goto(acc.startUrl, { waitUntil: "networkidle", timeout: 45000 }).catch(() => undefined);
      const atelier = await readScreens(page, acc, "devis-or", "Afficher la liste des DEVIS et des ORDRES DE RÉPARATION (OR) en cours ou récents, avec numéro, client, véhicule (immatriculation), date, montant et statut (accepté, en attente, en cours...). Lis toutes les pages.").catch((e) => `(liste devis / OR non lue : ${(e as Error).message})`);
      return `${factures}\n\n######## DEVIS ET OR ########\n\n${atelier}`;
    });
    await saveState(integration.id, creds, storageState);
    const lists = await extract(text);
    let n = 0;
    for (const f of lists.factures) {
      const issueDate = parseDate(f.date) ?? new Date();
      const externalId = "gta-" + createHash("sha1").update(`${integration.companyId}|${f.numero}`).digest("hex").slice(0, 20);
      const paidAmount = f.reste_du === null ? (/r[ée]gl|pay|sold/i.test(f.statut ?? "") ? f.montant_ttc : 0) : Math.max(0, f.montant_ttc - f.reste_du);
      await prisma.invoice.upsert({
        where: { provider_externalId: { provider: "GTAPRO", externalId } },
        update: { paidAmount, dueDate: f.echeance ? parseDate(f.echeance) : null, amount: f.montant_ttc },
        create: { companyId: integration.companyId, integrationId: integration.id, kind: "CLIENT", provider: "GTAPRO", externalId, number: f.numero, counterparty: f.client.slice(0, 200), issueDate, dueDate: f.echeance ? parseDate(f.echeance) : null, amount: f.montant_ttc, paidAmount },
      });
      n++;
    }
    await prisma.appSetting.upsert({
      where: { key: `gtapro-atelier:${integration.companyId}` },
      update: { value: JSON.stringify({ lu: new Date().toISOString(), documents: lists.devis_et_or }) },
      create: { key: `gtapro-atelier:${integration.companyId}`, value: JSON.stringify({ lu: new Date().toISOString(), documents: lists.devis_et_or }) },
    });
    console.log(`[gtapro] ${n} facture(s), ${lists.devis_et_or.length} devis / OR lus`);
    await runPendingTasks(integration.companyId).catch((e) => console.log(`[gtapro] saisies : ${(e as Error).message.slice(0, 200)}`));
    return { accounts: 0, transactions: 0, invoices: n };
  } finally {
    running.delete(integration.id);
  }
}

/** Saisit dans GTA Pro les devis / OR validés par le fondateur (un à la fois). */
export async function runPendingTasks(companyId?: string) {
  const tasks = await prisma.robotTask.findMany({ where: { provider: "GTAPRO", status: "VALIDE", ...(companyId ? { companyId } : {}) }, orderBy: { validatedAt: "asc" }, take: 5 });
  for (const t of tasks) {
    const claimed = await prisma.robotTask.updateMany({ where: { id: t.id, status: "VALIDE" }, data: { status: "EN_COURS" } });
    if (!claimed.count) continue;
    const integ = await prisma.integration.findFirst({ where: { provider: "GTAPRO", companyId: t.companyId } });
    try {
      if (!integ) throw new Error("GTA Pro n'est pas connecté pour cette société.");
      const creds = decryptJson<GtaProCreds>(integ.credentials);
      const acc = access(creds);
      const kind = t.kind === "OR" ? "un ORDRE DE RÉPARATION (OR)" : "un DEVIS";
      const { value, storageState } = await withSite(acc, (page) => fillDocument(page, acc, `Créer ${kind} dans GTA Pro avec les données fournies (client — à retrouver par son nom ou à créer s'il n'existe pas —, véhicule par son immatriculation, kilométrage, lignes de main-d'œuvre et de pièces avec quantités et prix). Enregistre-le sans le facturer et indique son numéro.`, JSON.parse(t.payload)));
      await saveState(integ.id, creds, storageState);
      const { saveDocument } = await import("@/lib/documents");
      const shot = await saveDocument(new File([new Uint8Array(value.screenshot)], `gtapro-${t.kind.toLowerCase()}-${t.id}.jpg`, { type: "image/jpeg" }), { companyId: t.companyId, type: "AUTRE", uploadedBy: "robot GTA Pro" }).catch(() => null);
      if (shot) await prisma.document.update({ where: { id: shot.doc.id }, data: { status: "DONE", summary: `Capture de fin de saisie : ${t.title}` } });
      await prisma.robotTask.update({ where: { id: t.id }, data: { status: "FAIT", result: value.result.slice(0, 1000), documentId: shot?.doc.id ?? null, error: null } });
      console.log(`[gtapro] saisie faite : ${t.title}`);
    } catch (e) {
      await prisma.robotTask.update({ where: { id: t.id }, data: { status: "ERREUR", error: (e as Error).message.slice(0, 1000) } });
      console.log(`[gtapro] saisie ÉCHEC ${t.title} : ${(e as Error).message.slice(0, 200)}`);
    }
  }
}

export async function atelierSnapshot(companyId: string) {
  const s = await prisma.appSetting.findUnique({ where: { key: `gtapro-atelier:${companyId}` } });
  return s ? (JSON.parse(s.value) as { lu: string; documents: z.infer<typeof Lists>["devis_et_or"] }) : null;
}
