import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRecapKey } from "@/lib/recap-key";
import { financeSummary } from "@/lib/finance";
import { lastWatchdog } from "@/lib/watchdog";
import { continuousStatus } from "@/lib/continuous";

export const dynamic = "force-dynamic";

/**
 * Récapitulatif en lecture seule pour Claude (deux fois par jour). Aucun secret, aucun IBAN, aucun détail d'opération :
 * seulement l'activité des agents, les grands chiffres par société et l'état de la surveillance.
 */
export async function GET(req: Request) {
  if (!(await checkRecapKey(req.headers.get("authorization")))) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  const hours = Math.min(48, Math.max(1, Number(new URL(req.url).searchParams.get("h")) || 12));
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const [runs, prospects, fin, watch, cont, pending, control] = await Promise.all([
    prisma.agentRun.findMany({ where: { startedAt: { gte: since }, parentId: null }, orderBy: { startedAt: "desc" }, take: 120 }),
    prisma.prospect.groupBy({ by: ["project", "status"], _count: true, where: { updatedAt: { gte: since } } }),
    financeSummary({ days: 30 }),
    lastWatchdog(),
    continuousStatus(),
    prisma.bankTransaction.count({ where: { category: null, account: { excluded: false } } }),
    prisma.dailyControl.findFirst({ orderBy: { startedAt: "desc" }, select: { day: true, status: true, log: true } }),
  ]);
  return NextResponse.json({
    periode: { heures: hours, depuis: since.toISOString() },
    agents: {
      termines: runs.filter((r) => r.status === "DONE").length,
      enEchec: runs.filter((r) => r.status === "ERROR").length,
      enCours: runs.filter((r) => r.status === "RUNNING").length,
      continu: cont,
      travaux: runs.map((r) => ({ agent: r.agent, statut: r.status, debut: r.startedAt.toISOString(), resume: (r.output ?? r.error ?? "").slice(0, 1500) })),
    },
    controleDuMatin: control,
    surveillance: watch,
    operationsAClasser: pending,
    prospects,
    societes30j: fin.companies.map((c) => ({ societe: c.name, solde: Math.round(c.cash), disponibleAvecDecouvert: Math.round(c.available), gagne30j: c.resultKnown ? Math.round(c.net) : null, raisonSiInconnu: c.unknownReason })),
    groupe: { solde: Math.round(fin.total.cash), disponible: Math.round(fin.total.available), gagne30j: Math.round(fin.total.net), resultatsInconnus: fin.total.unknown },
  });
}
