import { prisma } from "@/lib/prisma";
import { loadAgents } from "@/lib/agents";
import { agentsConfigured, executeAgent } from "@/lib/agent-runtime";
import { syncAll } from "@/lib/connectors";
import { autoReconcile } from "@/lib/finance";
import { runReminders } from "@/lib/reminders";

// Contrôle quotidien : synchronise banques et facturation, rapproche, envoie les relances,
// fait travailler le DAF de chaque société, puis le CFO contrôle tous les rapports.

export function parisDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(date); // AAAA-MM-JJ
}

export async function runDailyControl(opts: { force?: boolean } = {}) {
  const day = parisDay();
  const existing = await prisma.dailyControl.findUnique({ where: { day } });
  if (existing && !opts.force) return existing;
  if (existing?.status === "RUNNING") return existing;
  const control = existing
    ? await prisma.dailyControl.update({ where: { id: existing.id }, data: { status: "RUNNING", startedAt: new Date(), finishedAt: null, log: null } })
    : await prisma.dailyControl.create({ data: { day } });

  const log: string[] = [];
  try {
    const sync = await syncAll();
    log.push(`Synchro : ${sync.filter((s) => s.ok).length}/${sync.length} connexion(s) OK`);
    for (const s of sync.filter((x) => !x.ok)) log.push(`  ⚠ ${s.error}`);
    log.push(`Rapprochement : ${await autoReconcile()} opération(s) reliée(s) à une facture`);
    const rem = await runReminders();
    log.push(`Relances : ${rem.created} créée(s), ${rem.sent} envoyée(s) par e-mail`);

    if (!agentsConfigured()) {
      log.push("Agents IA non activés (ANTHROPIC_API_KEY manquante) : pas de rapport des DAF.");
    } else {
      const agents = await loadAgents();
      const companies = await prisma.company.findMany({ where: { active: true } });
      const date = new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "full" });
      const reports: string[] = [];
      for (const c of companies) {
        const daf = agents.find((a) => a.slug.startsWith("daf-") && a.structure === c.name);
        if (!daf) continue;
        try {
          const r = await executeAgent({
            slug: daf.slug,
            kind: "DAILY",
            companyId: c.id,
            task: `Contrôle quotidien du ${date} pour ${c.name}. Rédige ton rapport du jour en suivant exactement ta procédure (verdict en première ligne).`,
          });
          reports.push(`### ${daf.title} (${c.name})\n${r.output}`);
        } catch (e) {
          reports.push(`### ${daf.title} (${c.name})\n⚠ Rapport impossible : ${(e as Error).message}`);
        }
      }
      log.push(`Rapports DAF : ${reports.length}`);
      if (reports.length) {
        await executeAgent({
          slug: "cfo",
          kind: "DAILY",
          task: `Revue quotidienne du ${date}. Voici les rapports de tes directeurs financiers. Contrôle-les (vérifie leurs chiffres avec tes outils), donne le verdict du groupe, dis ce que chaque DAF a raté ou doit corriger, et fais remonter au fondateur les 3 sujets qui demandent une décision.\n\n${reports.join("\n\n")}`,
        });
        log.push("Revue du CFO : faite");
      }
    }
    return prisma.dailyControl.update({ where: { id: control.id }, data: { status: "DONE", log: log.join("\n"), finishedAt: new Date() } });
  } catch (e) {
    log.push(`Erreur : ${(e as Error).message}`);
    return prisma.dailyControl.update({ where: { id: control.id }, data: { status: "ERROR", log: log.join("\n"), finishedAt: new Date() } });
  }
}
