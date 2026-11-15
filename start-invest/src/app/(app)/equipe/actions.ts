"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { audit } from "@/lib/audit";
import { computeCommissions, EVENTS, RuleSchema, workingDays, type CommissionEvent } from "@/lib/team";
import { parseDate } from "@/lib/statement-import";

const s = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const back = (msg: string, q = "") => redirect(`/equipe?${q}${q ? "&" : ""}msg=${encodeURIComponent(msg)}`);

export async function createEmployee(formData: FormData) {
  const me = await requireAdmin();
  const companyId = s(formData.get("companyId"));
  const firstName = s(formData.get("firstName")).replace(/^./, (x) => x.toUpperCase()).slice(0, 60);
  const lastName = s(formData.get("lastName")).toUpperCase().slice(0, 60);
  if (!companyId || !firstName) back("Prénom et société obligatoires.");
  const exists = await prisma.employee.findUnique({ where: { companyId_firstName_lastName: { companyId, firstName, lastName } } });
  if (exists) back(`${firstName} existe déjà.`);
  await prisma.employee.create({ data: { companyId, firstName, lastName, role: s(formData.get("role")).slice(0, 80) || null, phone: s(formData.get("phone")).replace(/\D/g, "").replace(/^0(\d{9})$/, "33$1") || null } });
  await audit(me, "salarie_cree", `${firstName} ${lastName}`);
  back(`${firstName} ajouté(e). Son agent personnel est créé dans le board. Déposez son contrat dans Archives pour ses règles de commission.`);
}

export async function updateEmployee(employeeId: string, formData: FormData) {
  const me = await requireAdmin();
  const rules: Record<string, unknown> = {};
  for (const ev of Object.keys(EVENTS) as CommissionEvent[]) {
    const mode = s(formData.get(`${ev}.mode`)) || "AUCUNE";
    if (mode === "AUCUNE") continue;
    const min = s(formData.get(`${ev}.min`));
    const r = RuleSchema.safeParse({
      mode,
      valeur: Number(s(formData.get(`${ev}.valeur`)).replace(",", ".")) || 0,
      vehicules: s(formData.get(`${ev}.vehicules`)) || "TOUS",
      minimum_marge: min ? Number(min.replace(",", ".")) : null,
    });
    if (r.success) rules[ev] = r.data;
  }
  const e = await prisma.employee.update({
    where: { id: employeeId },
    data: {
      rules: JSON.stringify(rules),
      rulesNote: s(formData.get("rulesNote")).slice(0, 2000) || null,
      role: s(formData.get("role")).slice(0, 80) || null,
      leaveDaysPerYear: Number(s(formData.get("leaveDaysPerYear")).replace(",", ".")) || 25,
      active: formData.get("active") === "on",
      phone: s(formData.get("phone")).replace(/\D/g, "").replace(/^0(\d{9})$/, "33$1") || null,
      email: s(formData.get("email")).slice(0, 120) || null,
    },
  });
  await audit(me, "regles_commission_modifiees", `${e.firstName} ${e.lastName} : ${JSON.stringify(rules)}`);
  await computeCommissions(e.companyId);
  back(`Règles de ${e.firstName} enregistrées, commissions recalculées.`);
}

export async function addLeave(employeeId: string, formData: FormData) {
  const me = await requireAdmin();
  const start = parseDate(s(formData.get("start")));
  const end = parseDate(s(formData.get("end")));
  if (!start || !end || end < start) back("Dates de congé invalides.");
  const typed = s(formData.get("days")).replace(",", ".");
  const days = typed ? Number(typed) : workingDays(start!, end!);
  const type = ["CP", "RTT", "MALADIE", "SANS_SOLDE", "AUTRE"].includes(s(formData.get("type"))) ? s(formData.get("type")) : "CP";
  const l = await prisma.leave.create({ data: { employeeId, start: start!, end: end!, days, type, note: s(formData.get("note")).slice(0, 200) || null }, include: { employee: true } });
  await audit(me, "conge_ajoute", `${l.employee.firstName} : ${type} ${days} j`);
  revalidatePath("/equipe");
}

export async function deleteLeave(leaveId: string) {
  const me = await requireAdmin();
  const l = await prisma.leave.delete({ where: { id: leaveId }, include: { employee: true } });
  await audit(me, "conge_supprime", `${l.employee.firstName} : ${l.type} ${l.days} j`);
  revalidatePath("/equipe");
}

/** Marque comme versées toutes les commissions dues à un salarié jusqu'au mois donné (hors lignes à vérifier). */
export async function markPaid(employeeId: string, month: string) {
  const me = await requireAdmin();
  const r = await prisma.commission.updateMany({
    where: { employeeId, status: "A_VERSER", month: { lte: month }, warning: null },
    data: { status: "VERSE", paidAt: new Date() },
  });
  const e = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
  await audit(me, "commissions_versees", `${e.firstName} ${e.lastName} : ${r.count} ligne(s) jusqu'à ${month}`);
  revalidatePath("/equipe");
}

export async function setCommissionStatus(commissionId: string, status: "A_VERSER" | "VERSE") {
  const me = await requireAdmin();
  const c = await prisma.commission.update({ where: { id: commissionId }, data: { status, paidAt: status === "VERSE" ? new Date() : null, ...(status === "VERSE" ? { warning: null } : {}) } });
  await audit(me, "commission_statut", `${c.id} → ${status} (${c.amount} €)`);
  revalidatePath("/equipe");
}

export async function recompute() {
  const me = await requireAdmin();
  const r = await computeCommissions();
  await audit(me, "commissions_recalculees", `${r.changed} modifiée(s)`);
  back(`Commissions recalculées : ${r.computed} ligne(s), ${r.changed} modifiée(s).`);
}
