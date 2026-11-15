import nodemailer from "nodemailer";
import { prisma } from "@/lib/prisma";
import { invoiceStatus } from "@/lib/finance";

// Relances automatiques des factures clients en retard.
// Niveau 1 : J+3 (courtoise) · Niveau 2 : J+15 (ferme) · Niveau 3 : J+30 (dernière relance avant mise en demeure).
// Envoi par e-mail si SMTP_* est configuré et que l'e-mail du client est connu ; sinon la relance est
// préparée en brouillon (statut DRAFT) et visible dans Finances pour envoi manuel.

export const LEVELS = [
  { level: 1, days: 3, label: "Relance courtoise (J+3)" },
  { level: 2, days: 15, label: "Relance ferme (J+15)" },
  { level: 3, days: 30, label: "Dernière relance (J+30)" },
];

const DAY = 86400000;
const eur = (n: number) => n.toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
const d = (x: Date) => x.toLocaleDateString("fr-FR");

export function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

let transport: nodemailer.Transporter | null = null;
function mailer() {
  return (transport ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  }));
}

function template(level: number, inv: { number: string | null; counterparty: string; dueDate: Date | null; amount: number; paidAmount: number }, company: string) {
  const ref = inv.number ? `n° ${inv.number}` : "";
  const due = eur(inv.amount - inv.paidAmount);
  const date = inv.dueDate ? d(inv.dueDate) : "";
  if (level === 1)
    return {
      subject: `Rappel : facture ${ref} — ${company}`.replace("  ", " "),
      body: `Bonjour,\n\nSauf erreur de notre part, la facture ${ref} d'un montant de ${due}, arrivée à échéance le ${date}, n'a pas encore été réglée.\n\nIl s'agit peut-être d'un simple oubli : pourriez-vous procéder au règlement dans les meilleurs délais ? Si le paiement a déjà été effectué, merci de ne pas tenir compte de ce message.\n\nBien cordialement,\n${company}`,
    };
  if (level === 2)
    return {
      subject: `Deuxième relance : facture ${ref} impayée — ${company}`.replace("  ", " "),
      body: `Bonjour,\n\nMalgré notre premier rappel, la facture ${ref} de ${due}, échue depuis le ${date}, reste impayée.\n\nNous vous remercions de régulariser ce règlement sous 8 jours. En cas de difficulté, contactez-nous pour convenir d'une solution.\n\nCordialement,\n${company}`,
    };
  return {
    subject: `Dernière relance avant mise en demeure : facture ${ref} — ${company}`.replace("  ", " "),
    body: `Bonjour,\n\nLa facture ${ref} de ${due}, échue depuis le ${date}, demeure impayée malgré nos précédentes relances.\n\nSans règlement sous 8 jours, nous serons contraints d'engager une procédure de recouvrement, avec application des pénalités de retard et de l'indemnité forfaitaire de 40 € prévues par la loi (art. L441-10 du Code de commerce).\n\nCordialement,\n${company}`,
  };
}

async function send(reminderId: string) {
  const r = await prisma.reminder.findUniqueOrThrow({ where: { id: reminderId } });
  if (!r.to || !smtpConfigured()) return r;
  try {
    await mailer().sendMail({ from: process.env.SMTP_FROM, to: r.to, subject: r.subject, text: r.body });
    return prisma.reminder.update({ where: { id: r.id }, data: { status: "SENT", sentAt: new Date(), error: null } });
  } catch (e) {
    return prisma.reminder.update({ where: { id: r.id }, data: { status: "ERROR", error: (e as Error).message.slice(0, 300) } });
  }
}

/** Crée (et envoie si possible) la relance due pour chaque facture client en retard. */
export async function runReminders() {
  const invoices = await prisma.invoice.findMany({
    where: { kind: "CLIENT", company: { autoReminders: true, active: true } },
    include: { company: true, reminders: true },
  });
  let created = 0;
  let sent = 0;
  for (const inv of invoices) {
    if (invoiceStatus(inv) !== "EN_RETARD" || !inv.dueDate) continue;
    if (inv.externalReminders) continue; // déjà relancée par le logiciel de facturation (ex. Shine Facture)
    const late = Math.floor((Date.now() - inv.dueDate.getTime()) / DAY);
    const due = [...LEVELS].reverse().find((l) => late >= l.days);
    if (!due || inv.reminders.some((r) => r.level >= due.level)) continue;
    const { subject, body } = template(due.level, inv, inv.company.name);
    const r = await prisma.reminder.create({
      data: {
        invoiceId: inv.id,
        level: due.level,
        to: inv.counterpartyEmail,
        subject,
        body,
        status: "DRAFT",
        error: inv.counterpartyEmail ? (smtpConfigured() ? null : "Envoi d'e-mails non configuré (SMTP)") : "E-mail du client manquant",
      },
    });
    created++;
    if ((await send(r.id)).status === "SENT") sent++;
  }
  return { created, sent };
}

/** Envoi manuel d'une relance restée en brouillon. */
export async function sendReminder(reminderId: string) {
  return send(reminderId);
}
