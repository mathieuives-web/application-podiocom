import { prisma } from "@/lib/prisma";
import { categorize, INTERNAL } from "@/lib/finance";
import { getJson } from "./http";
import type { SyncResult } from "./types";

// API Stripe : solde et mouvements (paiements encaissés, remboursements, frais, virements).
// Utilisez une clé restreinte en LECTURE SEULE (Stripe > Développeurs > Clés API > Clé restreinte).
const BASE = "https://api.stripe.com/v1";

type Amount = { amount: number; currency: string };
type BalanceTx = { id: string; amount: number; fee: number; net: number; currency: string; created: number; description: string | null; type: string };

export async function syncStripe(
  integration: { id: string; companyId: string; lastSyncAt: Date | null },
  creds: { secretKey: string }
): Promise<SyncResult> {
  const headers = { Authorization: `Bearer ${creds.secretKey}` };
  const balance = await getJson<{ available: Amount[]; pending: Amount[] }>(`${BASE}/balance`, headers);
  const eurCents = [...balance.available, ...balance.pending]
    .filter((b) => b.currency === "eur")
    .reduce((s, b) => s + b.amount, 0);

  const account = await prisma.bankAccount.upsert({
    where: { provider_externalId: { provider: "STRIPE", externalId: integration.id } },
    update: { balance: eurCents / 100, lastSyncAt: new Date(), integrationId: integration.id },
    create: {
      companyId: integration.companyId,
      integrationId: integration.id,
      provider: "STRIPE",
      externalId: integration.id,
      name: "Solde Stripe",
      bank: "Stripe",
      balance: eurCents / 100,
      lastSyncAt: new Date(),
    },
  });

  const from = Math.floor(
    (integration.lastSyncAt ? integration.lastSyncAt.getTime() - 7 * 86400000 : Date.now() - 365 * 86400000) / 1000
  );
  let transactions = 0;
  let startingAfter: string | undefined;
  for (let i = 0; i < 100; i++) {
    const params = new URLSearchParams({ limit: "100", "created[gte]": String(from) });
    if (startingAfter) params.set("starting_after", startingAfter);
    const res = await getJson<{ data: BalanceTx[]; has_more: boolean }>(`${BASE}/balance_transactions?${params}`, headers);
    for (const t of res.data) {
      // Les virements Stripe -> banque ne sont pas du chiffre d'affaires : ils sont gardés mais catégorisés à part.
      const amount = t.net / 100;
      const label = t.description || `Stripe ${t.type}`;
      await prisma.bankTransaction.upsert({
        where: { accountId_externalId: { accountId: account.id, externalId: t.id } },
        update: { amount, label },
        create: {
          accountId: account.id,
          companyId: integration.companyId,
          externalId: t.id,
          date: new Date(t.created * 1000),
          label,
          amount,
          category: t.type === "payout" ? INTERNAL : categorize(label, amount),
        },
      });
      transactions++;
    }
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }
  return { accounts: 1, transactions, invoices: 0 };
}
