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
  const { redoCompany } = await import("@/lib/daily-control");
  for (const r of REDO) {
    if (await prisma.appSetting.findUnique({ where: { key: r.key } })) continue;
    await prisma.appSetting.create({ data: { key: r.key, value: new Date().toISOString() } });
    const c = await prisma.company.findFirst({ where: { name: r.company } });
    if (c) await redoCompany(c.id);
  }
}
