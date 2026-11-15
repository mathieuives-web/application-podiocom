"use server";

import { createHash } from "crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { autoReconcile, categorize } from "@/lib/finance";
import { parseStatement } from "@/lib/statement-import";

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
  await requireAdmin();
  const accountId = str(formData.get("accountId"))!;
  const file = formData.get("file") as File | null;
  const account = await prisma.bankAccount.findUniqueOrThrow({ where: { id: accountId } });
  let message: string;
  try {
    if (!file || file.size === 0) throw new Error("Choisissez un fichier.");
    const lines = await parseStatement(file);
    const seen = new Map<string, number>();
    let created = 0;
    for (const l of lines) {
      // Identifiant stable : même ligne réimportée = ignorée (pas de doublon).
      const base = `${l.date.toISOString().slice(0, 10)}|${l.label}|${l.amount.toFixed(2)}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const externalId = "csv-" + createHash("sha1").update(`${base}|${n}`).digest("hex").slice(0, 20);
      const exists = await prisma.bankTransaction.findUnique({ where: { accountId_externalId: { accountId, externalId } } });
      if (exists) continue;
      await prisma.bankTransaction.create({
        data: {
          accountId,
          companyId: account.companyId,
          externalId,
          date: l.date,
          label: l.label,
          amount: l.amount,
          category: categorize(l.label, l.amount),
        },
      });
      created++;
    }
    const balance = num(formData.get("balance"));
    await prisma.bankAccount.update({
      where: { id: accountId },
      data: { lastSyncAt: new Date(), ...(balance !== null ? { balance } : {}) },
    });
    const matched = await autoReconcile(account.companyId);
    message = `${created} opération(s) importée(s) sur ${lines.length} lue(s), ${matched} facture(s) rapprochée(s).`;
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
  await requireAdmin();
  const { runDailyControl } = await import("@/lib/daily-control");
  const { after } = await import("next/server");
  after(() => runDailyControl({ force: true }).then(() => undefined));
  redirect(`/finances?msg=${encodeURIComponent("Contrôle lancé : synchro, relances, rapports des DAF puis revue du CFO. Rechargez la page dans quelques minutes.")}`);
}

export async function toggleAutoReminders(companyId: string) {
  await requireAdmin();
  const c = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
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
  await requireAdmin();
  const { sendReminder } = await import("@/lib/reminders");
  const r = await sendReminder(reminderId);
  revalidatePath("/finances");
  redirect(`/finances?msg=${encodeURIComponent(r.status === "SENT" ? `Relance envoyée à ${r.to}.` : `Relance non envoyée : ${r.error ?? "e-mail ou SMTP manquant"}`)}`);
}
