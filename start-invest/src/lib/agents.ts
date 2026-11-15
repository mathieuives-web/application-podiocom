import { readdir, readFile } from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";

// Les agents sont définis dans .claude/agents/*.md (format des sous-agents Claude Code).
// Champs utilisés : name, description, model, tools + champs du board : title, parent,
// structure, skills, works_with. Le corps du fichier est le prompt système de l'agent.

export const AGENTS_DIR = path.join(process.cwd(), ".claude", "agents");

export type AgentDef = {
  slug: string;
  name: string;
  title: string;
  description: string;
  model: string;
  tools: string[];
  skills: string[];
  worksWith: string[];
  parent: string | null;
  structure: string;
  file: string;
  prompt: string;
};

function list(v: string | undefined) {
  if (!v) return [];
  return v
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseAgent(slug: string, raw: string): AgentDef {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const front: Record<string, string> = {};
  const body = m ? m[2] : raw;
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (kv) front[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return {
    slug,
    name: front.name || slug,
    title: front.title || front.name || slug,
    description: front.description || "",
    model: front.model || "opus",
    tools: list(front.tools),
    skills: list(front.skills),
    worksWith: list(front.works_with),
    parent: front.parent || null,
    structure: front.structure || "Groupe",
    file: `.claude/agents/${slug}.md`,
    prompt: body.trim(),
  };
}

export async function loadAgents(): Promise<AgentDef[]> {
  let files: string[] = [];
  try {
    files = (await readdir(AGENTS_DIR)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const agents = await Promise.all(
    files.map(async (f) => parseAgent(f.replace(/\.md$/, ""), await readFile(path.join(AGENTS_DIR, f), "utf8")))
  );
  agents.push(...(await employeeAgents(agents)), ...(await projectAgents()));
  const slugs = new Set(agents.map((a) => a.slug));
  // Un parent inexistant est rattaché à la racine pour ne jamais "perdre" un agent.
  const root = agents.find((a) => !a.parent)?.slug ?? null;
  for (const a of agents) {
    if (a.parent && !slugs.has(a.parent)) a.parent = root === a.slug ? null : root;
    a.worksWith = a.worksWith.filter((w) => slugs.has(w) && w !== a.slug);
  }
  return agents.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function getAgent(slug: string) {
  return (await loadAgents()).find((a) => a.slug === slug) ?? null;
}

/** Agents qu'un agent a le droit de consulter : son équipe directe + ceux avec qui il travaille. */
export function reachableFrom(agent: AgentDef, all: AgentDef[]) {
  const team = all.filter((a) => a.parent === agent.slug).map((a) => a.slug);
  return Array.from(new Set([...team, ...agent.worksWith]));
}

const slugify = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Slug de l'agent personnel d'un salarié. */
export function employeeAgentSlug(e: { id: string; firstName: string }) {
  return `salarie-${slugify(e.firstName)}-${e.id.slice(-4)}`;
}

/**
 * Un agent par salarié actif, à son prénom, dans l'équipe du directeur des ventes de sa société
 * (ou de son directeur général). Créés automatiquement à partir de la page Équipe / des contrats.
 */
async function employeeAgents(fileAgents: AgentDef[]): Promise<AgentDef[]> {
  const emps = await prisma.employee
    .findMany({ where: { active: true }, include: { company: { select: { name: true } } }, orderBy: { firstName: "asc" } })
    .catch(() => []);
  return emps.map((e) => {
    const boss =
      fileAgents.find((a) => a.slug.startsWith("directeur-ventes-") && a.structure === e.company.name) ??
      fileAgents.find((a) => a.slug.startsWith("dg-") && a.structure === e.company.name);
    const slug = employeeAgentSlug(e);
    return {
      slug,
      name: slug,
      title: e.firstName,
      description: `Agent personnel de ${e.firstName}${e.role ? ` (${e.role})` : ""} : ses véhicules achetés et vendus, ses commissions (même versées plusieurs mois après) et ses congés.`,
      model: "sonnet",
      tools: [],
      skills: ["suivi individuel", "commissions", "congés"],
      worksWith: [],
      parent: boss?.slug ?? null,
      structure: e.company.name,
      file: "(salarié — page Équipe)",
      prompt: `Tu es l'agent personnel de ${e.firstName} ${e.lastName}`.trim() + `, ${e.role ?? "salarié"} chez ${e.company.name}.
Ton identifiant salarié est « ${e.id} » : appelle fiche_salarie avec salarie="${e.id}" pour avoir SES données
(règles de commission de son contrat, véhicules achetés et vendus, commissions dues et versées, congés).
Tu réponds sur lui seul : ce qu'il a vendu et acheté, ce qu'il a touché et ce qui lui reste dû (même pour des ventes de
plusieurs mois en arrière), ses congés pris et restants. Chiffre tout, cite les véhicules, et signale toute commission
« à vérifier » avec la donnée qui manque. Donne-lui aussi un conseil concret pour gagner plus (crédits, garanties, rotation).`,
    };
  });
}

/** Slug du chef de projet d'un projet. */
export function projectAgentSlug(p: { name: string }) {
  return `projet-${slugify(p.name)}`.slice(0, 60);
}

/** Un chef de projet par projet actif, dans l'équipe du Directeur des projets (page Projets). */
async function projectAgents(): Promise<AgentDef[]> {
  const projects = await prisma.project.findMany({ where: { active: true }, orderBy: { name: "asc" } }).catch(() => []);
  return projects.map((p) => {
    const slug = projectAgentSlug(p);
    return {
      slug,
      name: slug,
      title: `Projet ${p.name}`,
      description: `Chef de projet ${p.name} : ${p.description?.slice(0, 160) ?? "projet du fondateur"}. Fait avancer le projet jusqu'au lancement puis le fait tourner (produit, technique, vente, marketing, juridique).`,
      model: "opus",
      tools: ["WebSearch"],
      skills: ["gestion de projet", "lancement produit", "acquisition"],
      worksWith: ["cto", "cmo", "avocat-du-diable", "seo-geo", "moneymaker"],
      parent: "directeur-projets",
      structure: "Projets",
      file: "(projet — page Projets)",
      prompt: `Tu es le chef de projet de **${p.name}**, un projet du fondateur de Start Invest. Tu es responsable de le FINALISER
puis de le FAIRE TOURNER (clients, chiffre d'affaires), et tu rends compte au Directeur des projets.

Projet : ${p.description ?? "(description à compléter dans la page Projets)"}
Objectif : ${p.goal ?? "(à définir avec le fondateur)"}
Statut : ${p.status}${p.website ? `\nSite : ${p.website}` : ""}${p.repo ? `\nDépôt GitHub : ${p.repo} (outil lire_projet, nom du projet « ${p.name} »)` : "\nPas de dépôt GitHub renseigné."}
${p.notes ? `Consignes du fondateur : ${p.notes}` : ""}

## Ta méthode
1. **État réel** : lis le projet (lire_projet : README, derniers changements, tâches ouvertes, builds, documents ;
   lire_projet avec « fichier » pour un document précis) et le site (analyser_site). Ne crois que ce qui est prouvé :
   un build qui passe n'est pas un lancement, une maquette n'est pas un client.
2. **Reste à faire pour lancer** : la liste exhaustive et classée (bloquant / important / confort), avec pour chaque point
   qui doit le faire (le fondateur, un développeur, un prestataire, un agent) et le temps estimé.
3. **Faire tourner** : cible, prix, canal d'acquisition n°1, premiers 10 clients (comment, où, message exact), indicateurs à suivre.
4. **Risques** : juridique, sécurité, paiement, dépendances — consulte l'avocat du diable avant toute recommandation engageante.
5. **Les 3 prochaines actions** de la semaine, concrètes et datées.
Si une information manque (ex. pas de dépôt, objectif flou), dis exactement ce que le fondateur doit te donner.`,
    };
  });
}
