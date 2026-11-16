import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { loadAgents } from "@/lib/agents";
import { lastWatchdog } from "@/lib/watchdog";

export const dynamic = "force-dynamic";

const sinceHours = (h: number) => new Date(Date.now() - h * 3600 * 1000);
const time = (d: Date) => d.toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Récapitulatif de tout ce que les agents ont fait sur les dernières heures. */
export default async function RecapPage({ searchParams }: { searchParams: Promise<{ h?: string }> }) {
  await requireUser();
  const hours = Math.min(72, Math.max(1, Number((await searchParams).h) || 5));
  const since = sinceHours(hours);
  const [runs, prospects, agents, watch, control, classified] = await Promise.all([
    prisma.agentRun.findMany({ where: { startedAt: { gte: since }, parentId: null }, orderBy: { startedAt: "desc" }, take: 300 }),
    prisma.prospect.findMany({ where: { createdAt: { gte: since } }, select: { project: true } }),
    loadAgents(),
    lastWatchdog(),
    prisma.dailyControl.findMany({ where: { startedAt: { gte: since } }, orderBy: { startedAt: "desc" } }),
    prisma.bankTransaction.count({ where: { category: null, account: { excluded: false } } }),
  ]);
  const title = (slug: string) => agents.find((a) => a.slug === slug)?.title ?? slug;
  const done = runs.filter((r) => r.status === "DONE");
  const failed = runs.filter((r) => r.status === "ERROR");
  const running = runs.filter((r) => r.status === "RUNNING");
  const byProject = prospects.reduce<Record<string, number>>((m, p) => ({ ...m, [p.project]: (m[p.project] ?? 0) + 1 }), {});

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h1 className="text-xl font-bold">Récapitulatif des {hours} dernières heures</h1>
        <p className="text-sm text-slate-500">
          Tout ce que vos agents ont fait depuis le {time(since)}.{" "}
          {[5, 12, 24].map((h) => <Link key={h} href={`/recap?h=${h}`} className={`underline mr-2 ${h === hours ? "font-semibold" : ""}`}>{h} h</Link>)}
        </p>
      </div>

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="card"><p className="text-xs text-slate-500">Travaux terminés</p><p className="text-2xl font-bold text-emerald-700">{done.length}</p></div>
        <div className="card"><p className="text-xs text-slate-500">En cours</p><p className="text-2xl font-bold">{running.length}</p></div>
        <div className="card"><p className="text-xs text-slate-500">En échec</p><p className={`text-2xl font-bold ${failed.length ? "text-red-700" : ""}`}>{failed.length}</p></div>
        <div className="card"><p className="text-xs text-slate-500">Prospects trouvés</p><p className="text-2xl font-bold">{prospects.length}</p><p className="text-xs text-slate-500">{Object.entries(byProject).map(([k, v]) => `${k} : ${v}`).join(" · ")}</p></div>
      </section>

      <section className="card text-sm space-y-1">
        <p>Contrôle du matin : {control.length ? control.map((c) => `${time(c.startedAt)} → ${c.status === "DONE" ? "terminé ✅" : c.status === "RUNNING" ? "en cours" : "interrompu, relancé automatiquement"}`).join(" · ") : "pas sur cette période"}</p>
        <p>Opérations bancaires encore à classer : <strong>{classified}</strong></p>
        {watch && <p>Surveillance (vérifiée à {new Date(watch.at).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" })}) : {watch.problemes.length ? `${watch.problemes.length} point(s) à suivre` : "tout tourne ✅"}</p>}
      </section>

      {!runs.length && (
        <p className="card text-sm bg-amber-50 border-amber-200 text-amber-900">
          Aucun travail d&apos;agent sur cette période. Si la nouvelle version vient d&apos;être mise en ligne, la rotation démarre dans quelques minutes ;
          sinon, vérifiez la clé IA (Mise en route) et l&apos;encadré Surveillance de la page Aujourd&apos;hui.
        </p>
      )}

      <section className="space-y-2">
        {runs.map((r) => {
          const lines = (r.output ?? r.error ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
          return (
            <details key={r.id} className={`card text-sm ${r.status === "ERROR" ? "border-red-200" : ""}`}>
              <summary className="cursor-pointer">
                <span className="text-xs text-slate-500 mr-2">{time(r.startedAt)}</span>
                <strong>{title(r.agent)}</strong>
                <span className={`text-xs ml-2 ${r.status === "DONE" ? "text-emerald-700" : r.status === "ERROR" ? "text-red-700" : "text-slate-500"}`}>
                  {r.status === "DONE" ? "✅ terminé" : r.status === "ERROR" ? "❌ échec" : "⏳ en cours"}
                </span>
                {lines[0] && <span className="block text-xs text-slate-600 mt-0.5">{lines.slice(0, 2).join(" — ").replace(/[#*]/g, "").slice(0, 220)}</span>}
              </summary>
              <div className="whitespace-pre-wrap text-slate-700 mt-2 max-h-[28rem] overflow-y-auto text-xs">{r.output ?? r.error ?? ""}</div>
            </details>
          );
        })}
      </section>
    </div>
  );
}
