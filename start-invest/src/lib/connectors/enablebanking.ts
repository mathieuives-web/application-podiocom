import { createSign } from "crypto";
import { prisma } from "@/lib/prisma";
import { categorize, INTERNAL } from "@/lib/finance";
import type { SyncResult } from "./types";

// Enable Banking : accès DSP2 officiel à presque toutes les banques européennes (Shine, BNP, Crédit
// Agricole, Société Générale, LCL, CIC, Qonto...). Gratuit pour ses propres comptes (« Restricted
// Production »). Lecture seule : soldes et opérations. Accord bancaire valable jusqu'à 180 jours.
// Doc : https://enablebanking.com/docs/api/quick-start/

const API = process.env.ENABLE_BANKING_API_URL || "https://api.enablebanking.com";

export type BankCreds = {
  sessionId: string;
  bank: string;
  validUntil: string; // ISO
  accounts: { uid: string; iban?: string | null; name?: string | null; currency?: string | null }[];
};

function privateKey() {
  let k = process.env.ENABLE_BANKING_PRIVATE_KEY ?? "";
  if (k && !k.includes("BEGIN")) k = Buffer.from(k, "base64").toString("utf8"); // clé collée en base64
  return k.replace(/\\n/g, "\n").trim();
}

export function bankConfigured() {
  return Boolean(process.env.ENABLE_BANKING_APP_ID && privateKey().includes("PRIVATE KEY") && process.env.NEXTAUTH_URL);
}

export function bankRedirectUri() {
  return `${(process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "")}/api/banque/callback`;
}

function jwt() {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const head = b64({ typ: "JWT", alg: "RS256", kid: process.env.ENABLE_BANKING_APP_ID });
  const body = b64({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat, exp: iat + 3600 });
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey()).toString("base64url");
  return `${head}.${body}.${sig}`;
}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${jwt()}`, "Content-Type": "application/json", Accept: "application/json" },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new Error(`Accès bancaire refusé (${res.status}) : accord expiré ou application Enable Banking inactive. ${text}`);
    throw new Error(`Erreur Enable Banking ${res.status} : ${text}`);
  }
  return (await res.json()) as T;
}

type Aspsp = { name: string; country: string; psu_types?: string[]; maximum_consent_validity?: number };
let banksCache: { at: number; list: Aspsp[] } | null = null;

/** Banques françaises disponibles (mise en cache une journée). */
export async function listBanks(): Promise<Aspsp[]> {
  if (banksCache && Date.now() - banksCache.at < 86400000) return banksCache.list;
  const r = await api<{ aspsps: Aspsp[] }>("/aspsps?country=FR");
  const list = r.aspsps.sort((a, b) => a.name.localeCompare(b.name));
  banksCache = { at: Date.now(), list };
  return list;
}

export async function startBankAuth(bank: string, state: string) {
  const banks = await listBanks().catch(() => []);
  const aspsp = banks.find((b) => b.name === bank);
  const maxSeconds = aspsp?.maximum_consent_validity ?? 180 * 86400;
  const validUntil = new Date(Date.now() + Math.min(maxSeconds, 180 * 86400) * 1000 - 3600000);
  const psuType = aspsp?.psu_types?.includes("business") ? "business" : "personal";
  const r = await api<{ url: string }>("/auth", {
    method: "POST",
    body: { access: { valid_until: validUntil.toISOString() }, aspsp: { name: bank, country: "FR" }, state, redirect_url: bankRedirectUri(), psu_type: psuType },
  });
  return r.url;
}

type SessionResp = {
  session_id: string;
  access?: { valid_until?: string };
  accounts?: ({ uid: string; account_id?: { iban?: string }; name?: string; currency?: string } | string)[];
  accounts_data?: { uid: string; account_id?: { iban?: string }; name?: string; currency?: string }[];
};

export async function createBankSession(code: string, bank: string): Promise<BankCreds> {
  const s = await api<SessionResp>("/sessions", { method: "POST", body: { code } });
  const raw = (s.accounts_data ?? s.accounts ?? []) as SessionResp["accounts_data"] | string[];
  const accounts = (raw ?? []).map((a) =>
    typeof a === "string" ? { uid: a } : { uid: a.uid, iban: a.account_id?.iban ?? null, name: a.name ?? null, currency: a.currency ?? null }
  );
  if (!accounts.length) throw new Error("Aucun compte autorisé par la banque.");
  return { sessionId: s.session_id, bank, validUntil: s.access?.valid_until ?? new Date(Date.now() + 90 * 86400000).toISOString(), accounts };
}

type Tx = {
  entry_reference?: string | null;
  transaction_id?: string | null;
  transaction_amount: { amount: string; currency: string };
  credit_debit_indicator: "CRDT" | "DBIT";
  status?: string;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  remittance_information?: string[] | null;
  creditor?: { name?: string } | null;
  debtor?: { name?: string } | null;
  bank_transaction_code?: { description?: string } | null;
  note?: string | null;
};

const normName = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\b(SAS|SARL|EURL|SA|SCI|LE|LA|L)\b/g, " ").replace(/\s+/g, " ").trim();

/** Société dont le nom correspond au nom du compte bancaire (ex. « L USINE » -> Le Bar L'Usine). */
export async function guessCompany(accountName: string | null | undefined) {
  if (!accountName) return null;
  const n = normName(accountName);
  if (!n) return null;
  const companies = await prisma.company.findMany({ where: { active: true } });
  const scored = companies
    .map((c) => {
      const cn = normName(c.name);
      const words = cn.split(" ").filter((w) => w.length > 2 && !["BAR", "FABRIQUE"].includes(w));
      const exact = cn === n || cn.replace(/ /g, "") === n.replace(/ /g, "");
      const contains = n.length > 3 && (cn.includes(n) || n.includes(cn));
      const hits = words.filter((w) => n.includes(w)).length;
      // Tous les mots distinctifs de la société doivent apparaître (évite « MATHIEU IVES » -> Auto Rac Ives).
      return { c, score: exact ? 100 : contains ? 50 + n.length : words.length && hits === words.length ? hits * 10 : 0 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.length && (scored.length === 1 || scored[0].score > scored[1].score) ? scored[0].c.id : null;
}

export async function syncEnableBanking(integration: { id: string; companyId: string; lastSyncAt: Date | null }, creds: BankCreds): Promise<SyncResult> {
  if (new Date(creds.validUntil).getTime() < Date.now()) {
    throw new Error(`L'accord bancaire ${creds.bank} a expiré : reconnectez la banque dans Connexions.`);
  }
  // Première synchro : tout l'historique que la banque accepte de donner (souvent 13 à 24 mois).
  const from = integration.lastSyncAt ? new Date(integration.lastSyncAt.getTime() - 10 * 86400000) : new Date(Date.now() - 730 * 86400000);
  let transactions = 0;
  const failures: string[] = [];
  // Un compte lent ou en erreur côté banque ne bloque plus les autres (la banque répond parfois « timeout »).
  for (const a of creds.accounts) {
   try {
    const details = await api<{ account_id?: { iban?: string }; name?: string; currency?: string }>(`/accounts/${a.uid}/details`).catch(() => null);
    const iban = a.iban ?? details?.account_id?.iban ?? null;
    const bal = await api<{ balances: { balance_amount: { amount: string }; balance_type: string }[] }>(`/accounts/${a.uid}/balances`).catch(() => ({ balances: [] }));
    const prefer = ["ITAV", "CLAV", "ITBD", "CLBD", "XPCD", "OTHR"];
    const b = [...bal.balances].sort((x, y) => prefer.indexOf(x.balance_type) - prefer.indexOf(y.balance_type))[0];
    const balance = b ? Number(b.balance_amount.amount) : undefined;
    const name = a.name ?? details?.name ?? null;
    const guessed = (await guessCompany(name)) ?? integration.companyId;
    const existing = await prisma.bankAccount.findUnique({ where: { provider_externalId: { provider: "BANQUE", externalId: a.uid } } });
    // Rattachement automatique d'après le nom du compte, tant que personne ne l'a changé à la main.
    if (existing?.autoAssigned && existing.companyId !== guessed) {
      await prisma.$transaction([
        prisma.bankAccount.update({ where: { id: existing.id }, data: { companyId: guessed } }),
        prisma.bankTransaction.updateMany({ where: { accountId: existing.id }, data: { companyId: guessed } }),
      ]);
    }
    const account = await prisma.bankAccount.upsert({
      where: { provider_externalId: { provider: "BANQUE", externalId: a.uid } },
      update: { lastSyncAt: new Date(), integrationId: integration.id, ...(balance !== undefined ? { balance } : {}), ...(iban ? { iban } : {}) },
      create: {
        companyId: guessed,
        integrationId: integration.id,
        provider: "BANQUE",
        externalId: a.uid,
        name: name ?? `Compte ${creds.bank}`,
        kind: /d[ée]p[ôo]t.?vente|s[ée]questre|escrow|cantonn/i.test(name ?? "") ? "SEQUESTRE" : /pr[êe]t|cr[ée]dit|emprunt|loan/i.test(name ?? "") ? "PRET" : "COURANT",
        bank: creds.bank,
        iban,
        currency: a.currency ?? details?.currency ?? "EUR",
        balance: balance ?? 0,
        lastSyncAt: new Date(),
      },
    });

    if (account.excluded) continue; // compte personnel ou hors pilotage : rien n'est importé
    let key: string | undefined;
    for (let page = 0; page < 200; page++) {
      const q = new URLSearchParams({ date_from: from.toISOString().slice(0, 10) });
      if (key) q.set("continuation_key", key);
      const path = `/accounts/${a.uid}/transactions?${q}`;
      const r = await api<{ transactions: Tx[]; continuation_key?: string | null }>(path).catch(async (e) => {
        if (!/\b(408|429|50[234])\b/.test((e as Error).message)) throw e;
        await new Promise((res) => setTimeout(res, 5000)); // la banque est lente : un nouvel essai
        return api<{ transactions: Tx[]; continuation_key?: string | null }>(path);
      });
      for (const t of r.transactions ?? []) {
        if (t.status && t.status !== "BOOK") continue; // uniquement les opérations comptabilisées
        const dateStr = t.booking_date ?? t.value_date ?? t.transaction_date;
        if (!dateStr) continue;
        const raw = Math.abs(Number(t.transaction_amount.amount));
        const amount = t.credit_debit_indicator === "DBIT" ? -raw : raw;
        const counterparty = (amount < 0 ? t.creditor?.name : t.debtor?.name) ?? null;
        const label = [counterparty, ...(t.remittance_information ?? []), t.bank_transaction_code?.description].filter(Boolean).join(" — ").replace(/\s+/g, " ").trim() || `Opération ${creds.bank}`;
        const externalId = t.entry_reference || t.transaction_id || `${dateStr}|${amount}|${label}`.slice(0, 190);
        const category = /virement interne|vir(ement)? (de|vers) (start invest|sci mapo|la fabrique|auto rac|le bar|bar l.?usine)/i.test(label) ? INTERNAL : categorize(label, amount);
        await prisma.bankTransaction.upsert({
          where: { accountId_externalId: { accountId: account.id, externalId } },
          update: { amount, label },
          create: { accountId: account.id, companyId: account.companyId, externalId, date: new Date(dateStr), label, counterparty, amount, category },
        });
        transactions++;
      }
      if (!r.continuation_key) break;
      key = r.continuation_key;
    }
   } catch (e) {
    failures.push(`${a.name ?? a.iban ?? a.uid} : ${(e as Error).message.slice(0, 120)}`);
   }
  }
  if (failures.length === creds.accounts.length) throw new Error(`Banque ${creds.bank} indisponible pour le moment (nouvel essai dans une heure) — ${failures[0]}`);
  await prisma.integration.update({ where: { id: integration.id }, data: { meta: failures.length ? JSON.stringify({ comptes_non_synchronises: failures }).slice(0, 2000) : null } });
  if (failures.length) console.log(`[synchro] ${creds.bank} : ${failures.length} compte(s) non synchronisé(s) cette fois — ${failures.join(" | ").slice(0, 300)}`);
  return { accounts: creds.accounts.length, transactions, invoices: 0 };
}
