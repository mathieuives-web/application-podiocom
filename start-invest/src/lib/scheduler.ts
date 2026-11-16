import { parisDay, runDailyControl } from "@/lib/daily-control";
import { syncAll } from "@/lib/connectors";
import { prisma } from "@/lib/prisma";

// Planificateur intégré (serveur Node toujours allumé : Docker, Railway, VPS) :
// - synchronisation des banques et logiciels toutes les heures ;
// - contrôle quotidien des DAF + revue du CFO chaque matin à DAILY_CONTROL_HOUR (heure de Paris, défaut 7 h).
// Désactivable avec SCHEDULER=off (par ex. si vous utilisez un cron externe sur /api/cron/*).

let started = false;
let busy = false;
let lastSync = 0;

function parisHour() {
  return Number(new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const hour = Number(process.env.DAILY_CONTROL_HOUR ?? 7);
    const done = await prisma.dailyControl.findUnique({ where: { day: parisDay() } });
    if (!done && parisHour() >= hour) {
      await runDailyControl();
      lastSync = Date.now();
    } else if (Date.now() - lastSync > 55 * 60 * 1000) {
      await syncAll();
      lastSync = Date.now();
    }
  } catch (e) {
    console.error("[planificateur]", e);
  } finally {
    busy = false;
  }
}

export function startScheduler() {
  if (started || process.env.SCHEDULER === "off") return;
  started = true;
  lastSync = Date.now(); // première synchro horaire une heure après le démarrage
  setTimeout(tick, 60 * 1000);
  // Au démarrage (nouvelle version en ligne) : les robots en échec réessaient tout de suite, sans attendre leur créneau.
  setTimeout(() => void retryFailedRobots().catch((e) => console.error("[planificateur] robots", e)), 2 * 60 * 1000);
  setTimeout(() => void knownOverdrafts().catch((e) => console.error("[planificateur] découverts", e)), 20 * 1000);
  // Remise à plat demandée par le fondateur (une seule fois par version de la consigne).
  setTimeout(() => void oneShotRedo().catch((e) => console.error("[planificateur] remise à plat", e)), 4 * 60 * 1000);
  setInterval(tick, 10 * 60 * 1000);
  console.log("[planificateur] actif : synchro horaire + contrôle quotidien");
}

async function retryFailedRobots() {
  const { syncIntegration } = await import("@/lib/connectors");
  const failed = await prisma.integration.findMany({ where: { provider: { in: ["GTAPRO", "AUTOCERFA"] }, status: { in: ["ERROR", "PENDING"] } } });
  for (const i of failed) {
    console.log(`[planificateur] nouvel essai du robot ${i.provider} (${i.companyId})`);
    await syncIntegration(i.id, { force: true }).catch(() => undefined);
  }
}

const REDO = [{ key: "redo:la-fabrique-automobile:v1", company: "La Fabrique Automobile" }];

async function oneShotRedo() {
  const { redoCompany, projectMission } = await import("@/lib/daily-control");
  // Demande du fondateur : les chefs de projet se mettent au travail tout de suite (une fois), puis chaque matin.
  if (!(await prisma.appSetting.findUnique({ where: { key: "projets-au-travail:v1" } }))) {
    await prisma.appSetting.create({ data: { key: "projets-au-travail:v1", value: new Date().toISOString() } });
    const { ensureDefaultProjects } = await import("@/lib/projects");
    await ensureDefaultProjects();
    const { projectAgentSlug } = await import("@/lib/agents");
    const { executeAgent, agentsConfigured } = await import("@/lib/agent-runtime");
    if (agentsConfigured()) {
      const date = new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "full" });
      for (const p of await prisma.project.findMany({ where: { active: true, website: { not: null } } })) {
        await executeAgent({ slug: projectAgentSlug(p), kind: "DAILY", task: projectMission(p, date) }).catch((e) => console.error("[projets]", p.name, e));
      }
    }
  }
  for (const r of REDO) {
    if (await prisma.appSetting.findUnique({ where: { key: r.key } })) continue;
    await prisma.appSetting.create({ data: { key: r.key, value: new Date().toISOString() } });
    const c = await prisma.company.findFirst({ where: { name: r.company } });
    if (c) await redoCompany(c.id);
  }
}

// Découverts autorisés communiqués par le fondateur (la banque ne les transmet pas) : posés une fois, jamais écrasés.
const OVERDRAFTS = [{ company: "La Fabrique Automobile", accountEnd: "4086", limit: 250000, note: "Découvert autorisé garanti par Auxiga (prêteur sur gage, stock de véhicules)" }];

async function knownOverdrafts() {
  for (const o of OVERDRAFTS) {
    const c = await prisma.company.findFirst({ where: { name: o.company } });
    if (!c) continue;
    const accounts = await prisma.bankAccount.findMany({ where: { companyId: c.id } });
    const digits = (x: string | null) => (x ?? "").replace(/\D/g, "");
    const match = accounts.filter((a) => digits(a.iban).endsWith(o.accountEnd) || a.name.includes(o.accountEnd) || (a.externalId ?? "").includes(o.accountEnd));
    if (match.length !== 1) {
      console.log(`[découverts] ${o.company} : compte …${o.accountEnd} ${match.length ? "ambigu" : "introuvable"} (${accounts.map((a) => a.name).join(", ")})`);
      continue;
    }
    const a = match[0];
    if (a.overdraftLimit > 0) continue;
    await prisma.bankAccount.update({ where: { id: a.id }, data: { overdraftLimit: o.limit, financingNote: a.financingNote ?? o.note } });
    console.log(`[découverts] ${o.company} : découvert de ${o.limit} € posé sur ${a.name}`);
  }
}
