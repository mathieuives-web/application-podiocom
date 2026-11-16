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
      task: `Le fondateur demande ${type} : « ${demande} ». Prépare-le avec preparer_document_atelier (prix HT réalistes de l'atelier : main-d'œuvre au barème, pièces au prix de vente ; si une info indispensable manque, mets une hypothèse claire dans « remarques »). Puis résume en 3 lignes ce que tu as préparé.`,
    }).then(() => undefined).catch(() => undefined)
  );
  redirect("/atelier?msg=" + encodeURIComponent("Demande transmise à l'agent Clients & devis : le brouillon apparaît ici dans une minute (rechargez la page)."));
}
