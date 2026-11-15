import { prisma } from "@/lib/prisma";
import { decryptJson, encryptJson } from "@/lib/crypto";
import { autoReconcile } from "@/lib/finance";
import type { ProviderDef, SyncResult } from "./types";
import { syncQonto } from "./qonto";
import { syncStripe } from "./stripe";
import { syncPennylane } from "./pennylane";
import { syncShineMcp, shineMcpFresh, SHINE_MCP_URL, type ShineMcpCreds } from "./shine-mcp";
import { syncEnableBanking, type BankCreds } from "./enablebanking";
import { checkWhatsApp, whatsappVerifyToken, type WhatsAppCreds } from "./whatsapp";
import { googleClient } from "./google";
import { checkGitHub } from "./github";
import { syncAutoCerfa, AUTOCERFA_DEFAULT_URL, type AutoCerfaCreds } from "./autocerfa";

export const PROVIDERS: ProviderDef[] = [
  {
    id: "BANQUE",
    name: "Banque (Shine, BNP, Crédit Agricole, SG, LCL, CIC, Qonto...)",
    kind: "Banque",
    description:
      "Soldes et toutes les opérations bancaires, par la connexion officielle des banques (DSP2) via Enable Banking. Vous vous identifiez sur le site de votre banque ; lecture seule. Accord à renouveler au plus tard tous les 180 jours.",
    fields: [],
    docs: "Choisir la banque puis « Connecter la banque » pour chaque société",
    available: true,
    oauth: true,
  },
  {
    id: "SHINE",
    name: "Shine Facture (factures et comptabilité)",
    kind: "Banque",
    description:
      "Factures clients, factures fournisseurs et grand livre de Shine Facture (le logiciel de facturation-comptabilité de Shine, distinct du compte pro). Connexion avec votre identifiant Shine, en lecture seule. Nécessite un abonnement Shine Facture actif (Start ou Plus) ; à renouveler tous les 30 jours. Pour les opérations bancaires Shine, utilisez la carte « Banque ».",
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
    id: "AUTOCERFA",
    name: "Auto Cerfa (stock et ventes de véhicules)",
    kind: "Gestion",
    description:
      "Auto Cerfa n'a pas d'API : vous vous connectez vous-même une fois dans une fenêtre en direct (code SMS compris), la session est gardée chiffrée, et un robot se reconnecte chaque jour, télécharge l'export Excel du stock et des ventes et les importe (véhicules, frais, marges, vendeurs, commissions). Lecture seule : il ne clique jamais sur un bouton qui modifie quelque chose. Conseil : créez dans Auto Cerfa un utilisateur dédié, sans double vérification par SMS.",
    fields: [
      { name: "login", label: "Identifiant Auto Cerfa (facultatif)", optional: true, help: "Laissez vide pour vous connecter vous-même dans la fenêtre en direct." },
      { name: "password", label: "Mot de passe Auto Cerfa (facultatif)", secret: true, optional: true },
      { name: "url", label: "Adresse de la page de connexion (facultatif)", placeholder: AUTOCERFA_DEFAULT_URL, optional: true },
    ],
    docs: "À choisir pour La Fabrique Automobile. Première connexion : 2 à 5 minutes, le robot apprend le chemin vers les exports.",
    available: true,
  },
  {
    id: "GOOGLE",
    name: "Google : Gmail + Drive",
    kind: "Gestion",
    description:
      "Boîte mail et Drive de la société. Chaque matin, l'agent Secrétariat trie les e-mails (libellés : Factures, Clients, Banque, Administration...), archive ce qui est traité, signale l'urgent, et range le Drive (dossiers par année et par type). Il ne peut ni envoyer, ni supprimer.",
    fields: [],
    docs: "Bouton « Se connecter avec Google » pour chaque société",
    available: true,
    oauth: true,
  },
  {
    id: "WHATSAPP",
    name: "WhatsApp Business (un numéro par société)",
    kind: "Gestion",
    description:
      "Les salariés envoient une photo ou un message (ticket de frais, pièce à commander, intervention faite) au numéro WhatsApp de leur société : l'IA lit, classe (frais / besoin / intervention), archive la photo chiffrée, répond « bien reçu » et tout apparaît dans « Terrain » pour les agents.",
    fields: [
      { name: "phoneNumberId", label: "Identifiant du numéro (Phone number ID)", placeholder: "123456789012345" },
      { name: "accessToken", label: "Jeton d'accès permanent (utilisateur système)", secret: true },
      { name: "appSecret", label: "Clé secrète de l'application Meta (App secret)", secret: true },
    ],
    docs: "Meta for Developers → votre application → WhatsApp → Configuration de l'API",
    available: true,
  },
  {
    id: "GITHUB",
    name: "GitHub (projets)",
    kind: "Gestion",
    description:
      "Lecture seule des dépôts de vos projets (CLEAN, Vente Auto Sécurité...) pour que chaque chef de projet voie l'état réel : README, derniers changements, tâches ouvertes, builds. Choisissez la société Start Invest.",
    fields: [{ name: "token", label: "Jeton GitHub (fine-grained, lecture seule)", secret: true, placeholder: "github_pat_..." }],
    docs: "GitHub → Settings → Developer settings → Fine-grained tokens → Generate : dépôts de vos projets, permissions Contents, Issues, Pull requests, Actions et Metadata en « Read-only »",
    available: true,
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

export async function syncIntegration(integrationId: string, opts: { force?: boolean } = {}): Promise<SyncResult> {
  const integ = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  const creds = decryptJson<Record<string, string>>(integ.credentials);
  try {
    let result: SyncResult;
    if (integ.provider === "BANQUE") {
      result = await syncEnableBanking(integ, creds as unknown as BankCreds);
    } else if (integ.provider === "SHINE") {
      const fresh = await shineMcpFresh(creds as unknown as ShineMcpCreds);
      if (fresh.refreshed) {
        await prisma.integration.update({ where: { id: integ.id }, data: { credentials: encryptJson(fresh.creds) } });
      }
      result = await syncShineMcp(integ, fresh.creds);
    } else if (integ.provider === "QONTO") result = await syncQonto(integ, creds as { login: string; secretKey: string });
    else if (integ.provider === "STRIPE") result = await syncStripe(integ, creds as { secretKey: string });
    else if (integ.provider === "PENNYLANE") result = await syncPennylane(integ, creds as { token: string });
    else if (integ.provider === "WHATSAPP") {
      const r = await checkWhatsApp(creds as unknown as WhatsAppCreds);
      await prisma.integration.update({ where: { id: integ.id }, data: { label: r.display_phone_number ?? integ.label, meta: JSON.stringify(r) } });
      result = { accounts: 0, transactions: 0, invoices: 0 };
    } else if (integ.provider === "GITHUB") {
      await checkGitHub();
      result = { accounts: 0, transactions: 0, invoices: 0 };
    } else if (integ.provider === "GOOGLE") {
      await googleClient(integ.id).then((g) => g.call("https://www.googleapis.com/oauth2/v3/userinfo"));
      result = { accounts: 0, transactions: 0, invoices: 0 };
    } else if (integ.provider === "AUTOCERFA") {
      const r = await syncAutoCerfa(integ, creds as unknown as AutoCerfaCreds, opts.force);
      if (r.skipped) return r; // déjà passé aujourd'hui
      result = r;
    }
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

export { whatsappVerifyToken };
