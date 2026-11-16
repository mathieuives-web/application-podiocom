"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { audit } from "@/lib/audit";
import { agentsConfigured, executeAgent } from "@/lib/agent-runtime";

/** Le fondateur valide : le robot saisit le document dans GTA Pro (en arrière-plan). */
export async function validateTask(id: string) {
  const me = await requireAdmin();
  const draft = await prisma.robotTask.findUniqueOrThrow({ where: { id } });
  const lines = (JSON.parse(draft.payload).lignes ?? []) as { prix_unitaire_ht: number; source?: string }[];
  if (lines.some((l) => !l.prix_unitaire_ht || /compl[ée]ter/i.test(l.source ?? ""))) {
    redirect("/atelier?msg=" + encodeURIComponent("Ce document a des lignes « à compléter » : complétez les lignes en rouge (quantité / temps et prix), puis validez."));
  }
  const t = await prisma.robotTask.update({ where: { id }, data: { status: "VALIDE", validatedBy: me.email ?? me.id, validatedAt: new Date(), error: null } });
  await audit(me, "atelier_document_valide", t.title);
  after(() => import("@/lib/connectors/gtapro").then((m) => m.runPendingTasks(t.companyId)).catch(() => undefined));
  revalidatePath("/atelier");
}

/** Le fondateur complète une ligne lui-même (temps barème lu sur WebDataBays, prix lu chez le fournisseur). */
export async function completeLine(id: string, index: number, formData: FormData) {
  const me = await requireAdmin();
  const t = await prisma.robotTask.findUniqueOrThrow({ where: { id } });
  if (!["BROUILLON", "ERREUR"].includes(t.status)) redirect("/atelier");
  const num = (k: string) => Number(String(formData.get(k) ?? "").replace(/\s/g, "").replace(",", "."));
  const qte = num("quantite");
  const pu = num("prix");
  const source = String(formData.get("source") ?? "").trim().slice(0, 80) || "saisi par le fondateur";
  if (!(qte > 0) || !(pu > 0)) redirect("/atelier?msg=" + encodeURIComponent("Quantité et prix doivent être des nombres supérieurs à 0."));
  const p = JSON.parse(t.payload) as { lignes?: { quantite: number; prix_unitaire_ht: number; source?: string }[]; total_ht?: number };
  const l = p.lignes?.[index];
  if (!l) redirect("/atelier");
  l.quantite = qte;
  l.prix_unitaire_ht = pu;
  l.source = `${source} (saisi par ${me.name ?? "le fondateur"})`;
  p.total_ht = Math.round((p.lignes ?? []).reduce((s, x) => s + x.quantite * x.prix_unitaire_ht, 0) * 100) / 100;
  await prisma.robotTask.update({ where: { id }, data: { payload: JSON.stringify(p) } });
  await audit(me, "atelier_ligne_completee", `${t.title} — ligne ${index + 1}`);
  revalidatePath("/atelier");
}

export async function refuseTask(id: string) {
  const me = await requireAdmin();
  const t = await prisma.robotTask.update({ where: { id }, data: { status: "REFUSE" } });
  await audit(me, "atelier_document_refuse", t.title);
  revalidatePath("/atelier");
}

/** Demande en une phrase : l'agent Clients & devis prépare le devis / l'OR (brouillon à valider). */
export async function askAtelier(formData: FormData) {
  const me = await requireAdmin();
  const demande = String(formData.get("demande") ?? "").trim().slice(0, 2000);
  const type = formData.get("type") === "OR" ? "un ordre de réparation (OR)" : "un devis";
  if (!demande) redirect("/atelier");
  if (!agentsConfigured()) redirect("/atelier?msg=" + encodeURIComponent("Agents IA non activés (ANTHROPIC_API_KEY manquante)."));
  await audit(me, "atelier_demande", demande.slice(0, 200));
  after(() =>
    executeAgent({
      slug: "clients-devis-auto-rac-ives",
      userId: me.id,
      task: `Le fondateur demande ${type} : « ${demande} ». Tu n'inventes RIEN :
1. Temps de main-d'œuvre et valeurs constructeur : WebDataBays bloque les robots, tu NE le consultes PAS. Mets la ligne de main-d'œuvre avec la désignation précise de l'opération, quantité 1, prix 0 et source « à compléter : temps WebDataBays » : le fondateur la complète lui-même. Pour les pièces de l'entretien, demande-lui de vérifier sur WebDataBays si tu n'as pas la valeur dans un document.
2. Prix des pièces : consulter_portail sur le(s) portail(s) fournisseur(s) (lister_portails), ou le tarif de GTA Pro.
3. Taux horaire : celui de l'atelier dans GTA Pro (lister_atelier / devis existants) ; s'il est inconnu, « à compléter ».
Puis preparer_document_atelier avec la source de chaque ligne ; une valeur introuvable = prix 0 et source « à compléter ».
Résume en 3 lignes ce que tu as préparé et ce qui reste à compléter.`,
    }).then(() => undefined).catch(() => undefined)
  );
  redirect("/atelier?msg=" + encodeURIComponent("Demande transmise à l'agent Clients & devis : le brouillon apparaît ici dans une minute (rechargez la page)."));
}

/** Rendez-vous noté à la main par le fondateur. */
export async function addAppointment(formData: FormData) {
  const me = await requireAdmin();
  const { atelierCompany, parisDateTime } = await import("@/lib/atelier");
  const c = await atelierCompany();
  const g = (k: string) => String(formData.get(k) ?? "").trim();
  const start = parisDateTime(g("date"), g("heure") || "08:00");
  if (!g("date") || Number.isNaN(start.getTime()) || !g("client") || !g("prestation")) redirect("/atelier?msg=" + encodeURIComponent("Date, client et prestation obligatoires."));
  await prisma.appointment.create({
    data: {
      companyId: c.id,
      start,
      minutes: Math.max(10, Math.min(Number(g("minutes")) || 60, 720)),
      client: g("client").slice(0, 120),
      phone: g("telephone").slice(0, 40) || null,
      vehicle: g("vehicule").slice(0, 120) || null,
      work: g("prestation").slice(0, 300),
      employeeId: g("employeeId") || null,
      source: "fondateur",
      createdBy: me.email ?? me.id,
    },
  });
  await audit(me, "rdv_atelier_note", `${g("date")} ${g("heure")} ${g("client")}`);
  revalidatePath("/atelier");
}

export async function setAppointmentStatus(id: string, status: string) {
  const me = await requireAdmin();
  if (!["PREVU", "CONFIRME", "EN_COURS", "TERMINE", "ANNULE", "ABSENT"].includes(status)) return;
  const a = await prisma.appointment.update({ where: { id }, data: { status } });
  await audit(me, "rdv_atelier_statut", `${a.client} → ${status}`);
  revalidatePath("/atelier");
}
