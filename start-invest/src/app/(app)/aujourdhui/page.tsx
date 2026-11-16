import { humanError, needsUserAction } from "@/lib/human-error";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { isAdmin, requireUser } from "@/lib/session";
import { eur, financeSummary } from "@/lib/finance";
import { lastWatchdog } from "@/lib/watchdog";
import { continuousStatus } from "@/lib/continuous";
import { commissionStatement, previousMonth } from "@/lib/team";
import { runControlNow, runDevilsAdvocateNow } from "../finances/actions";

export const dynamic = "force-dynamic";

const time = (d: Date) => d.toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" });

function Alert({ tone, href, children }: { tone: "red" | "amber" | "sky"; href: string; children: React.ReactNode }) {
  const c = tone === "red" ? "bg-red-50 border-red-200 text-red-900" : tone === "amber" ? "bg-amber-50 border-amber-200 text-amber-900" : "bg-sky-50 border-sky-200 text-sky-900";
  return <Link href={href} className={`block rounded-xl border px-4 py-3 text-sm ${c}`}>{children} <span className="float-right">›</span></Link>;
}

/** Vue téléphone : tout ce qui demande votre attention aujourd'hui, en un coup d'œil. */
export default async function AujourdhuiPage() {
  const me = await requireUser();
  const admin = isAdmin(me.role);
  const today0 = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date()) + "T00:00:00");
  const [fin, control, cfo, avocat, drafts, terrain, broken, rdv, ari] = await Promise.all([
    financeSummary({ days: 30 }),
    prisma.dailyControl.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.agentRun.findFirst({ where: { agent: "cfo", status: "DONE" }, orderBy: { startedAt: "desc" } }),
    prisma.agentRun.findFirst({ where: { agent: "avocat-du-diable", status: "DONE" }, orderBy: { startedAt: "desc" } }),
    prisma.robotTask.count({ where: { status: { in: ["BROUILLON", "ERREUR"] } } }),
    prisma.fieldRequest.findMany({ where: { status: "NOUVEAU" }, select: { urgent: true } }),
    prisma.integration.findMany({ where: { status: "ERROR" }, include: { company: { select: { name: true } } } }),
    prisma.appointment.findMany({ where: { start: { gte: new Date(today0.getTime() - 3 * 3600000), lt: new Date(today0.getTime() + 27 * 3600000) }, status: { notIn: ["ANNULE"] } }, orderBy: { start: "asc" } }),
    prisma.company.findFirst({ where: { name: "Auto Rac Ives" }, include: { employees: true } }),
  ]);
  const t = fin.total;
  const [watch, cont] = await Promise.all([lastWatchdog(), continuousStatus()]);
  const tight = [
    ...fin.companies.filter((c) => c.overdraftLimit > 0 && c.available < 0).map((c) => `${c.name} : découvert autorisé DÉPASSÉ de ${eur(-c.available)}`),
    ...fin.companies.flatMap((c) => c.financing.filter((f) => (f.tauxUtilisation ?? 0) >= 80 && (f.tauxUtilisation ?? 0) <= 100).map((f) => `${c.name} : découvert utilisé à ${f.tauxUtilisation} % (reste ${eur(f.decouvertAutorise - f.decouvertUtilise)})`)),
  ];
  const day = Number(new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "numeric" }).format(new Date()));
  const commissions = admin && day <= 10 ? (await commissionStatement(previousMonth())).reduce((s, e) => s + e.aVerser, 0) : 0;
  const urgent = terrain.filter((x) => x.urgent).length;
  const name = (id: string | null) => ari?.employees.find((e) => e.id === id)?.firstName ?? "à affecter";

  return (
    <div className="space-y-5 max-w-xl">
      <div>
        <p className="text-xs text-slate-500">{new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long" })}</p>
        <h1 className="text-2xl font-bold">Aujourd&apos;hui</h1>
      </div>

      <section className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-stone-950 text-white p-4">
          {t.overdraftLimit > 0 ? (
            <>
              <p className="text-xs text-stone-400">Disponible (avec découverts autorisés)</p>
              <p className={`text-2xl font-bold ${t.available < 0 ? "text-red-400" : ""}`}>{eur(t.available)}</p>
              <p className="text-xs text-stone-400">solde des comptes {eur(t.cash)} · découverts autorisés {eur(t.overdraftLimit)}</p>
            </>
          ) : (
            <>
              <p className="text-xs text-stone-400">Trésorerie du groupe</p>
              <p className="text-2xl font-bold">{eur(t.cash)}</p>
            </>
          )}
        </div>
        <div className="rounded-xl bg-white border p-4">
          <p className="text-xs text-slate-500">Gagné sur 30 jours</p>
          <p className={`text-2xl font-bold ${t.net >= 0 ? "text-emerald-700" : "text-red-700"}`}>{eur(t.net)}</p>
          <p className="text-xs text-slate-500">
            entrées {eur(t.inflow)}
            {t.stockBuys > 0 ? ` · ${eur(t.stockBuys)} de véhicules achetés pour le stock (pas une perte : comptés à la vente)` : ""}
            {t.unknown.length > 0 && <span className="block text-amber-700">sans {t.unknown.join(", ")} : résultat à calculer (voir ci-dessous)</span>}
          </p>
        </div>
      </section>

      <section className={`rounded-xl border p-3 text-sm ${!watch ? "bg-slate-50" : watch.problemes.length ? "bg-amber-50 border-amber-200" : "bg-emerald-50 border-emerald-200"}`}>
        <p className="font-medium">
          Surveillance des agents (toutes les 5 min) :{" "}
          {watch ? `${watch.problemes.length ? `${watch.problemes.length} point(s) à suivre` : "tout tourne ✅"} · vérifié à ${new Date(watch.at).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" })}` : "première vérification dans quelques minutes"}
        </p>
        <p className="text-xs mt-0.5">
          Agents en continu, 24 h/24 : {cont.running ? <>en ce moment <strong>{cont.running.agent}</strong></> : "entre deux travaux"} · {cont.today} travail(aux) aujourd&apos;hui (plafond {cont.max})
          {cont.last?.finishedAt ? ` · dernier fini à ${cont.last.finishedAt.toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" })} (${cont.last.agent})` : ""}
        </p>
        {watch && watch.problemes.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs space-y-0.5">{watch.problemes.slice(0, 8).map((p) => <li key={p}>{p}</li>)}</ul>}
        {watch && watch.actions.length > 0 && <p className="mt-1 text-xs text-slate-600">Réparé automatiquement : {watch.actions.join(" · ")}</p>}
      </section>

      <section className="space-y-2">
        {broken.filter((i) => needsUserAction(i.lastError)).map((i) => <Alert key={i.id} tone="red" href="/connexions">{i.label ?? i.provider} ({i.company.name}) : {humanError(i.lastError)}</Alert>)}
        {tight.map((x) => <Alert key={x} tone="red" href="/finances">{x}</Alert>)}
        {t.receivablesLate > 0 && <Alert tone="amber" href="/finances">Factures clients en retard : {eur(t.receivablesLate)}</Alert>}
        {drafts > 0 && admin && <Alert tone="amber" href="/atelier">{drafts} devis / OR à valider ou en erreur</Alert>}
        {terrain.length > 0 && <Alert tone={urgent ? "red" : "sky"} href="/terrain">{terrain.length} message(s) WhatsApp à traiter{urgent ? `, dont ${urgent} urgent(s)` : ""}</Alert>}
        {commissions > 0 && <Alert tone="sky" href="/equipe">Commissions à verser ({previousMonth()}) : {eur(commissions)}</Alert>}
        {!broken.filter((i) => needsUserAction(i.lastError)).length && !tight.length && !t.receivablesLate && !drafts && !terrain.length && <p className="text-sm text-emerald-700">✅ Rien d&apos;urgent pour l&apos;instant.</p>}
      </section>

      <section className="rounded-xl bg-white border p-4 space-y-2">
        <div className="flex justify-between items-baseline">
          <h2 className="font-semibold">Le mot du CFO</h2>
          {control && <span className="text-xs text-slate-500">contrôle {control.status === "DONE" ? "fait" : control.status === "RUNNING" ? "en cours" : "en erreur"} · {time(control.startedAt)}</span>}
        </div>
        <p className="text-sm text-slate-700 whitespace-pre-wrap line-clamp-[10]">{cfo?.output?.slice(0, 900) ?? "Pas encore de revue : elle arrive chaque matin vers 7 h."}</p>
        {cfo && <Link href="/agents?agent=cfo" className="text-xs underline">lire en entier</Link>}
        {avocat?.output && (
          <details className="text-sm">
            <summary className="cursor-pointer text-xs underline">Avocat du diable ({time(avocat.startedAt)})</summary>
            <p className="whitespace-pre-wrap text-slate-700 mt-1">{avocat.output.slice(0, 1500)}</p>
          </details>
        )}
      </section>

      {rdv.length > 0 && (
        <section className="rounded-xl bg-white border p-4">
          <h2 className="font-semibold mb-2">Atelier aujourd&apos;hui</h2>
          <ul className="text-sm divide-y">
            {rdv.map((r) => (
              <li key={r.id} className="py-1.5 flex justify-between gap-2">
                <span>{r.start.toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" })} · {r.work} · {r.vehicle ?? r.client}</span>
                <span className="text-xs text-slate-500 shrink-0">{name(r.employeeId)} · {r.status.toLowerCase()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-xl bg-white border p-4">
        <h2 className="font-semibold mb-2">Par société (30 jours)</h2>
        <ul className="text-sm divide-y">
          {fin.companies.map((c) => (
            <li key={c.id} className="py-1.5 flex justify-between gap-2">
              <span>
                {c.name}
                {c.overdraftLimit > 0 && <span className="block text-xs text-slate-500">découvert autorisé {eur(c.overdraftLimit)} · reste {eur(c.available)}</span>}
              </span>
              <span className="text-right">
                <b className={c.available < 0 ? "text-red-700" : ""}>{eur(c.cash)}</b>{" "}
                {c.resultKnown ? (
                  <span className={`text-xs ${c.net >= 0 ? "text-emerald-700" : "text-red-700"}`}>{c.net >= 0 ? "+" : ""}{eur(c.net)}</span>
                ) : (
                  <span className="block text-xs text-amber-700">résultat à calculer : {c.unknownReason}</span>
                )}
                {c.stockBuys > 0 && <span className="block text-xs text-slate-500">{c.soldCount} vendu(s), {eur(c.stockBuys)} achetés en stock{c.soldWithoutPrice ? ` · ${c.soldWithoutPrice} sans prix d'achat dans Auto Cerfa` : ""}</span>}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {admin && (
        <section className="grid grid-cols-2 gap-2">
          <Link href="/atelier" className="btn-primary text-center">Demander un devis</Link>
          <Link href="/agents" className="btn-secondary text-center">Parler à un agent</Link>
          <Link href="/recap" className="btn-secondary text-center col-span-2">Récap des 5 dernières heures</Link>
          <form action={runDevilsAdvocateNow}><button className="btn-secondary w-full">Avocat du diable</button></form>
          <form action={runControlNow}><button className="btn-secondary w-full">Relancer le contrôle</button></form>
        </section>
      )}
    </div>
  );
}
