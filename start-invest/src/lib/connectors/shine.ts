import { prisma } from "@/lib/prisma";
import { categorize, INTERNAL } from "@/lib/finance";
import { getJson } from "./http";
import type { SyncResult } from "./types";

// Shine Connect (API officielle, lecture seule) : comptes, transactions et factures Shine Facture.
// Doc : https://developers.shine.fr — Accès : formulaire https://tally.so/r/3qAy69, Shine envoie
// client_id + client_secret. Chaque société se connecte ensuite avec son propre compte Shine (OAuth2).

export type ShineCreds = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms
  companyProfileId: string;
  uid?: string;
};

const SCOPES = "openid bank:accounts:read bank:transactions:read invoices:read";

function env() {
  const sandbox = process.env.SHINE_ENV === "sandbox";
  return {
    auth: process.env.SHINE_AUTH_URL || (sandbox ? "https://api.staging.shine.fr/v2/authentication/oauth2" : "https://api.shine.fr/v2/authentication/oauth2"),
    api: process.env.SHINE_API_URL || (sandbox ? "https://public.api.staging.shine.fr" : "https://public.api.shine.fr"),
    clientId: process.env.SHINE_CLIENT_ID ?? "",
    clientSecret: process.env.SHINE_CLIENT_SECRET ?? "",
    redirectUri: process.env.SHINE_REDIRECT_URI || `${(process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "")}/api/shine/callback`,
  };
}

export function shineConfigured() {
  const e = env();
  return Boolean(e.clientId && e.clientSecret && e.redirectUri.startsWith("http"));
}

export function shineAuthorizeUrl(state: string) {
  const e = env();
  const q = new URLSearchParams({ client_id: e.clientId, scope: SCOPES, state, redirect_uri: e.redirectUri });
  return `${e.auth}/authorize?${q.toString().replace(/\+/g, "%20")}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  metadata?: { companyProfileId?: string; uid?: string };
};

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const e = env();
  const res = await fetch(`${e.auth}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: e.clientId, client_secret: e.clientSecret, redirect_uri: e.redirectUri, ...body }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Shine a refusé l'authentification (${res.status}) : ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function shineExchangeCode(code: string): Promise<ShineCreds> {
  const t = await tokenRequest({ grant_type: "authorization_code", code });
  if (!t.metadata?.companyProfileId) throw new Error("Shine n'a pas renvoyé l'identifiant de la société.");
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000,
    companyProfileId: t.metadata.companyProfileId,
    uid: t.metadata.uid,
  };
}

/** Renouvelle le jeton s'il expire dans moins d'un jour (jetons Shine valables 7 jours). */
export async function shineFreshCreds(creds: ShineCreds): Promise<{ creds: ShineCreds; refreshed: boolean }> {
  if (creds.expiresAt - Date.now() > 86400000) return { creds, refreshed: false };
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: creds.refreshToken });
  return {
    creds: { ...creds, accessToken: t.access_token, refreshToken: t.refresh_token || creds.refreshToken, expiresAt: Date.now() + t.expires_in * 1000 },
    refreshed: true,
  };
}

// Les horodatages Shine sont des entiers : on accepte secondes ou millisecondes.
const toDate = (v: number | string | null | undefined) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isFinite(n)) return new Date(n < 1e12 ? n * 1000 : n);
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

// Catégories Shine -> catégories du tableau de bord (si le libellé ne suffit pas).
const SHINE_CATEGORIES: Record<string, string> = {
  TAX: "Impôts & taxes",
  LOAN: "Emprunts & leasing",
  RENT: "Loyer",
  TELECOM: "Logiciels & abonnements",
  BANKING: "Frais bancaires",
  VEHICLE: "Entretien véhicules",
  MAINTENANCE: "Entretien véhicules",
  UTILITIES: "Énergie & eau",
  CONTRIBUTIONS: "Charges sociales",
  ALCOOL_TOBACCO: "Boissons",
  EQUIPMENT: "Équipement",
  SERVICES: "Prestataires",
  LEGAL: "Honoraires & juridique",
  TRANSPORTATION: "Transport",
};

type ShineAccount = { bankAccountId: string; iban: string; name: string; currentBalanceFloat: number; currency: string; status: string; isHidden: boolean };
type ShineTx = {
  transactionId: string;
  value: number;
  type: "payin" | "payout";
  status: string;
  title: string;
  description?: string;
  transferPayinSenderName?: string;
  paymentMethod?: string;
  category?: string;
  isHidden: boolean;
  isPersonal?: boolean;
  transactionAt?: number;
  createdAt: number;
};
type ShineInvoice = {
  invoiceId: string;
  type?: "INVOICE" | "QUOTE";
  status?: string;
  deleted?: boolean;
  fiscalId?: string;
  title?: string;
  startAt?: number;
  lateMaxDays?: number;
  paidAt?: number;
  client?: { name?: string };
  tasks?: { unitPrice?: number; units?: number; vatPercentage?: number }[];
  settings?: { isReminderEnabled?: boolean };
};

export async function syncShine(integration: { id: string; companyId: string; lastSyncAt: Date | null }, creds: ShineCreds): Promise<SyncResult> {
  const { api } = env();
  const headers = { Authorization: `Bearer ${creds.accessToken}` };
  const from = integration.lastSyncAt ? integration.lastSyncAt.getTime() - 7 * 86400000 : Date.now() - 365 * 86400000;

  // --- Comptes et transactions
  const accounts = await getJson<{ data: ShineAccount[] }>(
    `${api}/bank/accounts/query?${new URLSearchParams({ companyProfileId: creds.companyProfileId })}`,
    headers
  );
  let transactions = 0;
  const active = accounts.data.filter((a) => a.status !== "CLOSED" && !a.isHidden);
  for (const acc of active) {
    const account = await prisma.bankAccount.upsert({
      where: { provider_externalId: { provider: "SHINE", externalId: acc.bankAccountId } },
      update: { balance: acc.currentBalanceFloat, lastSyncAt: new Date(), integrationId: integration.id },
      create: {
        companyId: integration.companyId,
        integrationId: integration.id,
        provider: "SHINE",
        externalId: acc.bankAccountId,
        name: acc.name || "Compte Shine",
        bank: "Shine",
        iban: acc.iban,
        balance: acc.currentBalanceFloat,
        currency: acc.currency || "EUR",
        lastSyncAt: new Date(),
      },
    });

    let after: string | undefined;
    for (let page = 0; page < 200; page++) {
      const q = new URLSearchParams({ bankAccountId: acc.bankAccountId, first: "100" });
      if (after) q.set("after", after);
      const res = await getJson<{ data: ShineTx[] }>(`${api}/transactions/query?${q}`, headers);
      let reachedOld = false;
      for (const t of res.data) {
        const date = toDate(t.transactionAt ?? t.createdAt) ?? new Date();
        if (date.getTime() < from) {
          reachedOld = true;
          continue;
        }
        if (t.isHidden || t.status === "CANCELED") continue;
        const amount = t.type === "payout" ? -Math.abs(t.value) : Math.abs(t.value);
        const label = [t.title, t.description].filter(Boolean).join(" — ") || "Opération Shine";
        let category = categorize(label, amount);
        if (t.paymentMethod === "INTRA_COMPANY_FUNDS_TRANSFER" || t.isPersonal) category = INTERNAL;
        else if ((category === "Autres dépenses" || category === "Encaissements clients") && amount < 0 && t.category && SHINE_CATEGORIES[t.category]) {
          category = SHINE_CATEGORIES[t.category];
        }
        await prisma.bankTransaction.upsert({
          where: { accountId_externalId: { accountId: account.id, externalId: t.transactionId } },
          update: { amount, label, category },
          create: {
            accountId: account.id,
            companyId: integration.companyId,
            externalId: t.transactionId,
            date,
            label,
            counterparty: t.transferPayinSenderName ?? null,
            amount,
            category,
          },
        });
        transactions++;
      }
      if (reachedOld || res.data.length < 100) break;
      after = res.data[res.data.length - 1].transactionId;
    }
  }

  // --- Factures Shine Facture
  let invoices = 0;
  let afterInv: string | undefined;
  for (let page = 0; page < 200; page++) {
    const q = new URLSearchParams({ companyProfileId: creds.companyProfileId, first: "100", deleted: "false" });
    if (afterInv) q.set("after", afterInv);
    const res = await getJson<{ data: ShineInvoice[] }>(`${api}/invoicing/invoices?${q}`, headers);
    for (const inv of res.data) {
      if (inv.type === "QUOTE" || inv.deleted || inv.status === "CANCELED" || inv.status === "PENDING") continue;
      const amount = Math.round(
        (inv.tasks ?? []).reduce((s, t) => s + (t.unitPrice ?? 0) * (t.units ?? 0) * (1 + (t.vatPercentage ?? 0) / 100), 0) * 100
      ) / 100;
      const issueDate = toDate(inv.startAt) ?? new Date();
      const dueDate = new Date(issueDate.getTime() + (inv.lateMaxDays ?? 30) * 86400000);
      const paid = inv.status === "PAID" || inv.status === "MARKED_AS_PAID" || Boolean(inv.paidAt);
      const data = {
        number: inv.fiscalId ?? null,
        label: inv.title ?? null,
        counterparty: inv.client?.name || "Client Shine",
        issueDate,
        dueDate,
        amount,
        paidAmount: paid ? amount : 0,
        externalReminders: Boolean(inv.settings?.isReminderEnabled),
      };
      await prisma.invoice.upsert({
        where: { provider_externalId: { provider: "SHINE", externalId: inv.invoiceId } },
        update: data,
        create: { ...data, kind: "CLIENT", provider: "SHINE", externalId: inv.invoiceId, companyId: integration.companyId, integrationId: integration.id },
      });
      invoices++;
    }
    if (res.data.length < 100) break;
    afterInv = res.data[res.data.length - 1].invoiceId;
  }

  return { accounts: active.length, transactions, invoices };
}
