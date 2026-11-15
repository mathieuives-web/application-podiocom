import { prisma } from "@/lib/prisma";
import { getJson } from "./http";
import type { SyncResult } from "./types";

// API Pennylane v2 (facturation & comptabilité) : https://pennylane.readme.io
// Jeton d'API société : Pennylane > Paramètres > Connectivité > Développeurs.
const BASE = "https://app.pennylane.com/api/external/v2";

type PlInvoice = {
  id: number;
  invoice_number?: string | null;
  label?: string | null;
  date?: string | null;
  deadline?: string | null;
  amount?: string | number | null;
  currency_amount?: string | number | null;
  remaining_amount_with_tax?: string | number | null;
  remaining_amount?: string | number | null;
  paid?: boolean;
  status?: string;
  customer?: { id: number; name?: string } | null;
  supplier?: { id: number; name?: string } | null;
  thirdparty?: { id: number; name?: string } | null;
};

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

// E-mail des clients (pour les relances automatiques), mis en cache pendant une synchro.
async function customerEmail(id: number, headers: Record<string, string>, cache: Map<number, string | null>) {
  if (cache.has(id)) return cache.get(id)!;
  let email: string | null = null;
  try {
    const c = await getJson<{ emails?: string[]; email?: string | null; billing_email?: string | null }>(`${BASE}/customers/${id}`, headers);
    email = c.emails?.[0] ?? c.billing_email ?? c.email ?? null;
  } catch {
    email = null;
  }
  cache.set(id, email);
  return email;
}

async function pull(
  path: string,
  kind: "CLIENT" | "SUPPLIER",
  integration: { id: string; companyId: string },
  headers: Record<string, string>
) {
  let count = 0;
  const emails = new Map<number, string | null>();
  let cursor: string | null = null;
  for (let i = 0; i < 500; i++) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const res: { items: PlInvoice[]; has_more?: boolean; next_cursor?: string | null } = await getJson(
      `${BASE}/${path}?${params}`,
      headers
    );
    for (const inv of res.items ?? []) {
      const amount = num(inv.amount) ?? num(inv.currency_amount) ?? 0;
      const remaining = num(inv.remaining_amount_with_tax) ?? num(inv.remaining_amount);
      const paidAmount = inv.paid || inv.status === "paid" ? amount : remaining !== null ? Math.max(0, amount - remaining) : 0;
      const party = inv.customer ?? inv.supplier ?? inv.thirdparty;
      const unpaid = paidAmount < amount - 0.01;
      const email = kind === "CLIENT" && unpaid && party?.id ? await customerEmail(party.id, headers, emails) : null;
      const data = {
        number: inv.invoice_number ?? null,
        label: inv.label ?? null,
        counterparty: party?.name || inv.label || `${kind === "CLIENT" ? "Client" : "Fournisseur"} #${party?.id ?? "?"}`,
        issueDate: new Date(inv.date || Date.now()),
        dueDate: inv.deadline ? new Date(inv.deadline) : null,
        amount,
        paidAmount,
      };
      await prisma.invoice.upsert({
        where: { provider_externalId: { provider: "PENNYLANE", externalId: `${kind}-${inv.id}` } },
        update: { ...data, ...(email ? { counterpartyEmail: email } : {}) },
        create: { ...data, counterpartyEmail: email, kind, provider: "PENNYLANE", externalId: `${kind}-${inv.id}`, companyId: integration.companyId, integrationId: integration.id },
      });
      count++;
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return count;
}

export async function syncPennylane(integration: { id: string; companyId: string }, creds: { token: string }): Promise<SyncResult> {
  const headers = { Authorization: `Bearer ${creds.token}` };
  const clients = await pull("customer_invoices", "CLIENT", integration, headers);
  const suppliers = await pull("supplier_invoices", "SUPPLIER", integration, headers);
  return { accounts: 0, transactions: 0, invoices: clients + suppliers };
}
