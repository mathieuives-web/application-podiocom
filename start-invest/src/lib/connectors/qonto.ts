import { prisma } from "@/lib/prisma";
import { categorize } from "@/lib/finance";
import { getJson } from "./http";
import type { SyncResult } from "./types";

// API Qonto (banque pro) : https://docs.qonto.com/api-reference/business-api
// Authentification par clé API : en-tête "Authorization: <login>:<secret-key>"
// (Qonto > Paramètres > Intégrations & partenariats > Clé API).
const BASE = "https://thirdparty.qonto.com/v2";

type QontoAccount = { id: string; slug?: string; iban?: string; name?: string; balance: number; currency?: string; status?: string };
type QontoTx = {
  id?: string;
  transaction_id?: string;
  amount: number;
  side: "credit" | "debit";
  settled_at?: string | null;
  emitted_at?: string;
  label?: string;
  reference?: string | null;
  status?: string;
};

export async function syncQonto(
  integration: { id: string; companyId: string; lastSyncAt: Date | null },
  creds: { login: string; secretKey: string }
): Promise<SyncResult> {
  const headers = { Authorization: `${creds.login}:${creds.secretKey}` };
  const org = await getJson<{ organization: { bank_accounts: QontoAccount[] } }>(`${BASE}/organization`, headers);

  // Première synchro : 12 mois d'historique. Ensuite : depuis la dernière synchro (avec 7 j de marge).
  const from = integration.lastSyncAt
    ? new Date(integration.lastSyncAt.getTime() - 7 * 86400000)
    : new Date(Date.now() - 365 * 86400000);

  let transactions = 0;
  for (const acc of org.organization.bank_accounts.filter((a) => a.status !== "closed")) {
    const account = await prisma.bankAccount.upsert({
      where: { provider_externalId: { provider: "QONTO", externalId: acc.id } },
      update: { balance: acc.balance, lastSyncAt: new Date(), integrationId: integration.id },
      create: {
        companyId: integration.companyId,
        integrationId: integration.id,
        provider: "QONTO",
        externalId: acc.id,
        name: acc.name || "Compte Qonto",
        bank: "Qonto",
        iban: acc.iban,
        balance: acc.balance,
        currency: acc.currency || "EUR",
        lastSyncAt: new Date(),
      },
    });

    for (let page = 1; page < 200; page++) {
      const params = new URLSearchParams({
        bank_account_id: acc.id,
        settled_at_from: from.toISOString(),
        sort_by: "settled_at:desc",
        per_page: "100",
        page: String(page),
      });
      params.append("status[]", "completed");
      const res = await getJson<{ transactions: QontoTx[]; meta?: { next_page?: number | null } }>(
        `${BASE}/transactions?${params}`,
        headers
      );
      for (const t of res.transactions) {
        const externalId = t.transaction_id || t.id;
        if (!externalId) continue;
        const amount = t.side === "debit" ? -Math.abs(t.amount) : Math.abs(t.amount);
        const label = [t.label, t.reference].filter(Boolean).join(" — ") || "Opération Qonto";
        await prisma.bankTransaction.upsert({
          where: { accountId_externalId: { accountId: account.id, externalId } },
          update: { amount, label },
          create: {
            accountId: account.id,
            companyId: integration.companyId,
            externalId,
            date: new Date(t.settled_at || t.emitted_at || Date.now()),
            label,
            counterparty: t.label,
            amount,
            category: categorize(label, amount),
          },
        });
        transactions++;
      }
      if (!res.meta?.next_page) break;
    }
  }
  return { accounts: org.organization.bank_accounts.length, transactions, invoices: 0 };
}
