import { prisma } from "@/lib/prisma";
import { decryptJson, encryptJson } from "@/lib/crypto";
import { autoReconcile } from "@/lib/finance";
import type { ProviderDef, SyncResult } from "./types";
import { syncQonto } from "./qonto";
import { syncStripe } from "./stripe";
import { syncPennylane } from "./pennylane";
import { syncShineMcp, shineMcpFresh, SHINE_MCP_URL, type ShineMcpCreds } from "./shine-mcp";

export const PROVIDERS: ProviderDef[] = [
  {
    id: "SHINE",
    name: "Shine (compte pro + Shine Facture)",
    kind: "Banque",
    description:
      "Factures clients, factures fournisseurs, lignes bancaires et grand livre de Shine Facture, via le serveur officiel de Shine pour les assistants IA (MCP). Connexion avec votre identifiant Shine habituel, en lecture seule. Offre Shine payante (Start ou Plus) requise ; connexion à renouveler tous les 30 jours.",
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
      const fresh = await shineMcpFresh(creds as unknown as ShineMcpCreds);
      if (fresh.refreshed) {
        await prisma.integration.update({ where: { id: integ.id }, data: { credentials: encryptJson(fresh.creds) } });
      }
      result = await syncShineMcp(integ, fresh.creds);
    } else if (integ.provider === "QONTO") result = await syncQonto(integ, creds as { login: string; secretKey: string });
    else if (integ.provider === "STRIPE") result = await syncStripe(integ, creds as { secretKey: string });
    else if (integ.provider === "PENNYLANE") result = await syncPennylane(integ, creds as { token: string });
    else throw new Error(`Connecteur inconnu : ${integ.provider}`);
    await prisma.integration.update({
      where: { id: integ.id },
      data: { status: "OK", lastSyncAt: new Date(), lastError: null },
    });
    await autoReconcile(integ.companyId);
    console.log(`[synchro] ${integ.provider} ${integ.companyId} OK : ${result.accounts} compte(s), ${result.transactions} ligne(s), ${result.invoices} facture(s)`);
    return result;
  } catch (e) {
    console.log(`[synchro] ${integ.provider} ${integ.companyId} ÉCHEC : ${(e as Error).message.slice(0, 300)}`);
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

/**
 * Serveurs Shine (MCP) à donner aux agents pour interroger Shine en direct, une entrée par société
 * connectée. Les jetons sont renouvelés si besoin. Une société dont la connexion a expiré est ignorée.
 */
export async function shineMcpServersFor(companyIds: string[]) {
  const integs = await prisma.integration.findMany({
    where: { provider: "SHINE", status: "OK", companyId: { in: companyIds } },
    include: { company: { select: { name: true } } },
  });
  const servers: { name: string; company: string; url: string; token: string }[] = [];
  for (const i of integs) {
    try {
      const fresh = await shineMcpFresh(decryptJson<ShineMcpCreds>(i.credentials));
      if (fresh.refreshed) await prisma.integration.update({ where: { id: i.id }, data: { credentials: encryptJson(fresh.creds) } });
      const slug = i.company.name.normalize("NFD").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").toLowerCase();
      servers.push({ name: `shine_${slug}`.slice(0, 60), company: i.company.name, url: SHINE_MCP_URL, token: fresh.creds.accessToken });
    } catch (e) {
      await prisma.integration.update({ where: { id: i.id }, data: { status: "ERROR", lastError: (e as Error).message.slice(0, 500) } });
    }
  }
  return servers;
}

// Outils Shine en LECTURE uniquement (aucune création ni modification de brouillon par les agents).
export const SHINE_READ_TOOLS = [
  "invoicing_search_invoices", "invoicing_get_invoice", "invoicing_get_invoice_summary",
  "invoicing_search_quotes", "invoicing_get_quote", "invoicing_get_quote_summary",
  "invoicing_search_credit_notes", "invoicing_get_credit_note",
  "customer_list_contacts", "customer_find_contact", "invoicing_list_products",
  "expenses_list_bills", "expenses_get_bill", "expenses_get_bill_summary",
  "invoicing_list_unhandled_attachments", "invoicing_get_attachment", "invoicing_get_attachment_summary",
  "bank_list_bank_lines", "bank_get_bank_lines_summary", "bank_list_bank_line_matches",
  "accounting_list_transactions", "accounting_get_transaction", "accounting_list_postings",
  "accounting_list_daybooks", "accounting_list_daybook_transactions", "accounting_get_daybook_transaction",
  "invoicing_list_vat_rate_rules", "setting_list_accounts", "setting_list_account_groups", "setting_list_currencies",
];
