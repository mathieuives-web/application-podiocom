import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { financeSummary, monthlyFlows, invoiceStatus, eur } from "@/lib/finance";
import {
  createCompany, createBankAccount, importStatement, createInvoice, markInvoicePaid, reconcileNow,
  runControlNow, toggleAutoReminders, setInvoiceEmail, sendReminderNow, moveAccount, renameAccount,
} from "./actions";
import { isAdmin } from "@/lib/session";
import { loadAgents } from "@/lib/agents";
import { LEVELS, smtpConfigured } from "@/lib/reminders";

export const dynamic = "force-dynamic";

const fmt = (d: Date) => d.toLocaleDateString("fr-FR");

export default async function FinancesPage({ searchParams }: { searchParams: Promise<{ societe?: string; msg?: string }> }) {
  const user = await requireUser();
  const admin = isAdmin(user.role);
  const { societe, msg } = await searchParams;
  const companyId = societe || undefined;

  const [control, dailyRuns, reminders, agents] = await Promise.all([
    prisma.dailyControl.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.agentRun.findMany({ where: { kind: "DAILY", parentId: null }, orderBy: { startedAt: "desc" }, take: 30 }),
    prisma.reminder.findMany({
      where: companyId ? { invoice: { companyId } } : {},
      include: { invoice: { include: { company: true } } },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    loadAgents(),
  ]);
  const lastReport = (slug: string) => dailyRuns.find((r) => r.agent === slug && r.status === "DONE");
  const cfoReview = lastReport("cfo");

  const [summary, flows, companies, accounts, transactions, openInvoices] = await Promise.all([
    financeSummary({ companyId, days: 30 }),
    monthlyFlows(6, companyId),
    prisma.company.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.bankAccount.findMany({ include: { company: true }, orderBy: { name: "asc" } }),
    prisma.bankTransaction.findMany({
      where: companyId ? { companyId } : {},
      include: { company: true, account: true, invoice: true },
      orderBy: { date: "desc" },
      take: 40,
    }),
    prisma.invoice.findMany({
      where: { ...(companyId ? { companyId } : {}) },
      include: { company: true },
      orderBy: { dueDate: "asc" },
    }),
  ]);

  const unpaid = openInvoices.filter((i) => invoiceStatus(i) !== "PAYEE");
  const t = summary.total;
  const maxFlow = Math.max(1, ...flows.flatMap((f) => [f.inflow, f.outflow]));
  const categories = Object.entries(
    summary.companies.flatMap((c) => c.byCategory).reduce<Record<string, number>>((acc, x) => {
      acc[x.category] = (acc[x.category] ?? 0) + x.amount;
      return acc;
    }, {})
  ).sort((a, b) => b[1] - a[1]);
  const maxCat = Math.max(1, ...categories.map((c) => c[1]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Finances</h1>
          <p className="text-sm text-slate-500">
            Tout l&apos;argent qui entre et qui sort, toutes sociétés confondues — surveillé par le{" "}
            <Link href="/agents" className="underline">CFO IA</Link>.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <Link href="/finances" className={`btn ${!companyId ? "btn-primary" : "btn-secondary"}`}>Groupe</Link>
          {companies.map((c) => (
            <Link key={c.id} href={`/finances?societe=${c.id}`} className={`btn ${companyId === c.id ? "btn-primary" : "btn-secondary"}`}>
              {c.name}
            </Link>
          ))}
          <Link href="/connexions" className="btn-secondary">Connexions →</Link>
        </div>
      </div>

      {msg && <p className="card text-sm bg-sky-50 border-sky-200 text-sky-900">{msg}</p>}

      <section className="card space-y-4" style={{ background: "#fffdf9" }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Contrôle quotidien</h2>
            <p className="text-xs text-slate-500">
              Chaque matin : synchro des banques et de la facturation, relances automatiques, rapport du directeur financier
              de chaque société, puis contrôle par le CFO.{" "}
              {control ? (
                <>Dernier contrôle : {control.startedAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" })} —{" "}
                  <strong>{control.status === "DONE" ? "terminé" : control.status === "RUNNING" ? "en cours…" : "en erreur"}</strong></>
              ) : (
                "Pas encore lancé."
              )}
            </p>
          </div>
          {admin && <form action={runControlNow}><button className="btn-primary" style={{ background: "#7f1d1d" }}>Lancer le contrôle maintenant</button></form>}
        </div>
        {control?.log && <pre className="text-xs text-slate-600 whitespace-pre-wrap bg-slate-50 rounded p-2">{control.log}</pre>}
        {cfoReview?.output && (
          <div className="rounded border border-red-900/20 p-3">
            <p className="text-xs uppercase tracking-widest text-red-900 font-semibold mb-1">Revue du CFO — {cfoReview.startedAt.toLocaleDateString("fr-FR")}</p>
            <p className="text-sm whitespace-pre-wrap line-clamp-[12]">{cfoReview.output}</p>
            <Link href="/agents" className="text-xs underline text-slate-500">voir en entier dans le board</Link>
          </div>
        )}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {summary.companies.map((c) => {
            const daf = agents.find((a) => a.slug.startsWith("daf-") && a.structure === c.name);
            const report = daf ? lastReport(daf.slug) : undefined;
            return (
              <div key={c.id} className="rounded-lg border border-slate-200 p-3 bg-white space-y-1">
                <p className="text-xs text-slate-500"><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: c.color }} />{c.name}{daf && ` · ${daf.title}`}</p>
                {!c.hasData ? (
                  <p className="text-sm text-amber-700 font-medium">Aucune banque connectée</p>
                ) : (
                  <p className={`text-sm font-bold ${c.profitable ? "text-emerald-700" : "text-red-700"}`}>
                    {c.profitable ? "✅ Gagne de l'argent" : "❌ Perd de l'argent"} · {eur(c.net)} sur 30 j
                  </p>
                )}
                {c.hasData && <p className="text-xs text-slate-500">Mois en cours : {eur(c.monthNet)}</p>}
                {report?.output ? (
                  <p className="text-xs text-slate-700 whitespace-pre-wrap line-clamp-6 pt-1 border-t border-slate-100">{report.output}</p>
                ) : (
                  <p className="text-xs text-slate-400 pt-1 border-t border-slate-100">{daf ? "Pas encore de rapport du DAF." : "Pas de DAF pour cette société."}</p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {companies.length === 0 && (
        <p className="card text-sm bg-amber-50 border-amber-200 text-amber-900">
          Commencez par ajouter vos sociétés (bas de page), puis connectez leurs banques et logiciels dans{" "}
          <Link href="/connexions" className="underline">Connexions</Link> ou importez un relevé CSV.
        </p>
      )}

      <section className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <Kpi label="Trésorerie" value={eur(t.cash)} strong />
        <Kpi label="Entrées 30 j" value={eur(t.inflow)} tone="pos" />
        <Kpi label="Sorties 30 j" value={eur(t.outflow)} tone="neg" />
        <Kpi label="Résultat 30 j" value={eur(t.net)} tone={t.net >= 0 ? "pos" : "neg"} />
        <Kpi label="À encaisser" value={eur(t.receivables)} sub={t.receivablesLate > 0 ? `dont ${eur(t.receivablesLate)} en retard` : undefined} />
        <Kpi label="À payer" value={eur(t.payables)} />
      </section>

      <section className="grid lg:grid-cols-2 gap-4">
        <div className="card">
          <h2 className="font-semibold mb-3">Entrées / sorties sur 6 mois</h2>
          <div className="flex items-end gap-3 h-44">
            {flows.map((f) => (
              <div key={f.key} className="flex-1 flex flex-col items-center gap-1">
                <div className="flex items-end gap-1 h-36 w-full justify-center">
                  <div className="w-1/3 rounded-t bg-emerald-600" style={{ height: `${(f.inflow / maxFlow) * 100}%` }} title={`Entrées ${eur(f.inflow)}`} />
                  <div className="w-1/3 rounded-t bg-red-800" style={{ height: `${(f.outflow / maxFlow) * 100}%` }} title={`Sorties ${eur(f.outflow)}`} />
                </div>
                <span className="text-xs text-slate-500">{f.label}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-2">
            <span className="inline-block w-2 h-2 bg-emerald-600 mr-1" />entrées
            <span className="inline-block w-2 h-2 bg-red-800 ml-3 mr-1" />sorties
          </p>
        </div>
        <div className="card">
          <h2 className="font-semibold mb-3">Où part l&apos;argent (30 j)</h2>
          {categories.length === 0 && <p className="text-sm text-slate-400">Aucune dépense sur la période.</p>}
          <ul className="space-y-2">
            {categories.slice(0, 8).map(([cat, amount]) => (
              <li key={cat} className="text-sm">
                <div className="flex justify-between"><span>{cat}</span><span className="font-medium">{eur(amount)}</span></div>
                <div className="h-1.5 bg-slate-100 rounded"><div className="h-1.5 bg-red-800 rounded" style={{ width: `${(amount / maxCat) * 100}%` }} /></div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="font-semibold mb-3">Par société</h2>
        <table className="table-base">
          <thead>
            <tr><th>Société</th><th>Comptes</th><th>Trésorerie</th><th>Entrées 30 j</th><th>Sorties 30 j</th><th>À encaisser</th><th>En retard</th><th>À payer</th><th>Verdict 30 j</th><th>Dernière synchro</th></tr>
          </thead>
          <tbody>
            {summary.companies.map((c) => (
              <tr key={c.id}>
                <td><span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: c.color }} />{c.name}</td>
                <td>{c.accounts}</td>
                <td className="font-medium">{eur(c.cash)}</td>
                <td className="text-emerald-700">{eur(c.inflow)}</td>
                <td className="text-red-800">{eur(c.outflow)}</td>
                <td>{eur(c.receivables)}</td>
                <td className={c.lateInvoices ? "text-red-700 font-medium" : ""}>{c.lateInvoices ? `${c.lateInvoices} · ${eur(c.receivablesLate)}` : "—"}</td>
                <td>{eur(c.payables)}</td>
                <td className={`text-xs font-medium ${!c.hasData ? "text-slate-400" : c.profitable ? "text-emerald-700" : "text-red-700"}`}>
                  {!c.hasData ? "—" : c.profitable ? "✅ gagne" : "❌ perd"}
                </td>
                <td className="text-xs text-slate-500">{c.lastSync ? fmt(new Date(c.lastSync)) : "jamais"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="font-semibold mb-1">Comptes bancaires</h2>
        <p className="text-xs text-slate-500 mb-3">
          Une connexion bancaire peut ramener les comptes de plusieurs sociétés : rattachez chaque compte à la bonne société
          (ses opérations suivent) et donnez-lui un nom parlant.
        </p>
        <table className="table-base">
          <thead><tr><th>Compte</th><th>Banque</th><th>IBAN</th><th className="text-right">Solde</th><th>Société</th></tr></thead>
          <tbody>
            {accounts.filter((a) => !companyId || a.companyId === companyId).map((a) => (
              <tr key={a.id}>
                <td>
                  {admin ? (
                    <form action={renameAccount.bind(null, a.id)} className="flex gap-1">
                      <input name="name" defaultValue={a.name} className="input py-1 text-xs w-44" />
                      <button className="text-xs underline">ok</button>
                    </form>
                  ) : a.name}
                </td>
                <td className="text-xs">{a.bank ?? "—"}</td>
                <td className="text-xs font-mono">{a.iban ? `${a.iban.slice(0, 4)} … ${a.iban.slice(-4)}` : "—"}</td>
                <td className="text-right font-medium whitespace-nowrap">{eur(a.balance)}</td>
                <td>
                  {admin ? (
                    <form action={moveAccount.bind(null, a.id)} className="flex gap-1">
                      <select name="companyId" defaultValue={a.companyId} className="input py-1 text-xs">
                        {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                      <button className="text-xs underline">ok</button>
                    </form>
                  ) : a.company.name}
                </td>
              </tr>
            ))}
            {accounts.length === 0 && <tr><td colSpan={5} className="text-center text-slate-400 py-4">Aucun compte : connectez une banque dans Connexions.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto">
        <div className="flex justify-between items-center mb-3">
          <h2 className="font-semibold">Factures non payées</h2>
          <form action={reconcileNow}><button className="btn-secondary text-xs">Rapprocher avec la banque</button></form>
        </div>
        <table className="table-base">
          <thead><tr><th>Type</th><th>Société</th><th>N°</th><th>Tiers</th><th>E-mail (relances)</th><th>Échéance</th><th>Reste dû</th><th>Statut</th><th></th></tr></thead>
          <tbody>
            {unpaid.slice(0, 50).map((i) => {
              const s = invoiceStatus(i);
              return (
                <tr key={i.id}>
                  <td>{i.kind === "CLIENT" ? "Client" : "Fournisseur"}</td>
                  <td>{i.company.name}</td>
                  <td>{i.number ?? "—"}</td>
                  <td>{i.counterparty}</td>
                  <td>
                    {i.kind === "CLIENT" && admin ? (
                      <form action={setInvoiceEmail.bind(null, i.id)} className="flex gap-1">
                        <input name="email" type="email" defaultValue={i.counterpartyEmail ?? ""} placeholder="client@..." className="input py-1 text-xs w-40" />
                        <button className="text-xs underline">ok</button>
                      </form>
                    ) : (
                      <span className="text-xs">{i.counterpartyEmail ?? "—"}</span>
                    )}
                  </td>
                  <td>{i.dueDate ? fmt(i.dueDate) : "—"}</td>
                  <td className="font-medium">{eur(i.amount - i.paidAmount)}</td>
                  <td>
                    <span className={`text-xs px-2 py-1 rounded-full ${s === "EN_RETARD" ? "badge-expired" : "badge-warning"}`}>{s === "EN_RETARD" ? "En retard" : "À payer"}</span>
                    {i.externalReminders && <span className="block text-[11px] text-slate-500 mt-1">relancée par {i.provider === "SHINE" ? "Shine" : "le logiciel"}</span>}
                  </td>
                  <td>
                    <form action={async () => { "use server"; await markInvoicePaid(i.id); }}>
                      <button className="text-xs underline text-slate-500">marquer payée</button>
                    </form>
                  </td>
                </tr>
              );
            })}
            {unpaid.length === 0 && <tr><td colSpan={9} className="text-center text-slate-400 py-4">Aucune facture en attente.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto space-y-3">
        <div>
          <h2 className="font-semibold">Relances automatiques</h2>
          <p className="text-xs text-slate-500">
            {LEVELS.map((l) => l.label).join(" · ")}. Les relances partent par e-mail si l&apos;envoi est configuré
            {smtpConfigured() ? " (configuré ✓)" : " (non configuré : elles sont préparées en brouillon)"} et que l&apos;e-mail du client est connu.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {companies.map((c) => (
            <form key={c.id} action={toggleAutoReminders.bind(null, c.id)}>
              <button disabled={!admin} className={`text-xs rounded-full px-3 py-1 border ${c.autoReminders ? "bg-emerald-50 border-emerald-300 text-emerald-800" : "bg-slate-50 border-slate-300 text-slate-500"}`}>
                {c.name} : relances {c.autoReminders ? "activées" : "désactivées"}
              </button>
            </form>
          ))}
        </div>
        <table className="table-base">
          <thead><tr><th>Date</th><th>Société</th><th>Client</th><th>Facture</th><th>Niveau</th><th>Destinataire</th><th>Statut</th><th></th></tr></thead>
          <tbody>
            {reminders.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">{fmt(r.createdAt)}</td>
                <td>{r.invoice.company.name}</td>
                <td>{r.invoice.counterparty}</td>
                <td>{r.invoice.number ?? "—"}</td>
                <td className="text-xs">{LEVELS.find((l) => l.level === r.level)?.label}</td>
                <td className="text-xs">{r.to ?? "—"}</td>
                <td className="text-xs">
                  {r.status === "SENT" ? <span className="text-emerald-700">envoyée</span> : r.status === "ERROR" ? <span className="text-red-700">erreur</span> : <span className="text-amber-700">brouillon</span>}
                  {r.error && r.status !== "SENT" && <span className="block text-slate-400">{r.error}</span>}
                </td>
                <td>
                  {admin && r.status !== "SENT" && (
                    <details className="text-xs">
                      <summary className="cursor-pointer underline">voir / envoyer</summary>
                      <p className="font-medium mt-1">{r.subject}</p>
                      <p className="whitespace-pre-wrap text-slate-600 max-w-md">{r.body}</p>
                      <form action={sendReminderNow.bind(null, r.id)}><button className="underline mt-1">envoyer maintenant</button></form>
                    </details>
                  )}
                </td>
              </tr>
            ))}
            {reminders.length === 0 && <tr><td colSpan={8} className="text-center text-slate-400 py-4">Aucune relance pour l&apos;instant.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="font-semibold mb-3">Dernières opérations bancaires</h2>
        <table className="table-base">
          <thead><tr><th>Date</th><th>Société</th><th>Compte</th><th>Libellé</th><th>Catégorie</th><th className="text-right">Montant</th></tr></thead>
          <tbody>
            {transactions.map((tx) => (
              <tr key={tx.id}>
                <td className="whitespace-nowrap">{fmt(tx.date)}</td>
                <td>{tx.company.name}</td>
                <td>{tx.account.name}</td>
                <td>{tx.label}{tx.invoice && <span className="ml-2 text-xs text-emerald-700">✓ {tx.invoice.number ?? tx.invoice.counterparty}</span>}</td>
                <td className="text-xs text-slate-500">{tx.category}</td>
                <td className={`text-right font-medium whitespace-nowrap ${tx.amount >= 0 ? "text-emerald-700" : "text-red-800"}`}>
                  {tx.amount.toLocaleString("fr-FR", { style: "currency", currency: "EUR" })}
                </td>
              </tr>
            ))}
            {transactions.length === 0 && <tr><td colSpan={6} className="text-center text-slate-400 py-4">Aucune opération. Connectez une banque ou importez un relevé.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="grid lg:grid-cols-2 gap-4">
        <details className="card" open={companies.length === 0}>
          <summary className="cursor-pointer font-semibold">+ Ajouter une société</summary>
          <form action={createCompany} className="grid sm:grid-cols-2 gap-3 mt-4">
            <div><label className="label">Nom *</label><input name="name" className="input" required placeholder="Nouvelle société" /></div>
            <div><label className="label">Activité</label><input name="activity" className="input" placeholder="Restaurant" /></div>
            <div><label className="label">Couleur</label><input name="color" type="color" className="input h-10" defaultValue="#7f1d1d" /></div>
            <div className="sm:col-span-2"><button className="btn-primary">Ajouter</button></div>
          </form>
        </details>

        <details className="card">
          <summary className="cursor-pointer font-semibold">+ Ajouter un compte bancaire (manuel)</summary>
          <form action={createBankAccount} className="grid sm:grid-cols-2 gap-3 mt-4">
            <div>
              <label className="label">Société *</label>
              <select name="companyId" className="input" required>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </div>
            <div><label className="label">Nom du compte *</label><input name="name" className="input" required placeholder="Compte courant BNP" /></div>
            <div><label className="label">Banque</label><input name="bank" className="input" placeholder="BNP Paribas" /></div>
            <div><label className="label">Solde actuel (€)</label><input name="balance" className="input" inputMode="decimal" placeholder="0" /></div>
            <div className="sm:col-span-2"><label className="label">IBAN</label><input name="iban" className="input" /></div>
            <div className="sm:col-span-2"><button className="btn-primary" disabled={!companies.length}>Ajouter</button></div>
          </form>
        </details>

        <details className="card">
          <summary className="cursor-pointer font-semibold">⇪ Importer un relevé (CSV / Excel, toutes banques)</summary>
          <form action={importStatement} className="grid sm:grid-cols-2 gap-3 mt-4">
            <div className="sm:col-span-2">
              <label className="label">Compte *</label>
              <select name="accountId" className="input" required>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.company.name} — {a.name}</option>)}
              </select>
            </div>
            <div><label className="label">Fichier *</label><input name="file" type="file" accept=".csv,.txt,.xls,.xlsx" className="input" required /></div>
            <div><label className="label">Solde à la fin du relevé (€)</label><input name="balance" className="input" inputMode="decimal" placeholder="optionnel" /></div>
            <p className="sm:col-span-2 text-xs text-slate-500">
              Colonnes reconnues : Date, Libellé, Montant (ou Débit / Crédit). Réimporter un même relevé ne crée pas de doublon.
            </p>
            <div className="sm:col-span-2"><button className="btn-primary" disabled={!accounts.length}>Importer</button></div>
          </form>
        </details>

        <details className="card">
          <summary className="cursor-pointer font-semibold">+ Ajouter une facture</summary>
          <form action={createInvoice} className="grid sm:grid-cols-2 gap-3 mt-4">
            <div>
              <label className="label">Société *</label>
              <select name="companyId" className="input" required>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </div>
            <div>
              <label className="label">Type *</label>
              <select name="kind" className="input"><option value="CLIENT">Facture client (à encaisser)</option><option value="SUPPLIER">Facture fournisseur (à payer)</option></select>
            </div>
            <div><label className="label">Client / fournisseur *</label><input name="counterparty" className="input" required /></div>
            <div><label className="label">Numéro</label><input name="number" className="input" /></div>
            <div className="sm:col-span-2"><label className="label">E-mail du client (pour les relances automatiques)</label><input name="counterpartyEmail" type="email" className="input" /></div>
            <div><label className="label">Montant TTC (€) *</label><input name="amount" className="input" inputMode="decimal" required /></div>
            <div><label className="label">Objet</label><input name="label" className="input" /></div>
            <div><label className="label">Date d&apos;émission</label><input name="issueDate" type="date" className="input" /></div>
            <div><label className="label">Échéance</label><input name="dueDate" type="date" className="input" /></div>
            <div className="sm:col-span-2"><button className="btn-primary" disabled={!companies.length}>Ajouter</button></div>
          </form>
        </details>
      </section>
    </div>
  );
}

function Kpi({ label, value, sub, tone, strong }: { label: string; value: string; sub?: string; tone?: "pos" | "neg"; strong?: boolean }) {
  return (
    <div className={`card ${strong ? "bg-slate-900 text-white border-slate-900" : ""}`}>
      <p className={`text-xs ${strong ? "text-slate-300" : "text-slate-500"}`}>{label}</p>
      <p className={`text-lg font-bold ${tone === "pos" ? "text-emerald-700" : tone === "neg" ? "text-red-800" : ""}`}>{value}</p>
      {sub && <p className="text-xs text-red-700">{sub}</p>}
    </div>
  );
}
