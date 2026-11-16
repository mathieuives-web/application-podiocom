import { prisma } from "@/lib/prisma";
import { isAdmin, requireUser } from "@/lib/session";
import QRCode from "qrcode";
import { decryptJson } from "@/lib/crypto";
import { totpUri } from "@/lib/totp";
import { changeMyPassword, confirmTotp, createRecoveryCodes, createUser, removePasskey, resetUserTotp, startTotpSetup, toggleUser } from "./actions";
import PasskeyRegister from "./PasskeyRegister";
import RecoveryCodes from "./RecoveryCodes";
import { recoveryCodesLeft } from "@/lib/recovery";

export const dynamic = "force-dynamic";

export default async function AccesPage({ searchParams }: { searchParams: Promise<{ msg?: string; setup?: string }> }) {
  const me = await requireUser();
  const { msg, setup } = await searchParams;
  const admin = isAdmin(me.role);
  const users = admin ? await prisma.user.findMany({ orderBy: { createdAt: "asc" } }) : [];
  const logs = admin ? await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 100 }) : [];
  const meDb = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
  const passkeys = await prisma.passkey.findMany({ where: { userId: me.id }, orderBy: { createdAt: "asc" } });
  const codesLeft = await recoveryCodesLeft(me.id);
  let qr: string | null = null;
  let secret: string | null = null;
  if (setup && meDb.totpSecret && !meDb.totpEnabled) {
    secret = decryptJson<{ secret: string }>(meDb.totpSecret).secret;
    qr = await QRCode.toDataURL(totpUri(secret, meDb.email), { margin: 1, width: 220 });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Accès</h1>
        <p className="text-sm text-slate-500">Votre mot de passe{admin && " et les comptes des personnes autorisées (associés, expert-comptable...)"}.</p>
      </div>
      {msg && <p className="card text-sm bg-sky-50 border-sky-200 text-sky-900">{msg}</p>}

      <section className={`card space-y-3 ${passkeys.length ? "" : "border-emerald-300 bg-emerald-50"}`}>
        <h2 className="font-semibold">Connexion par Face ID / empreinte {passkeys.length ? "✅ activée" : ""}</h2>
        <p className="text-sm text-slate-600">
          Activez-la sur chaque appareil (téléphone, ordinateur) : ensuite, un seul geste suffit pour vous connecter (visage, empreinte ou
          code de déverrouillage du téléphone). Plus sûr qu&apos;un mot de passe : la clé ne quitte jamais l&apos;appareil et ne marche pas sur un faux site.
        </p>
        <PasskeyRegister />
        {passkeys.length > 0 && (
          <ul className="text-sm divide-y">
            {passkeys.map((p) => (
              <li key={p.id} className="py-1.5 flex justify-between gap-2">
                <span>{p.name} · ajouté le {p.createdAt.toLocaleDateString("fr-FR")}{p.lastUsedAt ? ` · utilisé le ${p.lastUsedAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" })}` : ""}</span>
                <form action={removePasskey.bind(null, p.id)}><button className="text-xs underline text-red-600">retirer</button></form>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-slate-500">Téléphone perdu : retirez-le ici depuis un autre appareil.</p>
      </section>

      <section className={`card space-y-3 ${codesLeft ? "" : "border-amber-300 bg-amber-50"}`}>
        <h2 className="font-semibold">Codes de secours (mot de passe oublié) {codesLeft ? "✅" : "⚠️"}</h2>
        <RecoveryCodes action={createRecoveryCodes} left={codesLeft} />
      </section>

      <section className={`card space-y-3 ${meDb.totpEnabled || passkeys.length ? "" : "border-amber-300 bg-amber-50"}`}>
        <h2 className="font-semibold">Double authentification {meDb.totpEnabled ? "✅ activée" : "⚠️ non activée"}</h2>
        {meDb.totpEnabled ? (
          <p className="text-sm text-slate-600">Un code à 6 chiffres de votre application d&apos;authentification est demandé à chaque connexion.</p>
        ) : qr && secret ? (
          <div className="flex flex-wrap gap-6 items-start">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="QR code à scanner" width={220} height={220} className="rounded border bg-white" />
            <div className="space-y-3 text-sm max-w-md">
              <ol className="list-decimal pl-4 space-y-1 text-slate-700">
                <li>Installez <strong>Google Authenticator</strong>, <strong>Microsoft Authenticator</strong> ou <strong>Authy</strong> sur votre téléphone.</li>
                <li>Scannez ce QR code (ou saisissez la clé : <code className="break-all">{secret}</code>).</li>
                <li>Entrez le code à 6 chiffres affiché pour confirmer.</li>
              </ol>
              <form action={confirmTotp} className="flex gap-2">
                <input name="code" inputMode="numeric" maxLength={6} className="input tracking-widest w-32" placeholder="123456" required />
                <button className="btn-primary">Activer</button>
              </form>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-amber-900">
              Obligatoire pour le fondateur : sans elle, l&apos;accès aux banques, aux documents et aux agents est bloqué.
              Même si quelqu&apos;un vole votre mot de passe, il ne pourra pas se connecter sans votre téléphone.
            </p>
            <form action={startTotpSetup}><button className="btn-primary">Activer la double authentification</button></form>
          </>
        )}
      </section>

      <form action={changeMyPassword} className="card grid sm:grid-cols-3 gap-3 items-end">
        <div><label className="label">Mot de passe actuel</label><input name="current" type="password" className="input" required /></div>
        <div><label className="label">Nouveau mot de passe</label><input name="next" type="password" minLength={12} className="input" required /></div>
        <button className="btn-primary">Changer mon mot de passe</button>
      </form>

      {admin && (
        <>
          <section className="card overflow-x-auto">
            <h2 className="font-semibold mb-3">Comptes</h2>
            <table className="table-base">
              <thead><tr><th>Nom</th><th>Email</th><th>Rôle</th><th>Double auth.</th><th>État</th><th></th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.email}</td>
                    <td>{u.role === "ADMIN" ? "Fondateur (tous les droits)" : "Membre (consultation)"}</td>
                    <td>
                      {u.totpEnabled ? "✅" : "—"}
                      {u.totpEnabled && u.id !== me.id && (
                        <form action={async () => { "use server"; await resetUserTotp(u.id); }} className="inline">
                          <button className="text-xs underline ml-2">réinitialiser</button>
                        </form>
                      )}
                    </td>
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
              <div><label className="label">Mot de passe provisoire *</label><input name="password" type="password" minLength={12} className="input" required /></div>
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
          <section className="card overflow-x-auto">
            <h2 className="font-semibold mb-1">Journal de sécurité</h2>
            <p className="text-xs text-slate-500 mb-3">Les 100 dernières actions sensibles : connexions, échecs, accès bancaires, documents, comptes.</p>
            <table className="table-base">
              <thead><tr><th>Date</th><th>Qui</th><th>Action</th><th>Détail</th></tr></thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="whitespace-nowrap text-xs">{l.createdAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}</td>
                    <td className="text-xs">{l.userEmail ?? "—"}</td>
                    <td className={`text-xs ${/echec|bloquee/.test(l.action) ? "text-red-700 font-medium" : ""}`}>{l.action.replace(/_/g, " ")}</td>
                    <td className="text-xs text-slate-500">{l.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
