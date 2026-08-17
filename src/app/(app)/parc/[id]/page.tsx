import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/session";
import { getInspectionStatus, getValidityConfig, type InspectionStatus } from "@/lib/inspections";
import {
  updateVehicle,
  addMaintenanceRecord,
  addInspection,
  addPlannedTask,
  updatePlannedTaskStatus,
  uploadVehicleDocument,
  archiveVehicle,
  deleteDocument,
} from "../actions";
import DocumentUploadForm from "@/components/DocumentUploadForm";

const fmt = (d: Date | null | undefined) => (d ? new Date(d).toLocaleDateString("fr-FR") : "—");
const fmtMoney = (n: number) => new Intl.NumberFormat("fr-FR").format(n);

export default async function VehicleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff();
  const { id } = await params;

  const vehicle = await prisma.vehicle.findUnique({
    where: { id },
    include: {
      maintenanceRecords: { orderBy: { date: "desc" }, include: { provider: true } },
      inspections: { orderBy: { validatedOn: "desc" } },
      plannedTasks: { orderBy: { createdAt: "desc" }, include: { provider: true } },
      documents: { orderBy: { createdAt: "desc" } },
      quotes: { orderBy: { uploadedAt: "desc" } },
      bookings: { orderBy: { departureDate: "desc" }, take: 10, include: { driver: true, renter: true } },
    },
  });
  if (!vehicle) notFound();

  const providers = await prisma.partner.findMany({ where: { type: "PROVIDER", active: true }, orderBy: { name: "asc" } });

  const ctConfig = await getValidityConfig(vehicle.type, "CT");
  const mineConfig = await getValidityConfig(vehicle.type, "MINE");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/parc" className="text-sm text-slate-500 underline">← Retour au parc</Link>
          <h1 className="text-xl font-bold mt-1">
            {vehicle.type === "TRUCK" ? "Camion" : "Remorque"} — {vehicle.name || vehicle.plate}
          </h1>
          <p className="text-sm text-slate-500 font-mono">
            {vehicle.plate} · Châssis {vehicle.chassisNumber}
          </p>
        </div>
        <form
          action={async () => {
            "use server";
            await archiveVehicle(vehicle.id);
          }}
        >
          <button className="btn-danger" type="submit">Archiver</button>
        </form>
      </div>

      {/* Fiche véhicule */}
      <details className="card">
        <summary className="cursor-pointer font-semibold">Fiche véhicule (modifier)</summary>
        <form
          action={async (formData: FormData) => {
            "use server";
            await updateVehicle(vehicle.id, formData);
          }}
          className="grid sm:grid-cols-2 gap-3 mt-4"
        >
          <div>
            <label className="label">Type</label>
            <select name="type" className="input" defaultValue={vehicle.type}>
              <option value="TRUCK">Camion / tracteur</option>
              <option value="TRAILER">Remorque</option>
            </select>
          </div>
          <div>
            <label className="label">Nom / libellé</label>
            <input name="name" defaultValue={vehicle.name ?? ""} className="input" />
          </div>
          <div>
            <label className="label">Immatriculation *</label>
            <input name="plate" defaultValue={vehicle.plate} className="input" required />
          </div>
          <div>
            <label className="label">Numéro de châssis *</label>
            <input name="chassisNumber" defaultValue={vehicle.chassisNumber} className="input" required />
          </div>
          <div>
            <label className="label">Marque</label>
            <input name="brand" defaultValue={vehicle.brand ?? ""} className="input" />
          </div>
          <div>
            <label className="label">Modèle</label>
            <input name="model" defaultValue={vehicle.model ?? ""} className="input" />
          </div>
          <div>
            <label className="label">Année</label>
            <input name="year" type="number" defaultValue={vehicle.year ?? ""} className="input" />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Notes</label>
            <textarea name="notes" defaultValue={vehicle.notes ?? ""} className="input" rows={2} />
          </div>
          <div className="sm:col-span-2">
            <button className="btn-primary" type="submit">Enregistrer</button>
          </div>
        </form>
      </details>

      {/* Contrôles CT / Mine */}
      <section className="card space-y-4">
        <h2 className="font-semibold">Contrôle technique &amp; visite Mine</h2>
        <p className="text-xs text-slate-500">
          Durée de validité configurée — CT : {ctConfig.validityMonths} mois (rappel {ctConfig.reminderDaysBefore} j avant) ·
          Mine : {mineConfig.validityMonths} mois (rappel {mineConfig.reminderDaysBefore} j avant).{" "}
          <Link href="/parametres" className="underline">Modifier dans Paramètres</Link>
        </p>

        <table className="table-base">
          <thead>
            <tr>
              <th>Type</th>
              <th>Validé le</th>
              <th>Expire le</th>
              <th>Statut</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {vehicle.inspections.map((insp) => {
              const cfgDays = insp.type === "CT" ? ctConfig.reminderDaysBefore : mineConfig.reminderDaysBefore;
              const status: InspectionStatus = getInspectionStatus(insp.expiresOn, cfgDays);
              return (
                <tr key={insp.id}>
                  <td>{insp.type === "CT" ? "Contrôle technique" : "Visite Mine"}</td>
                  <td>{fmt(insp.validatedOn)}</td>
                  <td>{fmt(insp.expiresOn)}</td>
                  <td>
                    <StatusBadge status={status} />
                  </td>
                  <td>{insp.notes ?? "—"}</td>
                </tr>
              );
            })}
            {vehicle.inspections.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-slate-400 py-4">Aucun contrôle enregistré.</td>
              </tr>
            )}
          </tbody>
        </table>

        <details>
          <summary className="cursor-pointer text-sm font-medium">+ Enregistrer un contrôle</summary>
          <form
            action={async (formData: FormData) => {
              "use server";
              await addInspection(vehicle.id, formData);
            }}
            className="grid sm:grid-cols-2 gap-3 mt-3"
          >
            <div>
              <label className="label">Type</label>
              <select name="type" className="input" required>
                <option value="CT">Contrôle technique</option>
                <option value="MINE">Visite Mine</option>
              </select>
            </div>
            <div>
              <label className="label">Date de validation *</label>
              <input name="validatedOn" type="date" className="input" required />
            </div>
            <div>
              <label className="label">Date d&apos;expiration (optionnel — sinon calculée auto)</label>
              <input name="expiresOn" type="date" className="input" />
            </div>
            <div>
              <label className="label">Notes</label>
              <input name="notes" className="input" />
            </div>
            <div className="sm:col-span-2">
              <button className="btn-primary" type="submit">Ajouter</button>
            </div>
          </form>
        </details>
      </section>

      {/* Entretiens / frais */}
      <section className="card space-y-4">
        <h2 className="font-semibold">Derniers frais / entretiens</h2>
        <table className="table-base">
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>Prestataire</th>
              <th>Coût</th>
            </tr>
          </thead>
          <tbody>
            {vehicle.maintenanceRecords.map((m) => (
              <tr key={m.id}>
                <td>{fmt(m.date)}</td>
                <td>{m.description}</td>
                <td>{m.provider?.name ?? "—"}</td>
                <td>{fmtMoney(m.cost)}</td>
              </tr>
            ))}
            {vehicle.maintenanceRecords.length === 0 && (
              <tr>
                <td colSpan={4} className="text-center text-slate-400 py-4">Aucun frais enregistré.</td>
              </tr>
            )}
          </tbody>
        </table>

        <details>
          <summary className="cursor-pointer text-sm font-medium">+ Ajouter un frais</summary>
          <form
            action={async (formData: FormData) => {
              "use server";
              await addMaintenanceRecord(vehicle.id, formData);
            }}
            className="grid sm:grid-cols-2 gap-3 mt-3"
          >
            <div>
              <label className="label">Date *</label>
              <input name="date" type="date" className="input" required />
            </div>
            <div>
              <label className="label">Coût *</label>
              <input name="cost" type="number" step="0.01" className="input" required />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Description *</label>
              <input name="description" className="input" required />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Prestataire</label>
              <select name="providerId" className="input" defaultValue="">
                <option value="">— aucun —</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <p className="text-xs text-slate-400 mt-1">
                Prestataire non listé ?{" "}
                <Link href="/partenaires" className="underline">Ajoutez-le dans Partenaires</Link>.
              </p>
            </div>
            <div className="sm:col-span-2">
              <button className="btn-primary" type="submit">Ajouter</button>
            </div>
          </form>
        </details>
      </section>

      {/* Tâches à prévoir */}
      <section className="card space-y-4">
        <h2 className="font-semibold">À prévoir</h2>
        <ul className="space-y-2">
          {vehicle.plannedTasks.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 border border-slate-100 rounded-md px-3 py-2">
              <div>
                <p className="text-sm font-medium">{t.description}</p>
                <p className="text-xs text-slate-500">
                  {t.provider ? `Prestataire : ${t.provider.name}` : "Aucun prestataire"} · Échéance : {fmt(t.dueDate)}
                </p>
              </div>
              <form
                action={async (formData: FormData) => {
                  "use server";
                  await updatePlannedTaskStatus(t.id, vehicle.id, formData.get("status") as string);
                }}
              >
                <select
                  name="status"
                  defaultValue={t.status}
                  className="input text-xs py-1"
                  onChange={(e) => e.currentTarget.form?.requestSubmit()}
                >
                  <option value="TODO">À faire</option>
                  <option value="IN_PROGRESS">En cours</option>
                  <option value="DONE">Terminé</option>
                </select>
              </form>
            </li>
          ))}
          {vehicle.plannedTasks.length === 0 && <p className="text-sm text-slate-400">Rien de prévu.</p>}
        </ul>

        <details>
          <summary className="cursor-pointer text-sm font-medium">+ Ajouter une tâche à prévoir</summary>
          <form
            action={async (formData: FormData) => {
              "use server";
              await addPlannedTask(vehicle.id, formData);
            }}
            className="grid sm:grid-cols-2 gap-3 mt-3"
          >
            <div className="sm:col-span-2">
              <label className="label">Description *</label>
              <input name="description" className="input" required placeholder="Ex: vidange, changement pneus..." />
            </div>
            <div>
              <label className="label">Prestataire</label>
              <select name="providerId" className="input" defaultValue="">
                <option value="">— aucun —</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Échéance</label>
              <input name="dueDate" type="date" className="input" />
            </div>
            <div className="sm:col-span-2">
              <button className="btn-primary" type="submit">Ajouter</button>
            </div>
          </form>
        </details>
      </section>

      {/* Devis liés */}
      <section className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Devis liés à ce véhicule</h2>
          <Link href="/devis" className="text-sm underline text-slate-600">Gérer les devis →</Link>
        </div>
        <ul className="text-sm space-y-1">
          {vehicle.quotes.map((q) => (
            <li key={q.id}>
              <a href={q.filePath} target="_blank" className="underline" rel="noreferrer">{q.title}</a>{" "}
              <span className="text-slate-400">— {fmt(q.uploadedAt)}</span>
            </li>
          ))}
          {vehicle.quotes.length === 0 && <p className="text-slate-400">Aucun devis lié.</p>}
        </ul>
      </section>

      {/* Documents / Photos */}
      <section className="space-y-4">
        <h2 className="font-semibold">Photos &amp; fiche technique</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <DocumentUploadForm
            action={async (formData: FormData) => {
              "use server";
              await uploadVehicleDocument(vehicle.id, formData);
            }}
            typeOptions={[
              { value: "PHOTO", label: "Photo du véhicule" },
              { value: "TECH_SHEET", label: "Fiche technique" },
              { value: "DAMAGE", label: "Dégât constaté" },
              { value: "OTHER", label: "Autre" },
            ]}
            submitLabel="Ajouter le document"
          />
          <div className="card">
            <p className="text-sm font-semibold mb-2">Documents ({vehicle.documents.length})</p>
            <div className="grid grid-cols-3 gap-2 max-h-96 overflow-y-auto">
              {vehicle.documents.map((d) => (
                <div key={d.id} className="relative group">
                  {d.filePath.match(/\.(jpg|jpeg|png|webp)$/i) ? (
                    <a href={d.filePath} target="_blank" rel="noreferrer">
                      <img src={d.filePath} alt={d.fileName} className="w-full h-20 object-cover rounded-md border" />
                    </a>
                  ) : (
                    <a
                      href={d.filePath}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-center h-20 rounded-md border text-xs text-center p-1 bg-slate-50"
                    >
                      {d.fileName}
                    </a>
                  )}
                  <p className="text-[10px] text-slate-400 truncate">{d.type}</p>
                  <form
                    action={async () => {
                      "use server";
                      await deleteDocument(d.id, vehicle.id);
                    }}
                  >
                    <button className="text-[10px] text-red-500 underline" type="submit">supprimer</button>
                  </form>
                </div>
              ))}
              {vehicle.documents.length === 0 && (
                <p className="text-xs text-slate-400 col-span-3">Aucun document.</p>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Historique planning */}
      <section className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Historique départs / arrivées</h2>
          <Link href="/planning" className="text-sm underline text-slate-600">Voir le planning complet →</Link>
        </div>
        <table className="table-base">
          <thead>
            <tr>
              <th>Départ</th>
              <th>Arrivée</th>
              <th>Chauffeur / Locataire</th>
              <th>Statut</th>
            </tr>
          </thead>
          <tbody>
            {vehicle.bookings.map((b) => (
              <tr key={b.id}>
                <td>{fmt(b.departureDate)} {b.departureLocation ? `· ${b.departureLocation}` : ""}</td>
                <td>{fmt(b.arrivalDate)} {b.arrivalLocation ? `· ${b.arrivalLocation}` : ""}</td>
                <td>{b.driver?.name ?? b.renter?.name ?? "—"}</td>
                <td>{b.status}</td>
              </tr>
            ))}
            {vehicle.bookings.length === 0 && (
              <tr>
                <td colSpan={4} className="text-center text-slate-400 py-4">Aucune mission enregistrée.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: InspectionStatus }) {
  const label = status === "ok" ? "OK" : status === "warning" ? "À prévoir" : "Expiré";
  const cls = status === "ok" ? "badge-ok" : status === "warning" ? "badge-warning" : "badge-expired";
  return <span className={`text-xs px-2 py-1 rounded-full ${cls}`}>{label}</span>;
}
