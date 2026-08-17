import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/session";
import { getInspectionStatus, DEFAULT_REMINDER_DAYS, type InspectionStatus } from "@/lib/inspections";
import { createVehicle } from "./actions";

export default async function ParcPage() {
  await requireStaff();

  const [vehicles, configs] = await Promise.all([
    prisma.vehicle.findMany({
      where: { active: true },
      include: { inspections: { orderBy: { validatedOn: "desc" } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.validityConfig.findMany(),
  ]);

  function reminderFor(vehicleType: string, inspType: string) {
    return (
      configs.find((c) => c.vehicleType === vehicleType && c.inspectionType === inspType)
        ?.reminderDaysBefore ?? DEFAULT_REMINDER_DAYS
    );
  }

  const rows = vehicles.map((v) => {
    const ct = v.inspections.find((i) => i.type === "CT");
    const mine = v.inspections.find((i) => i.type === "MINE");
    const ctStatus = ct ? getInspectionStatus(ct.expiresOn, reminderFor(v.type, "CT")) : null;
    const mineStatus = mine ? getInspectionStatus(mine.expiresOn, reminderFor(v.type, "MINE")) : null;
    return { v, ct, mine, ctStatus, mineStatus };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Parc — Camions &amp; remorques</h1>
          <p className="text-sm text-slate-500">Fiche par véhicule : châssis, immatriculation, entretiens, contrôles, documents.</p>
        </div>
      </div>

      <details className="card">
        <summary className="cursor-pointer font-semibold">+ Ajouter un véhicule</summary>
        <form action={createVehicle} className="grid sm:grid-cols-2 gap-3 mt-4">
          <div>
            <label className="label">Type</label>
            <select name="type" className="input" defaultValue="TRUCK">
              <option value="TRUCK">Camion / tracteur</option>
              <option value="TRAILER">Remorque</option>
            </select>
          </div>
          <div>
            <label className="label">Nom / libellé</label>
            <input name="name" className="input" placeholder="Ex: Tracteur 1" />
          </div>
          <div>
            <label className="label">Immatriculation *</label>
            <input name="plate" className="input" required />
          </div>
          <div>
            <label className="label">Numéro de châssis *</label>
            <input name="chassisNumber" className="input" required />
          </div>
          <div>
            <label className="label">Marque</label>
            <input name="brand" className="input" />
          </div>
          <div>
            <label className="label">Modèle</label>
            <input name="model" className="input" />
          </div>
          <div>
            <label className="label">Année</label>
            <input name="year" type="number" className="input" />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Notes</label>
            <textarea name="notes" className="input" rows={2} />
          </div>
          <div className="sm:col-span-2">
            <button className="btn-primary" type="submit">
              Créer le véhicule
            </button>
          </div>
        </form>
      </details>

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Type</th>
              <th>Nom</th>
              <th>Immatriculation</th>
              <th>Châssis</th>
              <th>Contrôle technique</th>
              <th>Mine</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ v, ct, mine, ctStatus, mineStatus }) => (
              <tr key={v.id}>
                <td>{v.type === "TRUCK" ? "Camion" : "Remorque"}</td>
                <td>{v.name ?? "—"}</td>
                <td className="font-mono">{v.plate}</td>
                <td className="font-mono">{v.chassisNumber}</td>
                <td>
                  <StatusBadge status={ctStatus} date={ct?.expiresOn} />
                </td>
                <td>
                  <StatusBadge status={mineStatus} date={mine?.expiresOn} />
                </td>
                <td>
                  <Link href={`/parc/${v.id}`} className="text-slate-600 underline text-sm">
                    Détails
                  </Link>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-slate-400 py-6">
                  Aucun véhicule enregistré.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status, date }: { status: InspectionStatus | null; date?: Date }) {
  if (!status) return <span className="text-xs text-slate-400">Non renseigné</span>;
  const label = status === "ok" ? "OK" : status === "warning" ? "À prévoir" : "Expiré";
  const cls = status === "ok" ? "badge-ok" : status === "warning" ? "badge-warning" : "badge-expired";
  return (
    <span className={`text-xs px-2 py-1 rounded-full whitespace-nowrap ${cls}`}>
      {label} {date ? `— ${new Date(date).toLocaleDateString("fr-FR")}` : ""}
    </span>
  );
}
