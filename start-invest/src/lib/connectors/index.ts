import { prisma } from "@/lib/prisma";
import { decryptJson, encryptJson } from "@/lib/crypto";
import { autoReconcile } from "@/lib/finance";
import type { ProviderDef, SyncResult } from "./types";
import { syncQonto } from "./qonto";
import { syncStripe } from "./stripe";
import { syncPennylane } from "./pennylane";
import { syncShine, shineFreshCreds, type ShineCreds } from "./shine";

export const PROVIDERS: ProviderDef[] = [
  {
    id: "SHINE",
    name: "Shine (compte pro + Shine Facture)",
    kind: "Banque",
    description:
      "Comptes Shine, toutes les opérations, et les factures émises avec Shine Facture (montants, échéances, payées ou non). Connexion officielle Shine Connect, en lecture seule.",
    fields: [],
    docs: "Bouton « Se connecter avec Shine » pour chaque société",
    available: true,
    oauth: true,
  },
  {
    id: "QONTO",
    name: "Qonto",
    kind: "Banque",
    description: "Comptes pro Qonto : soldes et toutes les opérations, synchronisés automatiquement.",
    fields: [
      { name: "login", label: "Identifiant (login)", placeholder: "ma-societe-1234" },
      { name: "secretKey", label: "Clé secrète", secret: true },
    ],
    docs: "Qonto → Paramètres → Intégrations & partenariats → Clé API",
    available: true,
  },
  {
    id: "STRIPE",
    name: "Stripe",
    kind: "Paiements",
    description: "Paiements clients encaissés en ligne, frais et virements vers la banque.",
    fields: [{ name: "secretKey", label: "Clé restreinte (lecture seule)", secret: true, placeholder: "rk_live_..." }],
    docs: "Stripe → Développeurs → Clés API → Créer une clé restreinte (lecture : Balance)",
    available: true,
  },
  {
    id: "PENNYLANE",
    name: "Pennylane",
    kind: "Facturation",
    description: "Factures clients et fournisseurs, montants restant dus et échéances.",
    fields: [{ name: "token", label: "Jeton d'API", secret: true }],
    docs: "Pennylane → Paramètres → Connectivité → Développeurs → Générer un jeton (lecture)",
    available: true,
  },
  {
    id: "AGREGATEUR",
    name: "Autres banques (BNP, Crédit Agricole, SG, LCL, CIC...)",
    kind: "Agrégateur bancaire",
    description:
      "Connexion DSP2 de n'importe quelle banque via un agrégateur agréé (Bridge, Powens ou Enable Banking). Nécessite l'ouverture d'un compte chez l'agrégateur. En attendant : import CSV/Excel des relevés dans Finances.",
    fields: [],
    docs: "Contrat agrégateur requis",
    available: false,
  },
  {
    id: "AUTRES",
    name: "Sellsy, Axonaut, QuickBooks, Tiime, Indy...",
    kind: "Comptabilité",
    description: "Autres logiciels de facturation : connecteur à ajouter sur le même modèle que Pennylane.",
    fields: [],
    docs: "Sur demande",
    available: false,
  },
];

export async function syncIntegration(integrationId: string): Promise<SyncResult> {
  const integ = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  const creds = decryptJson<Record<string, string>>(integ.credentials);
  try {
    let result: SyncResult;
    if (integ.provider === "SHINE") {
      const fresh = await shineFreshCreds(creds as unknown as ShineCreds);
      if (fresh.refreshed) {
        await prisma.integration.update({ where: { id: integ.id }, data: { credentials: encryptJson(fresh.creds) } });
      }
      result = await syncShine(integ, fresh.creds);
    } else if (integ.provider === "QONTO") result = await syncQonto(integ, creds as { login: string; secretKey: string });
    else if (integ.provider === "STRIPE") result = await syncStripe(integ, creds as { secretKey: string });
    else if (integ.provider === "PENNYLANE") result = await syncPennylane(integ, creds as { token: string });
    else throw new Error(`Connecteur inconnu : ${integ.provider}`);
    await prisma.integration.update({
      where: { id: integ.id },
      data: { status: "OK", lastSyncAt: new Date(), lastError: null },
    });
    await autoReconcile(integ.companyId);
    return result;
  } catch (e) {
    await prisma.integration.update({
      where: { id: integ.id },
      data: { status: "ERROR", lastError: (e as Error).message.slice(0, 500) },
    });
    throw e;
  }
}

export async function syncAll() {
  const all = await prisma.integration.findMany();
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const i of all) {
    try {
      await syncIntegration(i.id);
      results.push({ id: i.id, ok: true });
    } catch (e) {
      results.push({ id: i.id, ok: false, error: (e as Error).message });
    }
  }
  return results;
}
