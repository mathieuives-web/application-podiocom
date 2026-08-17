import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { ROLE_LABELS } from "@/lib/roles";
import { createEmployee, toggleEmployeeActive, resetEmployeePassword } from "./actions";

export default async function EmployesPage() {
  await requireAdmin();

  const [users, renterPartners] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: "desc" }, include: { partner: true } }),
    prisma.partner.findMany({ where: { type: "RENTER", active: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Employés &amp; accès</h1>
        <p className="text-sm text-slate-500">
          Créez un accès pour chaque salarié Podiocom, chauffeur ou locataire. Chacun se connecte avec son
          email et son mot de passe.
        </p>
      </div>

      <details className="card">
        <summary className="cursor-pointer font-semibold">+ Créer un accès</summary>
        <form action={createEmployee} className="grid sm:grid-cols-2 gap-3 mt-4">
          <div>
            <label className="label">Nom complet *</label>
            <input name="name" className="input" required />
          </div>
          <div>
            <label className="label">Email *</label>
            <input name="email" type="email" className="input" required />
          </div>
          <div>
            <label className="label">Mot de passe initial *</label>
            <input name="password" type="text" className="input" required placeholder="À communiquer à la personne" />
          </div>
          <div>
            <label className="label">Téléphone</label>
            <input name="phone" className="input" />
          </div>
          <div>
            <label className="label">Rôle *</label>
            <select name="role" className="input" required defaultValue="EMPLOYEE">
              <option value="ADMIN">Administrateur</option>
              <option value="EMPLOYEE">Employé (bureau)</option>
              <option value="DRIVER">Chauffeur</option>
              <option value="RENTER">Locataire</option>
            </select>
          </div>
          <div>
            <label className="label">Fiche locataire associée (si rôle locataire)</label>
            <select name="partnerId" className="input" defaultValue="">
              <option value="">— aucune —</option>
              {renterPartners.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <button className="btn-primary" type="submit">Créer l&apos;accès</button>
          </div>
        </form>
      </details>

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Nom</th>
              <th>Email</th>
              <th>Rôle</th>
              <th>Statut</th>
              <th>Nouveau mot de passe</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>{ROLE_LABELS[u.role]}</td>
                <td>{u.active ? "Actif" : "Désactivé"}</td>
                <td>
                  <form
                    action={async (formData: FormData) => {
                      "use server";
                      await resetEmployeePassword(u.id, formData);
                    }}
                    className="flex gap-2"
                  >
                    <input type="text" name="password" placeholder="Nouveau mot de passe" className="input text-xs py-1" />
                    <button className="btn-secondary text-xs" type="submit">Changer</button>
                  </form>
                </td>
                <td>
                  <form
                    action={async () => {
                      "use server";
                      await toggleEmployeeActive(u.id, !u.active);
                    }}
                  >
                    <button className="text-xs underline" type="submit">
                      {u.active ? "Désactiver" : "Réactiver"}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
