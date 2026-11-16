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
    redirect("/atelier?msg=" + encodeURIComponent("Ce document a des lignes « à compléter » : complétez la demande (ou les accès Autodata / fournisseur) et faites-le préparer à nouveau."));
  }
  const t = await prisma.robotTask.update({ where: { id }, data: { status: "VALIDE", validatedBy: me.email ?? me.id, validatedAt: new Date(), error: null } });
  await audit(me, "atelier_document_valide", t.title);
  after(() => import("@/lib/connectors/gtapro").then((m) => m.runPendingTasks(t.companyId)).catch(() => undefined));
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
1. Temps de main-d'œuvre et valeurs constructeur (huile, capacité, pièces de l'entretien) : consulter_portail sur Autodata pour CE véhicule.
2. Prix des pièces : consulter_portail sur le(s) portail(s) fournisseur(s) (lister_portails), ou le tarif de GTA Pro.
3. Taux horaire : celui de l'atelier dans GTA Pro (lister_atelier / devis existants) ; s'il est inconnu, « à compléter ».
Puis preparer_document_atelier avec la source de chaque ligne ; une valeur introuvable = prix 0 et source « à compléter ».
Résume en 3 lignes ce que tu as préparé et ce qui reste à compléter.`,
    }).then(() => undefined).catch(() => undefined)
  );
  redirect("/atelier?msg=" + encodeURIComponent("Demande transmise à l'agent Clients & devis : le brouillon apparaît ici dans une minute (rechargez la page)."));
}
