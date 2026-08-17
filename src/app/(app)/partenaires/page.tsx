import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/session";
import { createPartner, archivePartner } from "./actions";

export default async function PartenairesPage() {
  await requireStaff();

  const [providers, renters] = await Promise.all([
    prisma.partner.findMany({ where: { type: "PROVIDER", active: true }, orderBy: { name: "asc" } }),
    prisma.partner.findMany({ where: { type: "RENTER", active: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Partenaires</h1>
        <p className="text-sm text-slate-500">
          Prestataires (garages, dépanneurs...) et locataires — enregistrés ici, sélectionnables partout ailleurs.
        </p>
      </div>

      <details className="card">
        <summary className="cursor-pointer font-semibold">+ Ajouter un partenaire</summary>
        <form action={createPartner} className="grid sm:grid-cols-2 gap-3 mt-4">
          <div>
            <label className="label">Type *</label>
            <select name="type" className="input" required defaultValue="PROVIDER">
              <option value="PROVIDER">Prestataire</option>
              <option value="RENTER">Locataire</option>
            </select>
          </div>
          <div>
            <label className="label">Nom *</label>
            <input name="name" className="input" required />
          </div>
          <div>
            <label className="label">Contact (personne)</label>
            <input name="contact" className="input" />
          </div>
          <div>
            <label className="label">Téléphone</label>
            <input name="phone" className="input" />
          </div>
          <div>
            <label className="label">Email</label>
            <input name="email" type="email" className="input" />
          </div>
          <div>
            <label className="label">Spécialité (si prestataire)</label>
            <input name="speciality" className="input" placeholder="Ex: pneumatiques, mécanique..." />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Notes</label>
            <textarea name="notes" className="input" rows={2} />
          </div>
          <div className="sm:col-span-2">
            <button className="btn-primary" type="submit">Ajouter</button>
          </div>
        </form>
      </details>

      <PartnerTable title="Prestataires" partners={providers} />
      <PartnerTable title="Locataires" partners={renters} />
    </div>
  );
}

function PartnerTable({
  title,
  partners,
}: {
  title: string;
  partners: { id: string; name: string; contact: string | null; phone: string | null; email: string | null; speciality: string | null }[];
}) {
  return (
    <section className="card overflow-x-auto">
      <h2 className="font-semibold mb-3">{title}</h2>
      <table className="table-base">
        <thead>
          <tr>
            <th>Nom</th>
            <th>Contact</th>
            <th>Téléphone</th>
            <th>Email</th>
            <th>Spécialité</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {partners.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.contact ?? "—"}</td>
              <td>{p.phone ?? "—"}</td>
              <td>{p.email ?? "—"}</td>
              <td>{p.speciality ?? "—"}</td>
              <td>
                <form
                  action={async () => {
                    "use server";
                    await archivePartner(p.id);
                  }}
                >
                  <button className="text-xs text-red-500 underline" type="submit">archiver</button>
                </form>
              </td>
            </tr>
          ))}
          {partners.length === 0 && (
            <tr>
              <td colSpan={6} className="text-center text-slate-400 py-4">Aucun.</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
