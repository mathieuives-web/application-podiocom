"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { audit } from "@/lib/audit";
import { projectAgentSlug } from "@/lib/agents";
import { agentsConfigured, executeAgent } from "@/lib/agent-runtime";

const s = (v: FormDataEntryValue | null, max = 3000) => String(v ?? "").trim().slice(0, max) || null;
const STATUS = ["IDEE", "EN_COURS", "LANCE", "EN_PAUSE"];

function fields(formData: FormData) {
  const repo = s(formData.get("repo"), 200)?.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "") ?? null;
  let website = s(formData.get("website"), 300);
  if (website && !/^https?:\/\//.test(website)) website = `https://${website}`;
  const status = String(formData.get("status") ?? "EN_COURS");
  return {
    description: s(formData.get("description")),
    goal: s(formData.get("goal"), 1500),
    repo,
    website,
    status: STATUS.includes(status) ? status : "EN_COURS",
    notes: s(formData.get("notes")),
  };
}

export async function createProject(formData: FormData) {
  const me = await requireAdmin();
  const name = s(formData.get("name"), 80);
  if (!name) redirect("/projets?msg=" + encodeURIComponent("Donnez un nom au projet."));
  if (await prisma.project.findUnique({ where: { name: name! } })) redirect("/projets?msg=" + encodeURIComponent("Ce projet existe déjà."));
  await prisma.project.create({ data: { name: name!, ...fields(formData) } });
  await audit(me, "projet_cree", name!);
  redirect("/projets?msg=" + encodeURIComponent(`Projet ${name} créé : son chef de projet est dans le board, sous le Directeur des projets.`));
}

export async function updateProject(id: string, formData: FormData) {
  const me = await requireAdmin();
  const p = await prisma.project.update({ where: { id }, data: { ...fields(formData), active: formData.get("active") === "on" } });
  await audit(me, "projet_modifie", p.name);
  revalidatePath("/projets");
}

/** Fait faire le point tout de suite au chef de projet (ou au Directeur des projets pour tous). */
export async function reviewNow(projectId: string | null) {
  const me = await requireAdmin();
  if (!agentsConfigured()) redirect("/projets?msg=" + encodeURIComponent("Agents IA non activés (ANTHROPIC_API_KEY manquante)."));
  const p = projectId ? await prisma.project.findUniqueOrThrow({ where: { id: projectId } }) : null;
  const slug = p ? projectAgentSlug(p) : "directeur-projets";
  await audit(me, "projet_point_demande", p?.name ?? "tous les projets");
  after(() =>
    executeAgent({
      slug,
      userId: me.id,
      task: p ? `Fais le point complet sur le projet ${p.name} en suivant ta méthode (état réel, reste à faire, faire tourner, risques, 3 prochaines actions).` : "Point de tous les projets maintenant : suis ta procédure du lundi.",
    }).then(() => undefined).catch(() => undefined)
  );
  redirect(`/agents?agent=${slug}`);
}

const PROSPECT_STATUS = ["A_CONTACTER", "CONTACTE", "INTERESSE", "CLIENT", "REFUS"];

/** Suivi d'un prospect trouvé par un agent (le fondateur envoie lui-même le message). */
export async function setProspectStatus(id: string, status: string) {
  const me = await requireAdmin();
  if (!PROSPECT_STATUS.includes(status)) return;
  const x = await prisma.prospect.update({ where: { id }, data: { status, ...(status === "CONTACTE" ? { contactedAt: new Date() } : {}) } });
  await audit(me, "prospect_statut", `${x.project} — ${x.name} : ${status}`);
  revalidatePath("/projets");
}

/** Met un chef de projet au travail tout de suite sur sa mission du jour (premier euro, prospection). */
export async function workNow(projectId: string) {
  const me = await requireAdmin();
  if (!agentsConfigured()) redirect("/projets?msg=" + encodeURIComponent("Agents IA non activés (ANTHROPIC_API_KEY manquante)."));
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const { projectMission } = await import("@/lib/daily-control");
  const date = new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "full" });
  await audit(me, "projet_mission_lancee", p.name);
  after(() => executeAgent({ slug: projectAgentSlug(p), userId: me.id, kind: "DAILY", task: projectMission(p, date) }).then(() => undefined).catch(() => undefined));
  redirect("/projets?msg=" + encodeURIComponent(`${p.name} : le chef de projet est au travail (10 à 20 minutes). Les prospects trouvés apparaissent ci-dessous, prêts à envoyer.`));
}
