import { prisma } from "@/lib/prisma";
import { isAdmin, requireUser } from "@/lib/session";
import { changeMyPassword, createUser, toggleUser } from "./actions";

export const dynamic = "force-dynamic";

export default async function AccesPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const me = await requireUser();
  const { msg } = await searchParams;
  const admin = isAdmin(me.role);
  const users = admin ? await prisma.user.findMany({ orderBy: { createdAt: "asc" } }) : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Accès</h1>
        <p className="text-sm text-slate-500">Votre mot de passe{admin && " et les comptes des personnes autorisées (associés, expert-comptable...)"}.</p>
      </div>
      {msg && <p className="card text-sm bg-sky-50 border-sky-200 text-sky-900">{msg}</p>}

      <form action={changeMyPassword} className="card grid sm:grid-cols-3 gap-3 items-end">
        <div><label className="label">Mot de passe actuel</label><input name="current" type="password" className="input" required /></div>
        <div><label className="label">Nouveau mot de passe</label><input name="next" type="password" minLength={10} className="input" required /></div>
        <button className="btn-primary">Changer mon mot de passe</button>
      </form>

      {admin && (
        <>
          <section className="card overflow-x-auto">
            <h2 className="font-semibold mb-3">Comptes</h2>
            <table className="table-base">
              <thead><tr><th>Nom</th><th>Email</th><th>Rôle</th><th>État</th><th></th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.email}</td>
                    <td>{u.role === "ADMIN" ? "Fondateur (tous les droits)" : "Membre (consultation)"}</td>
                    <td>{u.active ? "Actif" : "Désactivé"}</td>
                    <td>
                      {u.id !== me.id && (
                        <form action={async () => { "use server"; await toggleUser(u.id); }}>
                          <button className="text-xs underline">{u.active ? "désactiver" : "réactiver"}</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <details className="card">
            <summary className="cursor-pointer font-semibold">+ Ajouter un accès</summary>
            <form action={createUser} className="grid sm:grid-cols-2 gap-3 mt-4">
              <div><label className="label">Nom *</label><input name="name" className="input" required /></div>
              <div><label className="label">Email *</label><input name="email" type="email" className="input" required /></div>
              <div><label className="label">Mot de passe provisoire *</label><input name="password" type="password" minLength={10} className="input" required /></div>
              <div>
                <label className="label">Rôle</label>
                <select name="role" className="input">
                  <option value="MEMBER">Membre : consulte le board et les finances</option>
                  <option value="ADMIN">Fondateur : tous les droits</option>
                </select>
              </div>
              <div className="sm:col-span-2"><button className="btn-primary">Créer l&apos;accès</button></div>
            </form>
          </details>
        </>
      )}
    </div>
  );
}
