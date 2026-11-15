import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { isAdmin, requireUser } from "@/lib/session";
import { DOC_TYPES } from "@/lib/documents";
import { eur } from "@/lib/finance";
import { launchAnalysis, removeDocument, reprocessDocument, uploadDocuments } from "./actions";
import { loadAgents } from "@/lib/agents";
import { agentsConfigured } from "@/lib/agent-runtime";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { PENDING: "en attente", PROCESSING: "lecture en cours…", DONE: "traité", ERROR: "erreur" };
const size = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} Mo` : `${Math.ceil(n / 1024)} Ko`);
/** Une analyse lancée il y a moins de 30 minutes et non terminée est considérée en cours. */
function isRunning(run?: { status: string; startedAt: Date } | null) {
  return Boolean(run && run.status === "RUNNING" && run.startedAt.getTime() > Date.now() - 30 * 60 * 1000);
}

const v = (n: number | null) => (n === null ? "—" : eur(n));

export default async function ArchivesPage({ searchParams }: { searchParams: Promise<{ msg?: string; societe?: string }> }) {
  const me = await requireUser();
  const admin = isAdmin(me.role);
  const { msg, societe } = await searchParams;
  const [agents, memories, analyses] = await Promise.all([
    loadAgents(),
    prisma.agentMemory.findMany(),
    prisma.agentRun.findMany({ where: { kind: "ANALYSIS" }, orderBy: { startedAt: "desc" }, take: 50 }),
  ]);
  const [companies, accounts, documents, statements] = await Promise.all([
    prisma.company.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.bankAccount.findMany({ include: { company: true }, orderBy: { name: "asc" } }),
    prisma.document.findMany({
      where: societe ? { companyId: societe } : {},
      include: { company: true },
      orderBy: { createdAt: "desc" },
      take: 300,
    }),
    prisma.financialStatement.findMany({ include: { company: true }, orderBy: [{ companyId: "asc" }, { year: "desc" }] }),
  ]);
  const working =
    documents.some((d) => d.status === "PENDING" || d.status === "PROCESSING") ||
    analyses.some((a) => isRunning(a));
  const thisYear = new Date().getFullYear();

  return (
    <div className="space-y-6">
      {working && <meta httpEquiv="refresh" content="8" />}
      <div>
        <h1 className="text-xl font-bold">Archives</h1>
        <p className="text-sm text-slate-500">
          Bilans, relevés bancaires et exports de factures de chaque société. Les fichiers sont <strong>chiffrés</strong> sur le
          serveur ; l&apos;IA les lit pour donner aux directeurs financiers et au CFO l&apos;historique de chaque société.
        </p>
      </div>
      {msg && <p className="card text-sm bg-sky-50 border-sky-200 text-sky-900">{msg}</p>}

      {admin && (
        <form action={uploadDocuments} className="card grid sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
          <div>
            <label className="label">Société *</label>
            <select name="companyId" className="input" required>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Type *</label>
            <select name="type" className="input" required>
              {Object.entries(DOC_TYPES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Exercice (pour un bilan)</label>
            <input name="year" type="number" min={1990} max={thisYear} className="input" placeholder={String(thisYear - 1)} />
          </div>
          <div>
            <label className="label">Compte (pour un relevé)</label>
            <select name="accountId" className="input" defaultValue="">
              <option value="">—</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.company.name} — {a.name}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <label className="label">Fichiers * (PDF, CSV, Excel — plusieurs à la fois, 30 Mo max chacun)</label>
            <input name="files" type="file" multiple accept=".pdf,.csv,.txt,.xls,.xlsx" className="input" required />
          </div>
          <button className="btn-primary" style={{ background: "#7f1d1d" }}>Déposer</button>
          <p className="sm:col-span-2 lg:col-span-4 text-xs text-slate-500">
            <strong>Bilans</strong> (PDF) : l&apos;IA extrait CA, marges, résultat, trésorerie, dettes… pour chaque exercice.{" "}
            <strong>Relevés</strong> (PDF ou CSV/Excel) : les opérations sont importées dans le compte choisi, sans doublon avec Shine.{" "}
            Pas encore de compte pour une banque ? Créez-le dans{" "}
            <Link href="/finances" className="underline">Finances → Ajouter un compte bancaire</Link>.{" "}
            <strong>Factures</strong> : export CSV/Excel de n&apos;importe quel logiciel (colonnes Client, Montant TTC, et si possible Numéro, Date, Échéance, Statut, E-mail).
          </p>
        </form>
      )}

      <section className="space-y-3">
        <div>
          <h2 className="font-semibold">Ce que les directeurs financiers savent de chaque société</h2>
          <p className="text-xs text-slate-500">
            Après chaque dépôt, le directeur financier de la société analyse tout l&apos;historique et le mémorise. Chaque matin, il complète
            sa mémoire avec ce qu&apos;il apprend.
          </p>
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          {companies.map((c) => {
            const daf = agents.find((a) => a.slug.startsWith("daf-") && a.structure === c.name);
            if (!daf) return null;
            const mem = memories.find((m) => m.agent === daf.slug);
            const last = analyses.find((a) => a.agent === daf.slug);
            const running = isRunning(last);
            return (
              <div key={c.id} className="card space-y-2">
                <div className="flex justify-between items-start gap-2">
                  <div>
                    <p className="font-medium">{c.name}</p>
                    <p className="text-xs text-slate-500">
                      {daf.title}
                      {last && ` · dernière analyse ${last.startedAt.toLocaleDateString("fr-FR")} (${running ? "en cours…" : last.status === "DONE" ? "terminée" : "erreur"})`}
                    </p>
                  </div>
                  {admin && (
                    <form action={launchAnalysis.bind(null, c.id)}>
                      <button className="btn-secondary text-xs" disabled={running || !agentsConfigured()}>
                        {running ? "Analyse en cours…" : "Analyse complète"}
                      </button>
                    </form>
                  )}
                </div>
                {last?.output && (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-xs underline">Voir le diagnostic complet</summary>
                    <div className="whitespace-pre-wrap text-slate-700 mt-2 max-h-96 overflow-y-auto">{last.output}</div>
                  </details>
                )}
                {last?.error && <p className="text-xs text-red-700">{last.error}</p>}
                <div className="text-xs text-slate-600 whitespace-pre-wrap bg-slate-50 rounded p-2 max-h-48 overflow-y-auto">
                  {mem?.content ?? "Mémoire vide : déposez les bilans et relevés de la société."}
                </div>
                {mem && <p className="text-[11px] text-slate-400">Mémoire mise à jour le {mem.updatedAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}</p>}
              </div>
            );
          })}
        </div>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="font-semibold mb-3">Historique financier (extrait des bilans)</h2>
        <table className="table-base">
          <thead>
            <tr><th>Société</th><th>Exercice</th><th>CA</th><th>EBE</th><th>Résultat net</th><th>Capitaux propres</th><th>Trésorerie</th><th>Dettes financières</th></tr>
          </thead>
          <tbody>
            {statements.map((s) => (
              <tr key={s.id}>
                <td>{s.company.name}</td>
                <td>{s.year}</td>
                <td>{v(s.revenue)}</td>
                <td>{v(s.ebitda)}</td>
                <td className={s.netIncome !== null && s.netIncome < 0 ? "text-red-700" : "text-emerald-700"}>{v(s.netIncome)}</td>
                <td>{v(s.equity)}</td>
                <td>{v(s.cash)}</td>
                <td>{v(s.debt)}</td>
              </tr>
            ))}
            {statements.length === 0 && <tr><td colSpan={8} className="text-center text-slate-400 py-4">Déposez les bilans pour voir l&apos;historique.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto">
        <div className="flex flex-wrap gap-2 mb-3 items-center">
          <h2 className="font-semibold mr-2">Documents</h2>
          <Link href="/archives" className={`btn text-xs ${!societe ? "btn-primary" : "btn-secondary"}`}>Toutes</Link>
          {companies.map((c) => (
            <Link key={c.id} href={`/archives?societe=${c.id}`} className={`btn text-xs ${societe === c.id ? "btn-primary" : "btn-secondary"}`}>{c.name}</Link>
          ))}
        </div>
        <table className="table-base">
          <thead><tr><th>Déposé le</th><th>Société</th><th>Type</th><th>Fichier</th><th>État</th><th>Résultat</th><th></th></tr></thead>
          <tbody>
            {documents.map((d) => (
              <tr key={d.id}>
                <td className="whitespace-nowrap text-xs">{d.createdAt.toLocaleDateString("fr-FR")}</td>
                <td>{d.company.name}</td>
                <td className="text-xs">{DOC_TYPES[d.type as keyof typeof DOC_TYPES] ?? d.type}{d.year ? ` ${d.year}` : ""}</td>
                <td className="text-xs">
                  {admin ? <a href={`/api/documents/${d.id}`} className="underline">{d.fileName}</a> : d.fileName}
                  <span className="text-slate-400"> · {size(d.size)}</span>
                </td>
                <td className={`text-xs ${d.status === "ERROR" ? "text-red-700" : d.status === "DONE" ? "text-emerald-700" : "text-amber-700"}`}>{STATUS[d.status] ?? d.status}</td>
                <td className="text-xs text-slate-600 max-w-md">{d.error ?? d.summary ?? ""}</td>
                <td className="whitespace-nowrap">
                  {admin && (
                    <>
                      {(d.status === "ERROR" || d.status === "DONE") && (
                        <form action={reprocessDocument.bind(null, d.id)} className="inline"><button className="text-xs underline mr-2">relire</button></form>
                      )}
                      <form action={removeDocument.bind(null, d.id)} className="inline"><button className="text-xs underline text-red-600">supprimer</button></form>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {documents.length === 0 && <tr><td colSpan={7} className="text-center text-slate-400 py-4">Aucun document.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
