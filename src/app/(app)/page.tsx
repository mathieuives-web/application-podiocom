import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { isStaff } from "@/lib/roles";
import { getInspectionStatus, DEFAULT_REMINDER_DAYS } from "@/lib/inspections";

const fmt = (d: Date) => new Date(d).toLocaleDateString("fr-FR");

export default async function DashboardPage() {
  const user = await requireUser();

  if (!isStaff(user.role)) {
    return (
      <div className="space-y-2">
        <h1 className="text-xl font-bold">Bienvenue, {user.name}</h1>
        <p className="text-sm text-slate-500">
          Consultez et alimentez vos missions dans{" "}
          <Link href="/mes-missions" className="underline">Mes missions</Link>.
        </p>
      </div>
    );
  }

  const [vehicleCount, vehicles, configs, upcoming, pendingTasks] = await Promise.all([
    prisma.vehicle.count({ where: { active: true } }),
    prisma.vehicle.findMany({
      where: { active: true },
      include: { inspections: { orderBy: { validatedOn: "desc" } } },
    }),
    prisma.validityConfig.findMany(),
    prisma.booking.findMany({
      where: { departureDate: { gte: new Date() }, status: "PLANNED" },
      include: { vehicle: true, driver: true, renter: true },
      orderBy: { departureDate: "asc" },
      take: 5,
    }),
    prisma.plannedTask.findMany({
      where: { status: { not: "DONE" } },
      include: { vehicle: true, provider: true },
      orderBy: { dueDate: "asc" },
      take: 5,
    }),
  ]);

  function reminderFor(vehicleType: string, inspType: string) {
    return (
      configs.find((c) => c.vehicleType === vehicleType && c.inspectionType === inspType)
        ?.reminderDaysBefore ?? DEFAULT_REMINDER_DAYS
    );
  }

  const alerts = vehicles.flatMap((v) =>
    v.inspections
      .filter((i, idx, arr) => arr.findIndex((x) => x.type === i.type) === idx) // latest per type
      .map((i) => ({
        vehicle: v,
        inspection: i,
        status: getInspectionStatus(i.expiresOn, reminderFor(v.type, i.type)),
      }))
      .filter((a) => a.status !== "ok")
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Tableau de bord</h1>
        <p className="text-sm text-slate-500">{vehicleCount} véhicules actifs dans le parc.</p>
      </div>

      <section className="card">
        <h2 className="font-semibold mb-3">Alertes contrôle technique / Mine</h2>
        {alerts.length === 0 && <p className="text-sm text-slate-400">Aucune alerte, tout est à jour.</p>}
        <ul className="space-y-2">
          {alerts.map((a) => (
            <li key={a.inspection.id} className="flex items-center justify-between text-sm">
              <span>
                <Link href={`/parc/${a.vehicle.id}`} className="underline font-mono">{a.vehicle.plate}</Link>{" "}
                — {a.inspection.type === "CT" ? "Contrôle technique" : "Visite Mine"} expire le {fmt(a.inspection.expiresOn)}
              </span>
              <span className={`text-xs px-2 py-1 rounded-full ${a.status === "expired" ? "badge-expired" : "badge-warning"}`}>
                {a.status === "expired" ? "Expiré" : "À prévoir"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid sm:grid-cols-2 gap-4">
        <section className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Prochains départs</h2>
            <Link href="/planning" className="text-sm underline text-slate-600">Voir tout →</Link>
          </div>
          <ul className="space-y-2 text-sm">
            {upcoming.map((b) => (
              <li key={b.id}>
                <span className="font-mono">{b.vehicle.plate}</span> — {fmt(b.departureDate)}
                {" · "}
                {b.driver?.name ?? b.renter?.name ?? "—"}
              </li>
            ))}
            {upcoming.length === 0 && <p className="text-slate-400">Rien de planifié.</p>}
          </ul>
        </section>

        <section className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Tâches à prévoir</h2>
            <Link href="/parc" className="text-sm underline text-slate-600">Voir le parc →</Link>
          </div>
          <ul className="space-y-2 text-sm">
            {pendingTasks.map((t) => (
              <li key={t.id}>
                <span className="font-mono">{t.vehicle.plate}</span> — {t.description}
                {t.provider ? ` (${t.provider.name})` : ""}
              </li>
            ))}
            {pendingTasks.length === 0 && <p className="text-slate-400">Rien en attente.</p>}
          </ul>
        </section>
      </div>
    </div>
  );
}
