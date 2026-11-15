import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { PROVIDERS } from "@/lib/connectors";
import { shineConfigured } from "@/lib/connectors/shine";
import { addIntegration, syncNow, removeIntegration } from "./actions";

export const dynamic = "force-dynamic";

const fmt = (d: Date) => d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

export default async function ConnexionsPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  await requireAdmin();
  const { msg } = await searchParams;
  const [companies, integrations] = await Promise.all([
    prisma.company.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.integration.findMany({
      include: { company: true, _count: { select: { bankAccounts: true, invoices: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Connexions</h1>
        <p className="text-sm text-slate-500">
          Branchez les banques et logiciels de chaque société : les données arrivent seules dans Finances et sont lues par les agents IA.
          Les identifiants sont chiffrés en base et utilisés en lecture seule.
        </p>
      </div>

      {msg && <p className="card text-sm bg-sky-50 border-sky-200 text-sky-900">{msg}</p>}

      <section className="card overflow-x-auto">
        <h2 className="font-semibold mb-3">Outils connectés</h2>
        <table className="table-base">
          <thead><tr><th>Outil</th><th>Société</th><th>État</th><th>Données</th><th>Dernière synchro</th><th></th></tr></thead>
          <tbody>
            {integrations.map((i) => {
              const p = PROVIDERS.find((x) => x.id === i.provider);
              return (
                <tr key={i.id}>
                  <td className="font-medium">{p?.name ?? i.provider}{i.label && <span className="text-slate-500 font-normal"> · {i.label}</span>}</td>
                  <td>{i.company.name}</td>
                  <td>
                    <span className={`text-xs px-2 py-1 rounded-full ${i.status === "OK" ? "badge-ok" : i.status === "ERROR" ? "badge-expired" : "badge-warning"}`}>
                      {i.status === "OK" ? "Connecté" : i.status === "ERROR" ? "Erreur" : "En attente"}
                    </span>
                    {i.lastError && <p className="text-xs text-red-700 mt-1 max-w-xs">{i.lastError}</p>}
                  </td>
                  <td className="text-xs text-slate-500">{i._count.bankAccounts} compte(s) · {i._count.invoices} facture(s)</td>
                  <td className="text-xs">{i.lastSyncAt ? fmt(i.lastSyncAt) : "—"}</td>
                  <td className="whitespace-nowrap space-x-3">
                    <form className="inline" action={async () => { "use server"; await syncNow(i.id); }}>
                      <button className="text-xs underline">synchroniser</button>
                    </form>
                    <form className="inline" action={async () => { "use server"; await removeIntegration(i.id); }}>
                      <button className="text-xs underline text-red-600">déconnecter</button>
                    </form>
                  </td>
                </tr>
              );
            })}
            {integrations.length === 0 && <tr><td colSpan={6} className="text-center text-slate-400 py-4">Aucun outil connecté pour l&apos;instant.</td></tr>}
          </tbody>
        </table>
      </section>

      {companies.length === 0 && (
        <p className="card text-sm bg-amber-50 border-amber-200 text-amber-900">Ajoutez d&apos;abord une société dans Finances.</p>
      )}

      <section className="grid md:grid-cols-2 gap-4">
        {PROVIDERS.map((p) => (
          <div key={p.id} className={`card space-y-3 ${p.available ? "" : "opacity-70"}`}>
            <div>
              <p className="text-xs uppercase tracking-wider text-slate-400">{p.kind}</p>
              <h3 className="font-semibold">{p.name}</h3>
              <p className="text-sm text-slate-600">{p.description}</p>
            </div>
            {p.oauth ? (
              shineConfigured() ? (
                <ul className="space-y-2">
                  {companies.map((c) => {
                    const connected = integrations.find((i) => i.provider === p.id && i.companyId === c.id);
                    return (
                      <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
                        <span>{c.name}{connected && <span className="text-xs text-emerald-700"> · connecté</span>}</span>
                        <a href={`/api/shine/connect?companyId=${c.id}`} className="btn-secondary text-xs" style={{ background: "#fff389" }}>
                          {connected ? "Reconnecter" : "Se connecter avec Shine"}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <ol className="text-xs text-slate-600 list-decimal pl-4 space-y-1">
                  <li>
                    Demander l&apos;accès Shine Connect (une seule fois pour le groupe) :{" "}
                    <a className="underline" href="https://tally.so/r/3qAy69" target="_blank" rel="noreferrer">formulaire Shine</a>. Demandez les accès
                    <code> bank:accounts:read</code>, <code>bank:transactions:read</code> et <code>invoices:read</code>, avec l&apos;adresse de retour{" "}
                    <code>https://votre-domaine/api/shine/callback</code>.
                  </li>
                  <li>Shine envoie un <code>client_id</code> et un <code>client_secret</code> : ajoutez-les sur le serveur (<code>SHINE_CLIENT_ID</code>, <code>SHINE_CLIENT_SECRET</code>).</li>
                  <li>Un bouton « Se connecter avec Shine » apparaît ici pour chaque société.</li>
                </ol>
              )
            ) : p.available ? (
              <form action={addIntegration} className="space-y-2">
                <input type="hidden" name="provider" value={p.id} />
                <div>
                  <label className="label">Société</label>
                  <select name="companyId" className="input" required>
                    {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                {p.fields.map((f) => (
                  <div key={f.name}>
                    <label className="label">{f.label}</label>
                    <input name={f.name} type={f.secret ? "password" : "text"} autoComplete="off" className="input" placeholder={f.placeholder} required />
                  </div>
                ))}
                <p className="text-xs text-slate-500">Où trouver la clé : {p.docs}</p>
                <button className="btn-primary" disabled={!companies.length}>Connecter</button>
              </form>
            ) : (
              <p className="text-xs text-slate-500">Bientôt — {p.docs}. En attendant, importez vos relevés CSV / Excel dans Finances.</p>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
