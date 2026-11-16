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
  // formatToParts : le format français donne « 14 h », que Number() ne sait pas lire (NaN = contrôle jamais lancé).
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date()).find((x) => x.type === "hour")?.value;
  return Number(h ?? 0);
}

const BOOT = new Date();

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const hour = Number(process.env.DAILY_CONTROL_HOUR ?? 7);
    const day = parisDay();
    const done = await prisma.dailyControl.findUnique({ where: { day } });
    // Contrôle du jour pas fait, ou interrompu (redémarrage, erreur) : on le (re)lance, 3 essais maximum par jour.
    const key = `controle-essais:${day}`;
    const tries = Number((await prisma.appSetting.findUnique({ where: { key } }))?.value) || 0;
    if (parisHour() >= hour && (!done || (done.status === "ERROR" && tries < 3))) {
      await prisma.appSetting.upsert({ where: { key }, update: { value: String(tries + 1) }, create: { key, value: String(tries + 1) } });
      await runDailyControl({ force: Boolean(done) });
      lastSync = Date.now();
    } else if (Date.now() - lastSync > 55 * 60 * 1000) {
      await syncAll();
      lastSync = Date.now();
      // Opérations jamais classées (nouvelles ou restées en attente) : l'IA les classe à chaque passage horaire.
      const pending = await prisma.bankTransaction.count({ where: { category: null, account: { excluded: false } } });
      if (pending > 0 && (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) {
        const { aiCategorize } = await import("@/lib/categorization");
        await aiCategorize().catch((e) => console.error("[classement]", (e as Error).message));
      }
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
  // Un contrôle resté « en cours » avant ce démarrage a été coupé par le redémarrage : il sera relancé.
  void prisma.dailyControl
    .updateMany({ where: { status: "RUNNING", startedAt: { lt: BOOT } }, data: { status: "ERROR", log: "Interrompu par un redémarrage du serveur : relancé automatiquement." } })
    .catch(() => undefined);
  lastSync = Date.now(); // première synchro horaire une heure après le démarrage
  setTimeout(tick, 60 * 1000);
  // Au démarrage (nouvelle version en ligne) : les robots en échec réessaient tout de suite, sans attendre leur créneau.
  setTimeout(() => void retryFailedRobots().catch((e) => console.error("[planificateur] robots", e)), 2 * 60 * 1000);
  setTimeout(() => void knownOverdrafts().catch((e) => console.error("[planificateur] découverts", e)), 20 * 1000);
  // Remise à plat demandée par le fondateur (une seule fois par version de la consigne).
  setTimeout(() => void oneShotRedo().catch((e) => console.error("[planificateur] remise à plat", e)), 4 * 60 * 1000);
  // Surveillance toutes les 5 minutes (sans IA) : agents bloqués, contrôle du jour, connexions, données.
  setInterval(() => void import("@/lib/watchdog").then((m) => m.runWatchdog()).catch((e) => console.error("[surveillance]", e)), 5 * 60 * 1000);
  setTimeout(() => void import("@/lib/watchdog").then((m) => m.runWatchdog()).catch(() => undefined), 90 * 1000);
  // Agents en continu, 24 h sur 24 : toutes les minutes, si aucun travail en cours, le plus en retard démarre.
  setInterval(() => void import("@/lib/continuous").then((m) => m.runNextAgentJob()).catch((e) => console.error("[agents en continu]", e)), 60 * 1000);
  setInterval(() => void oneShotRedo().catch((e) => console.error("[planificateur] remise à plat", e)), 30 * 60 * 1000);
  setInterval(tick, 5 * 60 * 1000);
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

// Remises à plat : la clé n'est posée qu'APRÈS réussite, pour reprendre si le serveur redémarre en cours de route.
let redoRunning = false;

async function oneShotRedo() {
  if (redoRunning) return;
  redoRunning = true;
  try {
    const { redoCompany, projectMission } = await import("@/lib/daily-control");
    const { reclassifyCompany } = await import("@/lib/categorization");
    const { agentsConfigured, executeAgent } = await import("@/lib/agent-runtime");
    if (!agentsConfigured()) return;
    // 1. Reclassement complet de chaque société avec son métier (La Fabrique Automobile : + Auto Cerfa + analyse complète).
    const companies = await prisma.company.findMany({ where: { active: true, transactions: { some: {} } } });
    companies.sort((a, b) => (a.name === "La Fabrique Automobile" ? -1 : b.name === "La Fabrique Automobile" ? 1 : 0));
    for (const c of companies) {
      const key = `reclassement:${c.id}:v5`;
      if (await prisma.appSetting.findUnique({ where: { key } })) continue;
      console.log(`[remise à plat] ${c.name} : reclassement complet`);
      try {
        if (c.name === "La Fabrique Automobile") await redoCompany(c.id);
        else await reclassifyCompany(c.id);
        await prisma.appSetting.create({ data: { key, value: new Date().toISOString() } });
      } catch (e) {
        console.error(`[remise à plat] ${c.name} : ${(e as Error).message} (nouvel essai au prochain démarrage)`);
      }
    }
    // 2. Les chefs de projet se mettent au travail tout de suite (une fois), puis chaque matin.
    if (!(await prisma.appSetting.findUnique({ where: { key: "projets-au-travail:v1" } }))) {
      const { ensureDefaultProjects } = await import("@/lib/projects");
      await ensureDefaultProjects();
      const { projectAgentSlug } = await import("@/lib/agents");
      const date = new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "full" });
      for (const p of await prisma.project.findMany({ where: { active: true, website: { not: null } } })) {
        await executeAgent({ slug: projectAgentSlug(p), kind: "DAILY", task: projectMission(p, date) }).catch((e) => console.error("[projets]", p.name, e));
      }
      await prisma.appSetting.create({ data: { key: "projets-au-travail:v1", value: new Date().toISOString() } });
    }
  } finally {
    redoRunning = false;
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
