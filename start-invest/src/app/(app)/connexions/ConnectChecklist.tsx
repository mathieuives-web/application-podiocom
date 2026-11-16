import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { decryptJson } from "@/lib/crypto";
import { bankConfigured, listBanks } from "@/lib/connectors/enablebanking";
import { microsoftConfigured } from "@/lib/connectors/microsoft";
import { whatsappVerifyToken } from "@/lib/connectors/whatsapp";
import { ensureKnownPresence } from "@/lib/projects";
import BankConnect from "./BankConnect";
import { addIntegration, quickConnect, syncNow } from "./actions";


// Tout ce qu'il faut connecter, société par société, prêt d'avance : il ne reste qu'à cliquer et taper ses identifiants.
type Item =
  | { kind: "BANQUE"; bank: RegExp; bankLabel: string }
  | { kind: "IMAP"; count: number; hint: string }
  | { kind: "ROBOT"; provider: "AUTOCERFA" | "GTAPRO"; name: string }
  | { kind: "PORTAIL"; name: string; url: string; hint: string }
  | { kind: "FOURNISSEUR" }
  | { kind: "WHATSAPP"; number?: string }
  | { kind: "OUTLOOK" }
  | { kind: "GITHUB" };

const PLAN: { company: string; items: Item[] }[] = [
  {
    company: "La Fabrique Automobile",
    items: [
      { kind: "BANQUE", bank: /cr[ée]dit mutuel de bretagne|\bcmb\b|arkea/i, bankLabel: "CMB" },
      { kind: "IMAP", count: 3, hint: "les 3 adresses Gmail de La Fabrique Automobile" },
      { kind: "ROBOT", provider: "AUTOCERFA", name: "Auto Cerfa (stock, ventes, frais)" },
      { kind: "WHATSAPP" },
    ],
  },
  {
    company: "Auto Rac Ives",
    items: [
      { kind: "BANQUE", bank: /^cic\b|\bcic\b/i, bankLabel: "CIC" },
      { kind: "IMAP", count: 1, hint: "l'adresse Gmail de l'atelier" },
      { kind: "ROBOT", provider: "GTAPRO", name: "GTA Pro (factures, devis, OR)" },
      { kind: "PORTAIL", name: "Autodata", url: "https://workshop.autodata-group.com/login", hint: "temps barème et valeurs constructeur" },
      { kind: "FOURNISSEUR" },
      { kind: "WHATSAPP", number: "+33 7 66 09 94 39" },
    ],
  },
  { company: "La Fabrique Restaurant", items: [{ kind: "BANQUE", bank: /^cic\b|\bcic\b/i, bankLabel: "CIC" }] },
  { company: "Le Bar L'Usine", items: [{ kind: "BANQUE", bank: /cr[ée]dit mutuel de bretagne|\bcmb\b|arkea/i, bankLabel: "CMB" }] },
  { company: "SCI Mapo", items: [{ kind: "BANQUE", bank: /cr[ée]dit mutuel de bretagne|\bcmb\b|arkea/i, bankLabel: "CMB" }] },
  { company: "Start Invest", items: [{ kind: "BANQUE", bank: /cr[ée]dit mutuel de bretagne|\bcmb\b|arkea/i, bankLabel: "CMB" }, { kind: "OUTLOOK" }, { kind: "GITHUB" }] },
];

function Status({ ok, warn, children }: { ok: boolean; warn?: boolean; children: React.ReactNode }) {
  return <span className={`text-xs font-medium ${ok ? "text-emerald-700" : warn ? "text-amber-700" : "text-red-700"}`}>{ok ? "✅ " : warn ? "⚠️ " : "⭕ "}{children}</span>;
}

/** Liste « Tout connecter » affichée en haut de la page Connexions. */
export default async function ConnectChecklist() {
  await ensureKnownPresence().catch(() => undefined);
  const [companies, integrations, banks] = await Promise.all([
    prisma.company.findMany({ where: { active: true } }),
    prisma.integration.findMany({ orderBy: { createdAt: "asc" } }),
    bankConfigured() ? listBanks().catch(() => []) : Promise.resolve([] as { name: string }[]),
  ]);
  const connectedRobot = (i: (typeof integrations)[number]) => {
    try {
      const c = decryptJson<{ storageState?: string; password?: string }>(i.credentials);
      return Boolean(c.storageState || c.password);
    } catch {
      return false;
    }
  };
  let total = 0;
  let done = 0;
  const count = (ok: boolean) => {
    total++;
    if (ok) done++;
    return ok;
  };

  const sections = PLAN.map(({ company, items }) => {
    const c = companies.find((x) => x.name === company);
    if (!c) return null;
    const mine = integrations.filter((i) => i.companyId === c.id);
    return (
      <section key={company} className="card space-y-3">
        <h2 className="font-semibold">{company}</h2>
        <ul className="space-y-3">
          {items.map((it, k) => {
            if (it.kind === "BANQUE") {
              const list = mine.filter((i) => i.provider === "BANQUE");
              const ok = count(list.some((i) => i.status === "OK"));
              const bank = banks.find((b) => it.bank.test(b.name))?.name ?? "";
              return (
                <li key={k} className="flex flex-wrap items-center gap-2">
                  <span className="w-56 text-sm">Banque {it.bankLabel}</span>
                  <Status ok={ok}>{ok ? list.map((i) => i.label).join(", ") : "à connecter"}</Status>
                  {!ok && (bankConfigured() ? <BankConnect companyId={c.id} banks={banks.map((b) => b.name)} initial={bank} /> : <Link className="underline text-xs" href="/connexions">configurer la banque</Link>)}
                </li>
              );
            }
            if (it.kind === "IMAP") {
              const boxes = mine.filter((i) => ["IMAP", "GOOGLE", "OUTLOOK"].includes(i.provider));
              const ok = count(boxes.filter((b) => b.status === "OK").length >= it.count);
              return (
                <li key={k} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-56 text-sm">Boîtes mail ({boxes.length}/{it.count})</span>
                    <Status ok={ok} warn={boxes.length > 0}>{boxes.map((b) => `${b.label}${b.status === "ERROR" ? " (erreur)" : ""}`).join(", ") || `à connecter : ${it.hint}`}</Status>
                  </div>
                  {boxes.filter((b) => b.lastError).map((b) => <p key={b.id} className="text-xs text-red-700 ml-56">{b.label} : {b.lastError}</p>)}
                  {boxes.length < it.count && (
                    <form action={addIntegration} className="flex flex-wrap gap-2 items-center ml-0 sm:ml-56">
                      <input type="hidden" name="provider" value="IMAP" />
                      <input type="hidden" name="companyId" value={c.id} />
                      <input type="hidden" name="back" value="/connexions" />
                      <input name="email" type="email" required placeholder="adresse@gmail.com" className="input py-1 text-xs w-56" autoComplete="off" />
                      <input name="password" type="password" required placeholder="mot de passe d'application" className="input py-1 text-xs w-48" autoComplete="off" />
                      <button className="btn-primary text-xs">Connecter la boîte</button>
                      <a className="text-xs underline" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">créer le mot de passe d&apos;application Gmail</a>
                    </form>
                  )}
                </li>
              );
            }
            if (it.kind === "ROBOT") {
              const i = mine.find((x) => x.provider === it.provider);
              const ok = count(Boolean(i && connectedRobot(i) && i.status !== "ERROR"));
              return (
                <li key={k} className="flex flex-wrap items-center gap-2">
                  <span className="w-56 text-sm">{it.name}</span>
                  <Status ok={ok} warn={Boolean(i && connectedRobot(i))}>{ok ? `connecté${i?.lastSyncAt ? `, lu le ${i.lastSyncAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" })}` : ""}` : i?.lastError ?? "à connecter"}</Status>
                  <form action={quickConnect.bind(null, it.provider, company, undefined, undefined)}><button className="btn-primary text-xs">{ok ? "Se reconnecter" : "Se connecter"}</button></form>
                  {i && connectedRobot(i) && <form action={syncNow.bind(null, i.id)}><button className="text-xs underline">lire maintenant</button></form>}
                </li>
              );
            }
            if (it.kind === "PORTAIL") {
              const i = mine.find((x) => x.provider === "PORTAIL" && x.label === it.name);
              const ok = count(Boolean(i && connectedRobot(i) && i.status !== "ERROR"));
              return (
                <li key={k} className="flex flex-wrap items-center gap-2">
                  <span className="w-56 text-sm">{it.name} <span className="text-xs text-slate-500">({it.hint})</span></span>
                  <Status ok={ok}>{ok ? "connecté" : i?.lastError ?? "à connecter"}</Status>
                  <form action={quickConnect.bind(null, "PORTAIL", company, it.name, it.url)}><button className="btn-primary text-xs">{ok ? "Se reconnecter" : "Se connecter"}</button></form>
                </li>
              );
            }
            if (it.kind === "FOURNISSEUR") {
              const list = mine.filter((x) => x.provider === "PORTAIL" && x.label !== "Autodata");
              count(list.length > 0);
              return (
                <li key={k} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-56 text-sm">Fournisseurs (pièces, pneus...)</span>
                    <Status ok={list.length > 0}>{list.map((x) => `${x.label}${connectedRobot(x) ? "" : " (connexion à faire)"}`).join(", ") || "à ajouter"}</Status>
                  </div>
                  {list.filter((x) => !connectedRobot(x)).map((x) => (
                    <form key={x.id} action={quickConnect.bind(null, "PORTAIL", company, x.label ?? "", undefined)} className="sm:ml-56"><button className="btn-primary text-xs">Se connecter à {x.label}</button></form>
                  ))}
                  <form action={addIntegration} className="flex flex-wrap gap-2 items-center sm:ml-56">
                    <input type="hidden" name="provider" value="PORTAIL" />
                    <input type="hidden" name="companyId" value={c.id} />
                    <input type="hidden" name="back" value="/connexions" />
                    <input name="name" required placeholder="Nom du fournisseur" className="input py-1 text-xs w-44" />
                    <input name="url" type="url" required placeholder="https://adresse-de-connexion" className="input py-1 text-xs w-64" />
                    <input type="hidden" name="purpose" value="prix et disponibilité des pièces" />
                    <button className="btn-secondary text-xs">Ajouter et se connecter</button>
                  </form>
                </li>
              );
            }
            if (it.kind === "WHATSAPP") {
              const i = mine.find((x) => x.provider === "WHATSAPP");
              const ok = count(Boolean(i && i.status === "OK"));
              return (
                <li key={k} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-56 text-sm">WhatsApp{it.number ? ` ${it.number}` : ""}</span>
                    <Status ok={ok}>{ok ? i?.label ?? "connecté" : i?.lastError ?? "à connecter"}</Status>
                  </div>
                  {!ok && (
                    <details className="sm:ml-56 text-xs">
                      <summary className="cursor-pointer underline">Connecter (Meta demande une inscription unique de 20 minutes)</summary>
                      <ol className="list-decimal pl-4 space-y-1 mt-1 text-slate-600">
                        <li><a className="underline" href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">developers.facebook.com/apps</a> → Créer une application → Business → produit WhatsApp → « Ajouter un numéro »{it.number ? ` : ${it.number}` : ""} (si ce numéro est déjà sur WhatsApp Business dans le téléphone, choisissez de le garder sur l&apos;application).</li>
                        <li>Webhook : <code className="break-all">{(process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "")}/api/whatsapp</code> · jeton <code>{whatsappVerifyToken()}</code> · champ « messages ».</li>
                        <li>Puis collez ici les 3 valeurs données par Meta :</li>
                      </ol>
                      <form action={addIntegration} className="flex flex-wrap gap-2 items-center mt-1">
                        <input type="hidden" name="provider" value="WHATSAPP" />
                        <input type="hidden" name="companyId" value={c.id} />
                        <input type="hidden" name="back" value="/connexions" />
                        <input name="phoneNumberId" required placeholder="Phone number ID" className="input py-1 text-xs w-40" />
                        <input name="accessToken" type="password" required placeholder="Jeton permanent" className="input py-1 text-xs w-40" autoComplete="off" />
                        <input name="appSecret" type="password" required placeholder="Clé secrète de l'app" className="input py-1 text-xs w-40" autoComplete="off" />
                        <button className="btn-primary text-xs">Connecter WhatsApp</button>
                      </form>
                    </details>
                  )}
                </li>
              );
            }
            if (it.kind === "OUTLOOK") {
              const i = mine.find((x) => x.provider === "OUTLOOK");
              const ok = count(Boolean(i && i.status === "OK"));
              return (
                <li key={k} className="flex flex-wrap items-center gap-2">
                  <span className="w-56 text-sm">Votre Outlook personnel</span>
                  <Status ok={ok}>{ok ? i?.label ?? "connecté" : "à connecter"}</Status>
                  {!ok &&
                    (microsoftConfigured() ? (
                      <a href={`/api/microsoft/connect?companyId=${c.id}`} className="btn-primary text-xs">Se connecter avec Outlook</a>
                    ) : (
                      <span className="text-xs text-slate-600">
                        Microsoft impose une inscription unique (10 min, voir <Link href="/connexions" className="underline">Connexions → Outlook</Link>).
                        Plus simple : dans Outlook → Paramètres → Courrier → Transfert, transférez automatiquement vers une des boîtes Gmail connectées.
                      </span>
                    ))}
                </li>
              );
            }
            const gh = integrations.find((x) => x.provider === "GITHUB");
            const ok = count(Boolean(gh && gh.status === "OK"));
            return (
              <li key={k} className="flex flex-wrap items-center gap-2">
                <span className="w-56 text-sm">GitHub (vos projets)</span>
                <Status ok={ok}>{ok ? "connecté" : "à connecter"}</Status>
                {!ok && (
                  <form action={addIntegration} className="flex flex-wrap gap-2 items-center">
                    <input type="hidden" name="provider" value="GITHUB" />
                    <input type="hidden" name="companyId" value={c.id} />
                    <input type="hidden" name="back" value="/connexions" />
                    <input name="token" type="password" required placeholder="github_pat_... (lecture seule)" className="input py-1 text-xs w-56" autoComplete="off" />
                    <button className="btn-primary text-xs">Connecter</button>
                    <a className="text-xs underline" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">créer le jeton</a>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    );
  });

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold">Tout connecter <span className="text-sm font-normal text-slate-500">— {done} / {total} faites</span></h2>
        <p className="text-sm text-slate-500">
          Tout est prêt : pour chaque ligne, cliquez et entrez vos identifiants. Les mots de passe sont chiffrés et ne sont jamais
          montrés aux agents. Pour les logiciels sans connexion officielle (Auto Cerfa, GTA Pro, Autodata, fournisseurs), une fenêtre
          s&apos;ouvre : connectez-vous normalement puis cliquez « Je suis connecté ».
        </p>
      </div>
      {sections}
    </div>
  );
}
