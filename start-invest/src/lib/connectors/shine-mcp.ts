import { createHash, randomBytes } from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prisma } from "@/lib/prisma";
import { categorize, INTERNAL } from "@/lib/finance";
import type { SyncResult } from "./types";

// Shine via son serveur MCP officiel (Shine Facture : factures, factures fournisseurs, lignes bancaires,
// grand livre). Connexion OAuth 2.1 + PKCE avec l'identifiant Shine habituel de chaque société ;
// l'application s'inscrit seule auprès de Shine (enregistrement dynamique). Réservé aux offres Shine
// payantes (Start / Plus). Connexion valable 30 jours, renouvelée automatiquement tant que possible.
// Doc : https://help.shine.fr/shine-facture/fr/articles/17430657-documentation-technique-mcp

export const SHINE_MCP_URL = "https://mcp.invoicing-accounting.shine.co/mcp";
const AUTH_BASE = "https://mcp.invoicing-accounting.shine.co";
const SCOPE = "openid email aws.cognito.signin.user.admin";

export type ShineMcpCreds = { accessToken: string; refreshToken?: string; expiresAt: number };

export function shineRedirectUri() {
  return `${(process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "")}/api/shine/callback`;
}

export function shineMcpAvailable() {
  return shineRedirectUri().startsWith("http");
}

/** Identifiant de l'application auprès de Shine (créé une fois par adresse de retour, puis conservé). */
async function clientId() {
  const redirect = shineRedirectUri();
  const key = `shine-mcp-client:${redirect}`;
  const saved = await prisma.appSetting.findUnique({ where: { key } });
  if (saved) return saved.value;
  const res = await fetch(`${AUTH_BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Start Invest",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) throw new Error(`Inscription auprès de Shine refusée (${res.status}).`);
  const { client_id } = (await res.json()) as { client_id: string };
  await prisma.appSetting.create({ data: { key, value: client_id } });
  return client_id;
}

export function newPkce() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function shineMcpAuthorizeUrl(state: string, challenge: string) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: await clientId(),
    redirect_uri: shineRedirectUri(),
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: SHINE_MCP_URL,
  });
  return `${AUTH_BASE}/authorize?${q.toString().replace(/\+/g, "%20")}`;
}

async function token(body: Record<string, string>): Promise<ShineMcpCreds> {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: await clientId(), ...body }).toString(),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Shine a refusé la connexion (${res.status}) : ${(await res.text()).slice(0, 200)}`);
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
}

export function shineMcpExchange(code: string, verifier: string) {
  return token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: shineRedirectUri(), resource: SHINE_MCP_URL });
}

/** Jeton valide (renouvelé s'il expire dans moins de 5 minutes). */
export async function shineMcpFresh(creds: ShineMcpCreds): Promise<{ creds: ShineMcpCreds; refreshed: boolean }> {
  if (creds.expiresAt - Date.now() > 5 * 60 * 1000) return { creds, refreshed: false };
  if (!creds.refreshToken) throw new Error("Connexion Shine expirée : reconnectez la société dans Connexions.");
  try {
    const t = await token({ grant_type: "refresh_token", refresh_token: creds.refreshToken, resource: SHINE_MCP_URL });
    return { creds: { ...t, refreshToken: t.refreshToken ?? creds.refreshToken }, refreshed: true };
  } catch {
    throw new Error("Connexion Shine expirée (30 jours) : reconnectez la société dans Connexions.");
  }
}

// ------------------------------------------------------------------ appels d'outils MCP

async function withClient<T>(creds: ShineMcpCreds, fn: (c: Client) => Promise<T>) {
  const client = new Client({ name: "start-invest", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(SHINE_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${creds.accessToken}` } },
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Contenu JSON d'un résultat d'outil (structuredContent, ou texte JSON). */
function payload(result: unknown): unknown {
  const r = result as { structuredContent?: unknown; content?: { type: string; text?: string }[]; isError?: boolean };
  if (r.isError) throw new Error(r.content?.map((c) => c.text).join(" ").slice(0, 300) || "Erreur Shine");
  if (r.structuredContent) return r.structuredContent;
  const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Trouve la première liste d'objets dans une réponse (ex. { items: [...] }, { data: { invoices: [...] } }). */
function findList(v: unknown, depth = 0): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  if (v && typeof v === "object" && depth < 4) {
    for (const val of Object.values(v)) {
      const l = findList(val, depth + 1);
      if (l.length) return l;
    }
  }
  return [];
}

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const path = k.split(".");
    let cur: unknown = o;
    for (const p of path) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[p] : undefined;
    if (cur !== undefined && cur !== null && cur !== "") return cur;
  }
  return undefined;
}
const num = (v: unknown) => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  if (v && typeof v === "object" && "amount" in (v as object)) return num((v as { amount: unknown }).amount);
  return null;
};
const date = (v: unknown) => {
  if (!v) return null;
  const d = new Date(typeof v === "number" && v < 1e12 ? v * 1000 : (v as string));
  return Number.isNaN(d.getTime()) ? null : d;
};
const str = (v: unknown) => (v === undefined || v === null ? null : String(typeof v === "object" ? (v as { name?: string }).name ?? "" : v) || null);

async function listAll(c: Client, tool: string, args: Record<string, unknown>, max = 2000) {
  const out: Record<string, unknown>[] = [];
  let page = 1;
  let cursor: string | undefined;
  for (let i = 0; i < 40 && out.length < max; i++) {
    const res = payload(await c.callTool({ name: tool, arguments: { ...args, ...(cursor ? { cursor } : { page }) } }));
    const items = findList(res);
    out.push(...items);
    const next = res && typeof res === "object" ? (pick(res as Record<string, unknown>, ["next_cursor", "nextCursor", "pagination.next_cursor", "meta.next_cursor"]) as string | undefined) : undefined;
    if (next) cursor = next;
    else if (items.length >= 20) page++;
    else break;
    if (!items.length) break;
  }
  return out;
}

/** Synchronise factures clients, factures fournisseurs et lignes bancaires d'une société depuis Shine. */
export async function syncShineMcp(integration: { id: string; companyId: string }, creds: ShineMcpCreds): Promise<SyncResult> {
  return withClient(creds, async (c) => {
    const tools = (await c.listTools()).tools.map((t) => t.name);
    const meta: Record<string, unknown> = { tools, champs: {} as Record<string, string[]> };
    const has = (n: string) => tools.includes(n);
    let invoices = 0;
    let transactions = 0;
    let accounts = 0;

    const upsertInvoice = async (o: Record<string, unknown>, kind: "CLIENT" | "SUPPLIER") => {
      const id = str(pick(o, ["id", "uuid", "invoice_id", "bill_id"]));
      if (!id) return;
      const amount = num(pick(o, ["gross_amount", "total_gross", "gross", "amount_gross", "total_amount_incl_tax", "total_incl_vat", "total", "amount"])) ?? 0;
      const remaining = num(pick(o, ["remaining_amount", "amount_due", "balance_due", "outstanding", "unpaid_amount"]));
      const status = String(pick(o, ["payment_status", "status", "state"]) ?? "").toLowerCase();
      const paid = /paid|payee|payée|settled/.test(status) && !/unpaid|partial|non/.test(status);
      const data = {
        number: str(pick(o, ["number", "invoice_number", "bill_number", "reference"])),
        counterparty:
          str(pick(o, ["contact.name", "customer.name", "supplier.name", "contact_name", "customer_name", "supplier_name", "vendor_name", "client.name"])) ??
          (kind === "CLIENT" ? "Client Shine" : "Fournisseur Shine"),
        counterpartyEmail: str(pick(o, ["contact.email", "customer.email", "email"])),
        label: str(pick(o, ["title", "description", "subject"])),
        issueDate: date(pick(o, ["date", "issue_date", "invoice_date", "issued_at", "created_at"])) ?? new Date(),
        dueDate: date(pick(o, ["due_date", "payment_due_date", "deadline"])),
        amount,
        paidAmount: paid ? amount : remaining !== null ? Math.max(0, amount - remaining) : 0,
      };
      await prisma.invoice.upsert({
        where: { provider_externalId: { provider: "SHINE", externalId: `${kind}-${id}` } },
        update: data,
        create: { ...data, kind, provider: "SHINE", externalId: `${kind}-${id}`, companyId: integration.companyId, integrationId: integration.id },
      });
      invoices++;
    };

    if (has("invoicing_search_invoices")) {
      const list = await listAll(c, "invoicing_search_invoices", {});
      (meta.champs as Record<string, string[]>).factures = Object.keys(list[0] ?? {});
      for (const o of list) {
        const status = String(pick(o, ["status", "state"]) ?? "").toLowerCase();
        if (/draft|brouillon/.test(status)) continue;
        await upsertInvoice(o, "CLIENT");
      }
    }
    if (has("expenses_list_bills")) {
      const list = await listAll(c, "expenses_list_bills", {});
      (meta.champs as Record<string, string[]>).factures_fournisseurs = Object.keys(list[0] ?? {});
      for (const o of list) await upsertInvoice(o, "SUPPLIER");
    }

    // Lignes bancaires : comptes bancaires du plan comptable, puis leurs lignes (toutes, pas seulement non rapprochées).
    if (has("bank_list_bank_lines") && has("setting_list_accounts")) {
      const accs = findList(payload(await c.callTool({ name: "setting_list_accounts", arguments: { bank_accounts_only: true } })))
        .filter((a) => /bank|banque|512/i.test(JSON.stringify(a)));
      (meta.champs as Record<string, string[]>).comptes = Object.keys(accs[0] ?? {});
      for (const a of accs) {
        const accId = str(pick(a, ["id", "account_id", "uuid"]));
        if (!accId) continue;
        const account = await prisma.bankAccount.upsert({
          where: { provider_externalId: { provider: "SHINE", externalId: accId } },
          update: { lastSyncAt: new Date(), integrationId: integration.id },
          create: {
            companyId: integration.companyId,
            integrationId: integration.id,
            provider: "SHINE",
            externalId: accId,
            name: str(pick(a, ["name", "label", "description"])) ?? "Compte Shine",
            bank: "Shine",
            lastSyncAt: new Date(),
          },
        });
        accounts++;
        const lines = await listAll(c, "bank_list_bank_lines", { account_id: accId, bank_account_id: accId, include_reconciled: true, reconciled: "all" });
        (meta.champs as Record<string, string[]>).lignes_bancaires = Object.keys(lines[0] ?? {});
        for (const l of lines) {
          const id = str(pick(l, ["id", "uuid", "line_id"]));
          const amount = num(pick(l, ["amount", "value", "total"]));
          const d = date(pick(l, ["date", "booking_date", "value_date", "transaction_date", "created_at"]));
          if (!id || amount === null || !d) continue;
          const label = str(pick(l, ["description", "label", "text", "title", "counterparty_name"])) ?? "Opération Shine";
          const category = /virement interne|internal transfer/i.test(label) ? INTERNAL : categorize(label, amount);
          await prisma.bankTransaction.upsert({
            where: { accountId_externalId: { accountId: account.id, externalId: id } },
            update: { amount, label, date: d },
            create: { accountId: account.id, companyId: integration.companyId, externalId: id, date: d, label, amount, category },
          });
          transactions++;
        }
        const bal = await prisma.bankTransaction.aggregate({ where: { accountId: account.id }, _sum: { amount: true } });
        const reported = num(pick(a, ["balance", "current_balance", "bank_balance"]));
        await prisma.bankAccount.update({ where: { id: account.id }, data: { balance: reported ?? bal._sum.amount ?? 0 } });
      }
    }

    await prisma.integration.update({ where: { id: integration.id }, data: { meta: JSON.stringify(meta).slice(0, 4000) } });
    return { accounts, transactions, invoices };
  });
}
