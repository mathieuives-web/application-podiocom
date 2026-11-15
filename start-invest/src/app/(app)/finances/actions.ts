"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { autoReconcile } from "@/lib/finance";
import { parseStatement } from "@/lib/statement-import";
import { audit } from "@/lib/audit";

function str(v: FormDataEntryValue | null) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}
function num(v: FormDataEntryValue | null) {
  const s = str(v);
  if (!s) return null;
  const n = Number(s.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export async function createCompany(formData: FormData) {
  await requireAdmin();
  await prisma.company.create({
    data: {
      name: str(formData.get("name"))!,
      activity: str(formData.get("activity")),
      color: str(formData.get("color")) ?? "#7f1d1d",
    },
  });
  revalidatePath("/finances");
}

export async function createBankAccount(formData: FormData) {
  await requireAdmin();
  await prisma.bankAccount.create({
    data: {
      companyId: str(formData.get("companyId"))!,
      name: str(formData.get("name"))!,
      bank: str(formData.get("bank")),
      iban: str(formData.get("iban")),
      balance: num(formData.get("balance")) ?? 0,
    },
  });
  revalidatePath("/finances");
}

export async function importStatement(formData: FormData) {
  const me = await requireAdmin();
  const accountId = str(formData.get("accountId"))!;
  const file = formData.get("file") as File | null;
  const account = await prisma.bankAccount.findUniqueOrThrow({ where: { id: accountId } });
  let message: string;
  try {
    if (!file || file.size === 0) throw new Error("Choisissez un fichier.");
    const lines = await parseStatement(file);
    const { importLines } = await import("@/lib/documents");
    const { created, skipped } = await importLines(accountId, lines);
    const balance = num(formData.get("balance"));
    await prisma.bankAccount.update({
      where: { id: accountId },
      data: { lastSyncAt: new Date(), ...(balance !== null ? { balance } : {}) },
    });
    const matched = await autoReconcile(account.companyId);
    await audit(me, "releve_importe", `${file?.name} — ${created} opération(s)`);
    message = `${created} opération(s) importée(s) sur ${lines.length} lue(s)${skipped ? ` (${skipped} déjà fournies par la synchro bancaire)` : ""}, ${matched} facture(s) rapprochée(s).`;
  } catch (e) {
    message = `Import impossible : ${(e as Error).message}`;
  }
  revalidatePath("/finances");
  redirect(`/finances?msg=${encodeURIComponent(message)}`);
}

export async function createInvoice(formData: FormData) {
  await requireAdmin();
  const issue = str(formData.get("issueDate"));
  const due = str(formData.get("dueDate"));
  await prisma.invoice.create({
    data: {
      companyId: str(formData.get("companyId"))!,
      kind: str(formData.get("kind")) === "SUPPLIER" ? "SUPPLIER" : "CLIENT",
      number: str(formData.get("number")),
      counterparty: str(formData.get("counterparty"))!,
      counterpartyEmail: str(formData.get("counterpartyEmail")),
      label: str(formData.get("label")),
      issueDate: issue ? new Date(issue) : new Date(),
      dueDate: due ? new Date(due) : null,
      amount: num(formData.get("amount")) ?? 0,
    },
  });
  await autoReconcile();
  revalidatePath("/finances");
}

export async function markInvoicePaid(invoiceId: string) {
  await requireAdmin();
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  await prisma.invoice.update({ where: { id: invoiceId }, data: { paidAmount: inv.amount } });
  revalidatePath("/finances");
}

export async function reconcileNow() {
  await requireAdmin();
  const n = await autoReconcile();
  revalidatePath("/finances");
  redirect(`/finances?msg=${encodeURIComponent(`${n} opération(s) rapprochée(s) avec une facture.`)}`);
}

// ------------------------------------------------ contrôle quotidien & relances

export async function runControlNow() {
  const me = await requireAdmin();
  await audit(me, "controle_quotidien_lance");
  const { runDailyControl } = await import("@/lib/daily-control");
  const { after } = await import("next/server");
  after(() => runDailyControl({ force: true }).then(() => undefined));
  redirect(`/finances?msg=${encodeURIComponent("Contrôle lancé : synchro, relances, rapports des DAF puis revue du CFO. Rechargez la page dans quelques minutes.")}`);
}

export async function toggleAutoReminders(companyId: string) {
  const me = await requireAdmin();
  const c = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  await audit(me, c.autoReminders ? "relances_desactivees" : "relances_activees", c.name);
  await prisma.company.update({ where: { id: companyId }, data: { autoReminders: !c.autoReminders } });
  revalidatePath("/finances");
}

export async function setInvoiceEmail(invoiceId: string, formData: FormData) {
  await requireAdmin();
  const email = str(formData.get("email"));
  await prisma.invoice.update({ where: { id: invoiceId }, data: { counterpartyEmail: email } });
  // Les relances en brouillon de cette facture prennent la nouvelle adresse.
  await prisma.reminder.updateMany({ where: { invoiceId, status: { not: "SENT" } }, data: { to: email } });
  revalidatePath("/finances");
}

export async function sendReminderNow(reminderId: string) {
  const me = await requireAdmin();
  await audit(me, "relance_envoyee_manuellement", reminderId);
  const { sendReminder } = await import("@/lib/reminders");
  const r = await sendReminder(reminderId);
  revalidatePath("/finances");
  redirect(`/finances?msg=${encodeURIComponent(r.status === "SENT" ? `Relance envoyée à ${r.to}.` : `Relance non envoyée : ${r.error ?? "e-mail ou SMTP manquant"}`)}`);
}

/** Rattache un compte bancaire (et toutes ses opérations) à une autre société du groupe. */
export async function moveAccount(accountId: string, formData: FormData) {
  const me = await requireAdmin();
  const companyId = str(formData.get("companyId"));
  if (!companyId) return;
  if (companyId === "__exclure__") {
    const account = await prisma.bankAccount.findUniqueOrThrow({ where: { id: accountId } });
    await prisma.$transaction([
      prisma.bankTransaction.deleteMany({ where: { accountId } }),
      prisma.bankAccount.update({ where: { id: accountId }, data: { excluded: true, autoAssigned: false, balance: 0 } }),
    ]);
    await audit(me, "compte_exclu", `${account.name} (${account.iban ? "…" + account.iban.slice(-4) : "sans IBAN"}) : opérations supprimées, plus d'import`);
    revalidatePath("/finances");
    return;
  }
  const [account, company] = await Promise.all([
    prisma.bankAccount.findUniqueOrThrow({ where: { id: accountId } }),
    prisma.company.findUniqueOrThrow({ where: { id: companyId } }),
  ]);
  await prisma.$transaction([
    prisma.bankAccount.update({ where: { id: accountId }, data: { companyId, autoAssigned: false, excluded: false } }),
    prisma.bankTransaction.updateMany({ where: { accountId }, data: { companyId, invoiceId: null } }),
  ]);
  await audit(me, "compte_rattache", `${account.name} (${account.iban ? "…" + account.iban.slice(-4) : "sans IBAN"}) → ${company.name}`);
  revalidatePath("/finances");
}

export async function renameAccount(accountId: string, formData: FormData) {
  await requireAdmin();
  const name = str(formData.get("name"));
  if (name) await prisma.bankAccount.update({ where: { id: accountId }, data: { name: name.slice(0, 80) } });
  revalidatePath("/finances");
}

/** Range tous les comptes bancaires synchronisés dans la société dont ils portent le nom (comptes exclus inchangés). */
export async function autoAssignAccounts() {
  const me = await requireAdmin();
  const { guessCompany } = await import("@/lib/connectors/enablebanking");
  const accounts = await prisma.bankAccount.findMany({ where: { excluded: false } });
  let moved = 0;
  for (const a of accounts) {
    const target = await guessCompany(a.name);
    if (!target || target === a.companyId) continue;
    await prisma.$transaction([
      prisma.bankAccount.update({ where: { id: a.id }, data: { companyId: target, autoAssigned: false } }),
      prisma.bankTransaction.updateMany({ where: { accountId: a.id }, data: { companyId: target, invoiceId: null } }),
    ]);
    moved++;
  }
  await audit(me, "comptes_ranges_automatiquement", `${moved} compte(s) déplacé(s)`);
  revalidatePath("/finances");
  redirect(`/finances?msg=${encodeURIComponent(`${moved} compte(s) rangé(s) dans la société correspondant à leur nom. Vérifiez le tableau « Comptes bancaires ».`)}`);
}

/** Type de compte : COURANT (trésorerie), SEQUESTRE (fonds de tiers), PRET (emprunt). */
export async function setAccountKind(accountId: string, formData: FormData) {
  const me = await requireAdmin();
  const kind = str(formData.get("kind"));
  if (!kind || !["COURANT", "SEQUESTRE", "PRET"].includes(kind)) return;
  const a = await prisma.bankAccount.update({ where: { id: accountId }, data: { kind } });
  await audit(me, "type_de_compte", `${a.name} (${a.iban ? "…" + a.iban.slice(-4) : "sans IBAN"}) → ${kind}`);
  revalidatePath("/finances");
}

export async function setOverdraft(accountId: string, formData: FormData) {
  const me = await requireAdmin();
  const raw = (str(formData.get("limit")) ?? "").replace(/\s|€/g, "").replace(",", ".");
  const limit = Math.max(0, Math.min(100_000_000, Number(raw) || 0));
  const note = (str(formData.get("note")) ?? "").slice(0, 300) || null;
  const a = await prisma.bankAccount.update({ where: { id: accountId }, data: { overdraftLimit: limit, financingNote: note } });
  await audit(me, "decouvert_autorise", `${a.name} (${a.iban ? "…" + a.iban.slice(-4) : "sans IBAN"}) → ${limit} €${note ? " — " + note : ""}`);
  revalidatePath("/finances");
}
