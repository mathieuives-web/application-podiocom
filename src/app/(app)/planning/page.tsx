import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/session";
import { createBooking, updateBookingStatus } from "./actions";

const fmt = (d: Date | null | undefined) =>
  d ? new Date(d).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

export default async function PlanningPage({
  searchParams,
}: {
  searchParams: Promise<{ plate?: string; from?: string; to?: string }>;
}) {
  await requireStaff();
  const params = await searchParams;

  const [vehicles, drivers, renters] = await Promise.all([
    prisma.vehicle.findMany({ where: { active: true }, orderBy: { plate: "asc" } }),
    prisma.user.findMany({ where: { role: { in: ["DRIVER", "EMPLOYEE", "ADMIN"] }, active: true }, orderBy: { name: "asc" } }),
    prisma.partner.findMany({ where: { type: "RENTER", active: true }, orderBy: { name: "asc" } }),
  ]);

  const bookings = await prisma.booking.findMany({
    where: {
      vehicle: params.plate ? { plate: { contains: params.plate } } : undefined,
      departureDate: {
        gte: params.from ? new Date(params.from) : undefined,
        lte: params.to ? new Date(params.to + "T23:59:59") : undefined,
      },
    },
    include: { vehicle: true, driver: true, renter: true },
    orderBy: { departureDate: "desc" },
    take: 200,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Planning — Départs &amp; arrivées</h1>
        <p className="text-sm text-slate-500">Emploi du temps par véhicule, avec le chauffeur ou le locataire.</p>
      </div>

      <details className="card">
        <summary className="cursor-pointer font-semibold">+ Ajouter un départ / une location</summary>
        <BookingForm vehicles={vehicles} drivers={drivers} renters={renters} />
      </details>

      <form className="card flex flex-wrap gap-3 items-end" method="get">
        <div>
          <label className="label">Immatriculation</label>
          <input name="plate" defaultValue={params.plate ?? ""} className="input" placeholder="Ex: AB-123-CD" />
        </div>
        <div>
          <label className="label">Du</label>
          <input name="from" type="date" defaultValue={params.from ?? ""} className="input" />
        </div>
        <div>
          <label className="label">Au</label>
          <input name="to" type="date" defaultValue={params.to ?? ""} className="input" />
        </div>
        <button className="btn-secondary" type="submit">Filtrer</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Véhicule</th>
              <th>Type</th>
              <th>Départ</th>
              <th>Arrivée</th>
              <th>Chauffeur / Locataire</th>
              <th>Statut</th>
            </tr>
          </thead>
          <tbody>
            {bookings.map((b) => (
              <tr key={b.id}>
                <td className="font-mono">{b.vehicle.plate}</td>
                <td>{b.kind === "MISSION" ? "Mission" : "Location"}</td>
                <td>{fmt(b.departureDate)}{b.departureLocation ? ` · ${b.departureLocation}` : ""}</td>
                <td>{fmt(b.arrivalDate)}{b.arrivalLocation ? ` · ${b.arrivalLocation}` : ""}</td>
                <td>{b.driver?.name ?? b.renter?.name ?? "—"}</td>
                <td>
                  <form
                    action={async (formData: FormData) => {
                      "use server";
                      await updateBookingStatus(b.id, formData.get("status") as string);
                    }}
                  >
                    <select
                      name="status"
                      defaultValue={b.status}
                      className="input text-xs py-1"
                    >
                      <option value="PLANNED">Planifié</option>
                      <option value="ONGOING">En cours</option>
                      <option value="COMPLETED">Terminé</option>
                      <option value="CANCELLED">Annulé</option>
                    </select>
                  </form>
                </td>
              </tr>
            ))}
            {bookings.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-400 py-6">Aucune entrée pour ces filtres.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BookingForm({
  vehicles,
  drivers,
  renters,
}: {
  vehicles: { id: string; plate: string; name: string | null }[];
  drivers: { id: string; name: string }[];
  renters: { id: string; name: string }[];
}) {
  return (
    <form action={createBooking} className="grid sm:grid-cols-2 gap-3 mt-4">
      <div>
        <label className="label">Véhicule *</label>
        <select name="vehicleId" className="input" required>
          {vehicles.map((v) => (
            <option key={v.id} value={v.id}>{v.plate} {v.name ? `— ${v.name}` : ""}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label">Type *</label>
        <select name="kind" className="input" required defaultValue="MISSION">
          <option value="MISSION">Mission (chauffeur interne)</option>
          <option value="LOCATION">Location (locataire)</option>
        </select>
      </div>
      <div>
        <label className="label">Chauffeur (si mission)</label>
        <select name="driverId" className="input" defaultValue="">
          <option value="">— aucun —</option>
          {drivers.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label">Locataire (si location)</label>
        <select name="renterId" className="input" defaultValue="">
          <option value="">— aucun —</option>
          {renters.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label">Date/heure de départ *</label>
        <input name="departureDate" type="datetime-local" className="input" required />
      </div>
      <div>
        <label className="label">Lieu de départ</label>
        <input name="departureLocation" className="input" />
      </div>
      <div>
        <label className="label">Date/heure d&apos;arrivée</label>
        <input name="arrivalDate" type="datetime-local" className="input" />
      </div>
      <div>
        <label className="label">Lieu d&apos;arrivée</label>
        <input name="arrivalLocation" className="input" />
      </div>
      <div className="sm:col-span-2">
        <label className="label">Notes</label>
        <input name="notes" className="input" />
      </div>
      <div className="sm:col-span-2">
        <button className="btn-primary" type="submit">Ajouter au planning</button>
      </div>
    </form>
  );
}
