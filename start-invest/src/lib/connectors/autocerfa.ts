import { prisma } from "@/lib/prisma";
import { processDocument, saveDocument } from "@/lib/documents";
import { robotDownload } from "./web-robot";
import { encryptJson } from "@/lib/crypto";
import type { SyncResult } from "./types";

// Auto Cerfa n'a pas d'API de stock : le robot de connexion se connecte une fois par jour avec les
// identifiants enregistrés (chiffrés), télécharge l'export Excel du stock et celui des ventes, puis
// les importe comme un dépôt manuel (archivés chiffrés, marges et commissions recalculées).

export type AutoCerfaCreds = { login?: string; password?: string; url?: string; storageState?: string };
export const AUTOCERFA_DEFAULT_URL = "https://www.autocerfa.com/liste-client/";
const MIN_INTERVAL = 20 * 3600 * 1000; // une fois par jour
const running = new Set<string>(); // un seul robot à la fois par connexion (synchro horaire + bouton)

export async function syncAutoCerfa(integration: { id: string; companyId: string; lastSyncAt: Date | null }, creds: AutoCerfaCreds, force = false): Promise<SyncResult & { skipped?: boolean; problems?: string[] }> {
  const skipped = { accounts: 0, transactions: 0, invoices: 0, skipped: true };
  if (running.has(integration.id)) return skipped;
  // Dernière TENTATIVE (réussie ou non) : un robot en échec ne relance pas Chromium et l'IA toutes les heures.
  const attemptKey = `autocerfa-attempt:${integration.id}`;
  if (!force) {
    const attempt = await prisma.appSetting.findUnique({ where: { key: attemptKey } });
    const last = Math.max(integration.lastSyncAt?.getTime() ?? 0, Number(attempt?.value) || 0);
    if (last && Date.now() - last < MIN_INTERVAL) return skipped;
  }
  if (!creds.storageState && !creds.password) throw new Error("Pas encore connecté : cliquez « se connecter moi-même ».");
  const now = String(Date.now());
  await prisma.appSetting.upsert({ where: { key: attemptKey }, update: { value: now }, create: { key: attemptKey, value: now } });
  running.add(integration.id);
  try {
    return await runRobot(integration, creds);
  } finally {
    running.delete(integration.id);
  }
}

async function runRobot(integration: { id: string; companyId: string }, creds: AutoCerfaCreds): Promise<SyncResult & { problems?: string[] }> {
  const { files, problems, storageState } = await robotDownload({
    site: "autocerfa",
    startUrl: creds.url || AUTOCERFA_DEFAULT_URL,
    username: creds.login ?? "",
    password: creds.password ?? "",
    storageState: creds.storageState,
    goals: [
      { key: "stock", description: "Télécharger l'export Excel COMPLET du stock de véhicules (page Stock / Mon stock, bouton « Export Excel »). Il faut d'abord se connecter à l'espace professionnel si ce n'est pas fait (lien Connexion / Mon compte / Espace pro)." },
      { key: "ventes", description: "Télécharger l'export Excel des véhicules VENDUS (page Mes ventes, historique des ventes, livre de police ou export comptable du mois), avec date et prix de vente et si possible le vendeur." },
    ],
  });
  if (storageState) {
    await prisma.integration.update({ where: { id: integration.id }, data: { credentials: encryptJson({ ...creds, storageState }) } });
  }
  if (!files.length) throw new Error(`Auto Cerfa : aucun export récupéré. ${problems.join(" · ")}`.slice(0, 480));
  let vehicles = 0;
  for (const f of files) {
    const day = new Date().toISOString().slice(0, 10);
    const ext = /\.(xlsx|xls|csv)$/i.exec(f.name)?.[0] ?? ".xlsx";
    const file = new File([new Uint8Array(f.content)], `autocerfa-${f.goal}-${day}${ext}`, { type: "application/octet-stream" });
    const { doc, duplicate } = await saveDocument(file, { companyId: integration.companyId, type: "VEHICULES", uploadedBy: "robot Auto Cerfa" });
    if (duplicate) continue; // export identique à la veille : rien de neuf
    await processDocument(doc.id);
    const done = await prisma.document.findUnique({ where: { id: doc.id } });
    if (done?.status === "ERROR") problems.push(`${f.goal} : ${done.error}`);
    vehicles += Number(done?.summary?.match(/^(\d+)/)?.[1] ?? 0) + Number(done?.summary?.match(/(\d+) mis à jour/)?.[1] ?? 0);
  }
  if (problems.length) {
    await prisma.integration.update({ where: { id: integration.id }, data: { meta: JSON.stringify({ avertissements: problems }).slice(0, 2000) } });
  }
  return { accounts: 0, transactions: vehicles, invoices: 0, problems };
}
