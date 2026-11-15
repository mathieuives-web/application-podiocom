import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { PROVIDERS } from "@/lib/connectors";
import { shineMcpAvailable } from "@/lib/connectors/shine-mcp";
import { bankConfigured, bankRedirectUri, listBanks } from "@/lib/connectors/enablebanking";
import BankConnect from "./BankConnect";
import { addIntegration, syncNow, removeIntegration } from "./actions";

export const dynamic = "force-dynamic";

const fmt = (d: Date) => d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

export default async function ConnexionsPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  await requireAdmin();
  const { msg } = await searchParams;
  let banks: { name: string }[] = [];
  let banksError: string | null = null;
  if (bankConfigured()) {
    try {
      banks = await listBanks();
    } catch (e) {
      banksError = (e as Error).message;
    }
  }
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
            {p.id === "BANQUE" ? (
              bankConfigured() ? (
                <div className="space-y-2">
                  {banksError && <p className="text-xs text-red-700">{banksError}</p>}
                  {companies.map((c) => {
                    const connected = integrations.filter((i) => i.provider === "BANQUE" && i.companyId === c.id);
                    return (
                      <div key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="w-44 shrink-0">
                          {c.name}
                          {connected.length > 0 && <span className="block text-xs text-emerald-700">{connected.map((i) => i.label).join(", ")}</span>}
                        </span>
                        <BankConnect companyId={c.id} banks={banks.map((b) => b.name)} initial={connected[0]?.label ?? ""} />
                      </div>
                    );
                  })}
                  <p className="text-xs text-slate-500">Une société avec plusieurs banques : connectez-les l&apos;une après l&apos;autre.</p>
                </div>
              ) : (
                <ol className="text-xs text-slate-600 list-decimal pl-4 space-y-1">
                  <li>Créez un compte gratuit sur <a className="underline" href="https://enablebanking.com/sign-in/" target="_blank" rel="noreferrer">enablebanking.com</a> (lien de connexion par e-mail).</li>
                  <li>
                    Menu <strong>API applications</strong> → nouvelle application en <strong>Production</strong>, nom « Start Invest », adresse de retour :{" "}
                    <code className="break-all">{bankRedirectUri()}</code>. Le navigateur télécharge un fichier <code>.pem</code> (la clé privée).
                  </li>
                  <li>Cliquez <strong>Activate by linking accounts</strong> et connectez vos comptes (Shine...) : c&apos;est gratuit pour vos propres comptes.</li>
                  <li>Dans Railway, ajoutez <code>ENABLE_BANKING_APP_ID</code> (le nom du fichier sans .pem) et <code>ENABLE_BANKING_PRIVATE_KEY</code> (le contenu du fichier .pem), puis Deploy.</li>
                </ol>
              )
            ) : p.oauth ? (
              shineMcpAvailable() ? (
                <ul className="space-y-2">
                  <li className="text-xs text-slate-500">
                    Connectez-vous avec l&apos;identifiant Shine de chaque société (offre Start ou Plus). À refaire tous les 30 jours :
                    l&apos;application vous préviendra.
                  </li>
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
                <p className="text-xs text-slate-600">Disponible dès que le site a son adresse publique (NEXTAUTH_URL).</p>
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
                    <input name={f.name} type={f.secret ? "password" : "text"} autoComplete="off" className="input" placeholder={f.placeholder} required={!f.optional} />
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
