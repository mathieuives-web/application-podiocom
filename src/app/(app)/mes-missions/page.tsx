import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import DocumentUploadForm from "@/components/DocumentUploadForm";
import { uploadMissionDocument } from "./actions";

const fmt = (d: Date | null | undefined) =>
  d ? new Date(d).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

const DOC_LABELS: Record<string, string> = {
  PHOTO: "Photo",
  TECH_SHEET: "Fiche technique",
  FUEL_RECEIPT: "Ticket essence",
  HOTEL_INVOICE: "Facture hôtel",
  DAMAGE: "Dégât",
  OTHER: "Autre",
};

export default async function MesMissionsPage() {
  const user = await requireUser();
  const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

  const bookings = await prisma.booking.findMany({
    where:
      dbUser.role === "DRIVER"
        ? { driverId: user.id }
        : dbUser.role === "RENTER"
        ? { renterId: dbUser.partnerId ?? "__none__" }
        : {},
    include: { vehicle: true, documents: { orderBy: { createdAt: "desc" } } },
    orderBy: { departureDate: "desc" },
    take: 50,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Mes missions</h1>
        <p className="text-sm text-slate-500">
          Retrouvez vos trajets / locations et ajoutez en temps réel vos tickets essence, factures hôtel ou
          photos de dégâts.
        </p>
      </div>

      {bookings.length === 0 && (
        <p className="text-sm text-slate-400">Aucune mission ne vous est encore assignée.</p>
      )}

      {bookings.map((b) => (
        <section key={b.id} className="card space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="font-semibold font-mono">{b.vehicle.plate} {b.vehicle.name ? `— ${b.vehicle.name}` : ""}</p>
              <p className="text-sm text-slate-500">
                Départ : {fmt(b.departureDate)} {b.departureLocation ? `· ${b.departureLocation}` : ""}
              </p>
              <p className="text-sm text-slate-500">
                Arrivée : {fmt(b.arrivalDate)} {b.arrivalLocation ? `· ${b.arrivalLocation}` : ""}
              </p>
            </div>
            <span className="text-xs px-2 py-1 rounded-full bg-slate-100 border border-slate-300">{b.status}</span>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <DocumentUploadForm
              action={async (formData: FormData) => {
                "use server";
                await uploadMissionDocument(b.id, formData);
              }}
              hidden={{ bookingId: b.id }}
              typeOptions={[
                { value: "FUEL_RECEIPT", label: "Ticket essence" },
                { value: "HOTEL_INVOICE", label: "Facture hôtel" },
                { value: "DAMAGE", label: "Dégât" },
                { value: "OTHER", label: "Autre" },
              ]}
              submitLabel="Envoyer"
              noteLabel="Montant / commentaire"
            />
            <div>
              <p className="text-sm font-semibold mb-2">Documents envoyés ({b.documents.length})</p>
              <div className="grid grid-cols-3 gap-2 max-h-72 overflow-y-auto">
                {b.documents.map((d) => (
                  <a key={d.id} href={d.filePath} target="_blank" rel="noreferrer" className="block">
                    {d.filePath.match(/\.(jpg|jpeg|png|webp)$/i) ? (
                      <img src={d.filePath} alt={d.fileName} className="w-full h-20 object-cover rounded-md border" />
                    ) : (
                      <div className="flex items-center justify-center h-20 rounded-md border text-xs text-center p-1 bg-slate-50">
                        {d.fileName}
                      </div>
                    )}
                    <p className="text-[10px] text-slate-400 truncate">{DOC_LABELS[d.type] ?? d.type}</p>
                  </a>
                ))}
                {b.documents.length === 0 && <p className="text-xs text-slate-400 col-span-3">Aucun document.</p>}
              </div>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
