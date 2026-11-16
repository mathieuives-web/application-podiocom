import { humanError } from "@/lib/human-error";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { PROVIDERS } from "@/lib/connectors";
import { shineMcpAvailable } from "@/lib/connectors/shine-mcp";
import { bankConfigured, bankRedirectUri, listBanks } from "@/lib/connectors/enablebanking";
import { googleConfigured, googleRedirectUri } from "@/lib/connectors/google";
import { microsoftConfigured, microsoftRedirectUri } from "@/lib/connectors/microsoft";
import { whatsappVerifyToken } from "@/lib/connectors/whatsapp";
import { ensureKnownPresence } from "@/lib/projects";
import BankConnect from "./BankConnect";
import ConnectChecklist from "./ConnectChecklist";
import { addIntegration, syncNow, removeIntegration, startDirect, setPresence } from "./actions";

export const dynamic = "force-dynamic";

const fmt = (d: Date) => d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

export default async function ConnexionsPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  await requireAdmin();
  await ensureKnownPresence().catch(() => undefined);
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
          Tout est prêt ci-dessous : pour chaque ligne, cliquez et entrez vos identifiants. Les données arrivent seules et sont lues par
          les agents IA. Les identifiants sont chiffrés et ne sont jamais montrés aux agents.
        </p>
      </div>

      {msg && <p className="card text-sm bg-sky-50 border-sky-200 text-sky-900">{msg}</p>}

      <ConnectChecklist />

      <h2 className="text-lg font-bold pt-4 border-t">Détail et réglages avancés</h2>
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
                    {i.lastError && <p className="text-xs text-red-700 mt-1 max-w-xs">{humanError(i.lastError)}</p>}
                  </td>
                  <td className="text-xs text-slate-500">{i._count.bankAccounts} compte(s) · {i._count.invoices} facture(s)</td>
                  <td className="text-xs">{i.lastSyncAt ? fmt(i.lastSyncAt) : "—"}</td>
                  <td className="whitespace-nowrap space-x-3">
                    {["AUTOCERFA", "GTAPRO", "PORTAIL"].includes(i.provider) && (
                      <form className="inline" action={async () => { "use server"; await startDirect(i.id); }}>
                        <button className="text-xs underline font-semibold text-emerald-700">se connecter moi-même</button>
                      </form>
                    )}
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

      <section className="card space-y-3">
        <div>
          <h2 className="font-semibold">Sites et réseaux sociaux</h2>
          <p className="text-xs text-slate-500">L&apos;agent « Site &amp; réseaux » de chaque société les audite chaque lundi et prépare le plan d&apos;action et les publications de la semaine.</p>
        </div>
        {companies.map((c) => (
          <form key={c.id} action={setPresence.bind(null, c.id)} className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2 items-end text-xs">
            <p className="font-medium text-sm col-span-2 md:col-span-4 xl:col-span-1">{c.name}</p>
            {([
              ["website", "Site internet", "www..."],
              ["googleBusiness", "Fiche Google", "lien Google Maps"],
              ["instagram", "Instagram", "@compte"],
              ["facebook", "Facebook", "lien"],
              ["tiktok", "TikTok", "@compte"],
              ["linkedin", "LinkedIn", "lien"],
            ] as const).map(([k, label, ph]) => (
              <label key={k}>{label}<input name={k} defaultValue={c[k] ?? ""} placeholder={ph} className="input py-1 text-xs" /></label>
            ))}
            <button className="btn-secondary text-xs">Enregistrer</button>
          </form>
        ))}
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
              {p.id === "WHATSAPP" && (
                <details className="text-xs text-slate-600 mt-2">
                  <summary className="cursor-pointer underline">Mise en place (une fois, 20 minutes)</summary>
                  <ol className="list-decimal pl-4 space-y-1 mt-2">
                    <li>Une ligne par société, jamais utilisée sur WhatsApp (puce ou numéro virtuel). Elle doit pouvoir recevoir un SMS ou un appel une fois.</li>
                    <li>Sur <a className="underline" href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">developers.facebook.com</a> : Créer une application → « Business » → ajouter le produit <strong>WhatsApp</strong>, rattachée au compte Meta Business de Start Invest.</li>
                    <li>WhatsApp → Configuration de l&apos;API : <strong>Ajouter un numéro</strong> pour chaque société (nom affiché : celui de la société).</li>
                    <li>WhatsApp → Configuration → Webhook : URL de rappel <code className="break-all">{(process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "")}/api/whatsapp</code>, jeton de vérification <code className="break-all">{whatsappVerifyToken()}</code>, puis abonnez le champ <strong>messages</strong>.</li>
                    <li>Business Settings → Utilisateurs système → créer un utilisateur « Start Invest » (admin), lui donner l&apos;application et le compte WhatsApp, <strong>Générer un jeton</strong> sans expiration avec les droits whatsapp_business_messaging et whatsapp_business_management.</li>
                    <li>Ici, pour chaque société : l&apos;identifiant du numéro (Phone number ID), le jeton, et la clé secrète de l&apos;application (Paramètres → Général → Clé secrète).</li>
                    <li>Dans Équipe, renseignez le numéro de portable de chaque salarié : ses messages lui seront attribués.</li>
                  </ol>
                </details>
              )}
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
            ) : p.id === "OUTLOOK" ? (
              microsoftConfigured() ? (
                <ul className="space-y-2">
                  {companies.map((c) => {
                    const connected = integrations.filter((i) => i.provider === "OUTLOOK" && i.companyId === c.id);
                    return (
                      <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
                        <span>{c.name}{connected.length > 0 && <span className="block text-xs text-emerald-700">{connected.map((i) => i.label).join(", ")}</span>}</span>
                        <a href={`/api/microsoft/connect?companyId=${c.id}`} className="btn-secondary text-xs">{connected.length ? "Ajouter une adresse" : "Se connecter avec Outlook"}</a>
                      </li>
                    );
                  })}
                  <li className="text-xs text-slate-500">Votre adresse personnelle qui sert à toutes les sociétés : connectez-la sur <strong>Start Invest</strong>.</li>
                </ul>
              ) : (
                <ol className="text-xs text-slate-600 list-decimal pl-4 space-y-1">
                  <li>Sur <a className="underline" href="https://entra.microsoft.com/" target="_blank" rel="noreferrer">entra.microsoft.com</a> (connectez-vous avec votre compte Outlook) → Applications → <strong>Inscriptions d&apos;applications</strong> → Nouvelle inscription « Start Invest ».</li>
                  <li>Types de comptes : <strong>comptes dans un annuaire organisationnel et comptes Microsoft personnels</strong> (Outlook, Hotmail).</li>
                  <li>URI de redirection (Web) : <code className="break-all">{microsoftRedirectUri()}</code></li>
                  <li>Certificats et secrets → <strong>Nouveau secret client</strong> (24 mois) ; Autorisations d&apos;API → Microsoft Graph → délégué : <code>Mail.ReadWrite</code>, <code>offline_access</code>, <code>User.Read</code>.</li>
                  <li>Dans Railway : <code>MICROSOFT_CLIENT_ID</code> (ID d&apos;application) et <code>MICROSOFT_CLIENT_SECRET</code> (la valeur du secret), puis Deploy.</li>
                </ol>
              )
            ) : p.id === "GOOGLE" ? (
              googleConfigured() ? (
                <ul className="space-y-2">
                  {companies.map((c) => {
                    const connected = integrations.filter((i) => i.provider === "GOOGLE" && i.companyId === c.id);
                    return (
                      <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
                        <span>{c.name}{connected.length > 0 && <span className="block text-xs text-emerald-700">{connected.map((i) => i.label).join(", ")}</span>}</span>
                        <a href={`/api/google/connect?companyId=${c.id}`} className="btn-secondary text-xs">{connected.length ? "Ajouter une adresse" : "Se connecter avec Google"}</a>
                      </li>
                    );
                  })}
                  <li className="text-xs text-slate-500">Cochez bien Gmail ET Drive sur l&apos;écran Google. Plusieurs adresses par société possibles.</li>
                </ul>
              ) : (
                <ol className="text-xs text-slate-600 list-decimal pl-4 space-y-1">
                  <li>Sur <a className="underline" href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">console.cloud.google.com</a>, créez un projet « Start Invest ».</li>
                  <li>Activez les API <strong>Gmail API</strong> et <strong>Google Drive API</strong> (menu API et services → Bibliothèque).</li>
                  <li>Écran de consentement OAuth : type <strong>Externe</strong> (ou <strong>Interne</strong> si vous avez Google Workspace), ajoutez votre adresse, puis <strong>Publier l&apos;application</strong> (sinon l&apos;accès expire tous les 7 jours).</li>
                  <li>Identifiants → Créer → <strong>ID client OAuth</strong> → Application Web, URI de redirection : <code className="break-all">{googleRedirectUri()}</code></li>
                  <li>Dans Railway, ajoutez <code>GOOGLE_CLIENT_ID</code> et <code>GOOGLE_CLIENT_SECRET</code>, puis Deploy.</li>
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
