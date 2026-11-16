import { prisma } from "@/lib/prisma";
import { parisDay } from "@/lib/daily-control";
import { needsUserAction, humanError } from "@/lib/human-error";

// Surveillance toutes les 5 minutes, sans IA (donc sans coût) : vérifie que les agents et les robots travaillent,
// répare ce qui est coincé, et liste ce qui ne va pas. Résultat affiché sur la page Aujourd'hui.

export type Surveillance = { at: string; problemes: string[]; actions: string[] };

export async function runWatchdog(): Promise<Surveillance> {
  const now = Date.now();
  const problemes: string[] = [];
  const actions: string[] = [];

  // 1. Agents bloqués (serveur redémarré pendant leur travail, appel jamais revenu) : on les libère.
  const stuck = await prisma.agentRun.findMany({ where: { status: "RUNNING", startedAt: { lt: new Date(now - 40 * 60 * 1000) } }, select: { id: true, agent: true } });
  if (stuck.length) {
    await prisma.agentRun.updateMany({ where: { id: { in: stuck.map((r) => r.id) } }, data: { status: "ERROR", error: "Bloqué plus de 40 minutes : arrêté par la surveillance.", finishedAt: new Date() } });
    actions.push(`${stuck.length} travail(aux) d'agent bloqué(s) arrêté(s) : ${[...new Set(stuck.map((r) => r.agent))].slice(0, 5).join(", ")}`);
  }

  // 2. Contrôle du jour
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date()).find((x) => x.type === "hour")?.value ?? 0);
  const control = await prisma.dailyControl.findUnique({ where: { day: parisDay() } });
  const startHour = Number(process.env.DAILY_CONTROL_HOUR ?? 7);
  if (hour >= startHour + 1) {
    if (!control) problemes.push("Le contrôle du matin n'a pas démarré (relance automatique en cours).");
    else if (control.status === "ERROR") problemes.push("Le contrôle du matin s'est interrompu : relance automatique (3 essais par jour).");
    else if (control.status === "RUNNING" && now - control.startedAt.getTime() > 3 * 3600 * 1000) problemes.push("Le contrôle du matin tourne depuis plus de 3 heures.");
  }
  const lastErrors = await prisma.agentRun.findMany({ where: { status: "ERROR", startedAt: { gte: new Date(now - 24 * 3600 * 1000) }, NOT: { error: { startsWith: "Bloqué" } } }, select: { agent: true, error: true }, take: 50 });
  if (lastErrors.length >= 3) problemes.push(`${lastErrors.length} travaux d'agents en échec sur 24 h (dernier : ${lastErrors[0].agent} — ${(lastErrors[0].error ?? "").slice(0, 120)}).`);

  // 2 ter. Crédit IA épuisé : tout est à l'arrêt, c'est le problème n°1.
  const credit = await prisma.appSetting.findUnique({ where: { key: "ia-credit-epuise" } });
  const lastCreditError = await prisma.agentRun.findFirst({ where: { status: "ERROR", error: { contains: "credit balance" } }, orderBy: { startedAt: "desc" }, select: { startedAt: true } });
  const okSince = lastCreditError ? await prisma.agentRun.count({ where: { status: "DONE", startedAt: { gt: lastCreditError.startedAt } } }) : 1;
  if (credit || (lastCreditError && okSince === 0 && now - lastCreditError.startedAt.getTime() < 24 * 3600 * 1000))
    problemes.unshift("🔴 CRÉDIT IA ÉPUISÉ : tous les agents sont à l'arrêt. Rechargez sur console.anthropic.com → Plans & Billing. Le travail reprend tout seul dans les 15 minutes qui suivent.");

  // 2 quater. Budget IA
  {
    const { aiSpendStatus } = await import("@/lib/ai-cost");
    const st = await aiSpendStatus();
    if (st.month >= st.budget) problemes.unshift(`Budget IA du mois atteint (${st.month.toFixed(0)} € sur ${st.budget} €) : travail automatique en pause jusqu'au 1er. Pour l'augmenter : variable AI_MONTHLY_BUDGET_EUR dans Railway.`);
    else if (st.today >= st.dailyBudget) problemes.push(`Budget IA du jour atteint (${st.today.toFixed(2)} € sur ${st.dailyBudget.toFixed(2)} €) : la rotation reprend demain.`);
  }

  // 2 bis. Agents en continu : le travail ne doit jamais s'arrêter (sauf plafond journalier atteint).
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    const { continuousStatus } = await import("@/lib/continuous");
    const c = await continuousStatus();
    const lastAt = c.last?.finishedAt?.getTime() ?? 0;
    if (c.today >= c.max) problemes.push(`Plafond de ${c.max} travaux d'agents atteint aujourd'hui (variable AGENTS_MAX_RUNS_PER_DAY) : reprise à minuit.`);
    else if (!c.running && lastAt && now - lastAt > 30 * 60 * 1000) problemes.push("Aucun agent n'a travaillé depuis plus de 30 minutes : redémarrage de la rotation.");
  }

  // 3. Connexions en panne qui demandent une action
  const broken = await prisma.integration.findMany({ where: { status: "ERROR" }, include: { company: { select: { name: true } } } });
  for (const i of broken.filter((b) => needsUserAction(b.lastError))) problemes.push(`${i.label ?? i.provider} (${i.company.name}) : ${humanError(i.lastError)}`);

  // 4. Qualité des données
  const pending = await prisma.bankTransaction.count({ where: { category: null, account: { excluded: false } } });
  if (pending > 0) problemes.push(`${pending} opération(s) bancaire(s) pas encore classée(s) : classement automatique chaque heure.`);
  const lfa = await prisma.company.findFirst({ where: { name: "La Fabrique Automobile" } });
  if (lfa) {
    const v = await prisma.vehicle.findMany({ where: { companyId: lfa.id }, select: { mode: true, purchasePrice: true, status: true } });
    const noPrice = v.filter((x) => x.mode === "ACHAT" && !x.purchasePrice).length;
    if (noPrice) problemes.push(`La Fabrique Automobile : ${noPrice} véhicule(s) sans prix d'achat dans Auto Cerfa.`);
    if (!v.some((x) => x.status === "VENDU")) problemes.push("La Fabrique Automobile : aucune vente importée d'Auto Cerfa (livre de police à lire).");
  }

  const result = { at: new Date().toISOString(), problemes, actions };
  await prisma.appSetting.upsert({ where: { key: "surveillance" }, update: { value: JSON.stringify(result) }, create: { key: "surveillance", value: JSON.stringify(result) } });
  if (actions.length) console.log(`[surveillance] ${actions.join(" · ")}`);
  return result;
}

export async function lastWatchdog(): Promise<Surveillance | null> {
  const s = await prisma.appSetting.findUnique({ where: { key: "surveillance" } });
  return s ? (JSON.parse(s.value) as Surveillance) : null;
}
