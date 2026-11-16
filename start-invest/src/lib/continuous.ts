import { prisma } from "@/lib/prisma";
import { loadAgents } from "@/lib/agents";
import { agentsConfigured, executeAgent } from "@/lib/agent-runtime";

// Règle du fondateur : les agents ne s'arrêtent jamais. Rotation permanente, 24 h sur 24 : dès qu'un travail est fini,
// l'agent dont la tâche est la plus en retard prend le relais (un seul à la fois, pour garder des chiffres cohérents).
// Plafond de sécurité : AGENTS_MAX_RUNS_PER_DAY (défaut 200 travaux par jour) pour éviter une facture IA incontrôlée.

type Job = { key: string; slug: string; everyHours: number; companyId?: string; task: string; daytime?: boolean; model?: "opus" | "haiku" };

let busy = false;

export async function jobs(): Promise<Job[]> {
  const agents = await loadAgents();
  const has = (slug: string) => agents.some((a) => a.slug === slug);
  const companies = await prisma.company.findMany({ where: { active: true } });
  const mailCompanies = new Set((await prisma.integration.findMany({ where: { provider: { in: ["GOOGLE", "OUTLOOK", "IMAP"] }, status: { not: "ERROR" } }, select: { companyId: true } })).map((i) => i.companyId));
  const list: Job[] = [];
  for (const c of companies) {
    const comptable = agents.find((a) => a.slug.startsWith("comptable-") && a.structure === c.name);
    if (comptable)
      list.push({
        key: `comptable:${c.id}`,
        slug: comptable.slug,
        everyHours: 3,
        companyId: c.id,
        task: `Travail comptable en continu pour ${c.name} (société="${c.name}"). 0) Lis les bilans (lire_bilans) et les documents archivés : ils disent à quoi correspondent les dépenses et les rentrées (emprunts et leur échéance, loyers, assurances, achats de stock, salaires) ; compare chaque poste du bilan avec ce que montre la banque. 1) resultats_societe : opérations non classées, part des « Autres dépenses / Autres entrées ». 2) lister_transactions sur les plus gros montants en « Autres » et dis pour chacune la bonne catégorie et pourquoi (fournisseur reconnu, véhicule, loyer...). 3) Repère toute anomalie (doublon, montant inhabituel, abonnement nouveau, frais bancaires). N'invente rien ; cite les opérations. Mets à jour ta mémoire.`,
      });
    const daf = agents.find((a) => a.slug.startsWith("daf-") && a.structure === c.name);
    if (daf)
      list.push({
        key: `daf:${c.id}`,
        slug: daf.slug,
        everyHours: 4,
        companyId: c.id,
        task: `Point de situation de ${c.name} (société="${c.name}") : resultats_societe puis 5 lignes maximum — ce que la société gagne, la trésorerie disponible (avec le découvert autorisé), ce qui a changé depuis ton dernier point, le risque n°1 et l'action n°1. Applique la règle de fiabilité : pas de conclusion si le classement n'est pas terminé. Pour le négoce auto, un achat de véhicule est du stock, pas une perte.`,
      });
    if (mailCompanies.has(c.id))
      for (const a of agents.filter((x) => (x.slug.startsWith("courrier-") || x.slug.startsWith("secretariat-")) && x.structure === c.name))
        list.push({ key: `mail:${a.slug}`, slug: a.slug, everyHours: 2, companyId: c.id, task: `Relève du courrier pour ${c.name} : suis ta procédure (nouveaux mails, factures à enregistrer, demandes clients, urgences), puis fais ton rapport.` });
    const chef = agents.find((a) => a.slug.startsWith("planning-atelier-") && a.structure === c.name);
    if (chef) list.push({ key: `atelier:${c.id}`, slug: chef.slug, everyHours: 2, companyId: c.id, daytime: true, task: `Point atelier de ${c.name} : rendez-vous du jour et de demain, retards, interventions déclarées, rentabilité des mécaniciens ; 5 lignes et l'action n°1.` });
  }
  const { projectAgentSlug } = await import("@/lib/agents");
  const { projectMission } = await import("@/lib/daily-control");
  const date = new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "full" });
  for (const p of await prisma.project.findMany({ where: { active: true } }))
    list.push({ key: `projet:${p.id}`, slug: projectAgentSlug(p), everyHours: p.website ? 12 : 24, task: projectMission(p, date) });
  if (has("cfo")) list.push({ key: "cfo", slug: "cfo", everyHours: 24, model: "opus", task: "Synthèse du groupe : resultats_societe sans société, tableau société / gagné / disponible / indicateur clé, puis ce qui a changé et les 3 décisions à prendre par le fondateur. Règle de fiabilité : pas de conclusion sur des chiffres pas encore classés." });
  if (has("avocat-du-diable")) {
    const recent = await prisma.agentRun.findMany({ where: { status: "DONE", parentId: null, agent: { not: "avocat-du-diable" }, startedAt: { gte: new Date(Date.now() - 6 * 3600 * 1000) } }, orderBy: { startedAt: "desc" }, take: 12 });
    if (recent.length)
      list.push({
        key: "avocat",
        slug: "avocat-du-diable",
        everyHours: 24,
        model: "opus",
        task: `Contre-contrôle en continu. Vérifie avec tes outils chaque chiffre et chaque conclusion des rapports ci-dessous ; corrige les agents qui se trompent (corriger_agent).\n\n${recent.map((r) => `### ${r.agent} — ${r.startedAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}\n${(r.output ?? "").slice(0, 6000)}`).join("\n\n")}`.slice(0, 120000),
      });
  }
  return list;
}

/** Lance le prochain travail d'agent le plus en retard (appelé toutes les minutes ; un seul à la fois). */
export async function runNextAgentJob() {
  if (busy || !agentsConfigured()) return null;
  busy = true;
  try {
    const dayStart = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date()) + "T00:00:00");
    const max = Number(process.env.AGENTS_MAX_RUNS_PER_DAY ?? 200);
    const today = await prisma.agentRun.count({ where: { kind: "CONTINU", startedAt: { gte: dayStart } } });
    if (today >= max) return null;
    // Crédit IA épuisé : inutile d'enchaîner des échecs. On reteste toutes les 15 minutes pour repartir dès la recharge.
    const credit = await prisma.appSetting.findUnique({ where: { key: "ia-credit-epuise" } });
    if (credit && Date.now() - Number(credit.value) < 15 * 60 * 1000) return null;
    // Budget IA du fondateur (AI_MONTHLY_BUDGET_EUR) : la rotation s'arrête à 85 % du budget du jour
    // (le reste est gardé pour le contrôle du matin, les robots et ses propres demandes) et reprend le lendemain.
    const { canSpendAutomatic } = await import("@/lib/ai-cost");
    if (!(await canSpendAutomatic(0.85))) return null;
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date()).find((x) => x.type === "hour")?.value ?? 12);
    const list = (await jobs()).filter((j) => !j.daytime || (hour >= 7 && hour < 20));
    const stamps = new Map((await prisma.appSetting.findMany({ where: { key: { startsWith: "continu:" } } })).map((s) => [s.key, Number(s.value) || 0]));
    const due = list
      .map((j) => ({ j, late: Date.now() - (stamps.get(`continu:${j.key}`) ?? 0) - j.everyHours * 3600 * 1000 }))
      .filter((x) => x.late >= 0)
      .sort((a, b) => b.late - a.late)[0];
    if (!due) return null;
    const key = `continu:${due.j.key}`;
    await prisma.appSetting.upsert({ where: { key }, update: { value: String(Date.now()) }, create: { key, value: String(Date.now()) } });
    console.log(`[agents en continu] ${due.j.slug}`);
    try {
      await executeAgent({ slug: due.j.slug, kind: "CONTINU", companyId: due.j.companyId ?? null, task: due.j.task, model: due.j.model ?? "haiku" });
      await prisma.appSetting.deleteMany({ where: { key: "ia-credit-epuise" } });
    } catch (e) {
      const msg = (e as Error).message;
      console.error("[agents en continu]", due.j.slug, msg.slice(0, 200));
      if (/credit balance is too low|purchase credits/i.test(msg)) {
        // Pas un vrai passage : la tâche sera refaite dès que le crédit revient.
        await prisma.appSetting.deleteMany({ where: { key } });
        await prisma.appSetting.upsert({ where: { key: "ia-credit-epuise" }, update: { value: String(Date.now()) }, create: { key: "ia-credit-epuise", value: String(Date.now()) } });
      }
    }
    return due.j.slug;
  } finally {
    busy = false;
  }
}

export async function continuousStatus() {
  const dayStart = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date()) + "T00:00:00");
  const [today, running, last] = await Promise.all([
    prisma.agentRun.count({ where: { kind: "CONTINU", startedAt: { gte: dayStart } } }),
    prisma.agentRun.findFirst({ where: { status: "RUNNING" }, orderBy: { startedAt: "desc" }, select: { agent: true, startedAt: true } }),
    prisma.agentRun.findFirst({ where: { kind: "CONTINU", status: "DONE" }, orderBy: { startedAt: "desc" }, select: { agent: true, finishedAt: true } }),
  ]);
  return { today, max: Number(process.env.AGENTS_MAX_RUNS_PER_DAY ?? 200), running, last };
}
