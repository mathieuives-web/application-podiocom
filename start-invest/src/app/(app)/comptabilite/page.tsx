import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { isAdmin, requireUser } from "@/lib/session";
import { eur, INTERNAL } from "@/lib/finance";
import { ALL_CATEGORIES, cashStatement } from "@/lib/categorization";
import { recategorize, runCategorization } from "./actions";

export const dynamic = "force-dynamic";

const MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const cell = (v: number) => (v === 0 ? <span className="text-slate-300">—</span> : Math.round(v).toLocaleString("fr-FR"));

type Statement = Awaited<ReturnType<typeof cashStatement>>;

function CategoryRows({
  title,
  rows,
  total,
  tone,
  shownMonths,
  hrefFor,
}: {
  title: string;
  rows: Statement["entrees"];
  total: Statement["totalEntrees"];
  tone: string;
  shownMonths: number[];
  hrefFor: Record<string, string>;
}) {
  return (
    <>
      <tr className="bg-slate-50"><td colSpan={shownMonths.length + 2} className={`font-semibold ${tone}`}>{title}</td></tr>
      {rows.map((r) => (
        <tr key={r.category}>
          <td className="whitespace-nowrap"><Link href={hrefFor[r.category]} className="underline decoration-slate-300">{r.category}</Link></td>
          {shownMonths.map((m) => <td key={m} className="text-right text-xs">{cell(r.months[m])}</td>)}
          <td className="text-right font-medium">{eur(r.total)}</td>
        </tr>
      ))}
      <tr className="font-semibold">
        <td>Total {title.toLowerCase()}</td>
        {shownMonths.map((m) => <td key={m} className={`text-right text-xs ${tone}`}>{cell(total.months[m])}</td>)}
        <td className={`text-right ${tone}`}>{eur(total.total)}</td>
      </tr>
    </>
  );
}

export default async function ComptabilitePage({ searchParams }: { searchParams: Promise<{ societe?: string; annee?: string; cat?: string; msg?: string }> }) {
  const me = await requireUser();
  const admin = isAdmin(me.role);
  const q = await searchParams;
  const year = Number(q.annee) || new Date().getFullYear();
  const companies = await prisma.company.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  const companyId = q.societe || undefined;
  const company = companies.find((c) => c.id === companyId);
  const st = await cashStatement(companyId, year);
  const group = await Promise.all(companies.map(async (c) => ({ c, s: await cashStatement(c.id, year) })));
  const shownMonths = st.monthsWithData.length ? Array.from({ length: Math.max(...st.monthsWithData) + 1 }, (_, i) => i) : [];
  const detail = q.cat
    ? await prisma.bankTransaction.findMany({
        where: {
          date: { gte: new Date(year, 0, 1), lt: new Date(year + 1, 0, 1) },
          account: { kind: "COURANT", excluded: false },
          ...(companyId ? { companyId } : {}),
          category: q.cat,
        },
        include: { company: { select: { name: true } } },
        orderBy: { date: "desc" },
        take: 200,
      })
    : [];
  const uncategorized = await prisma.bankTransaction.count({
    where: { account: { excluded: false }, OR: [{ category: null }, { category: "Autres dépenses" }, { category: "Encaissements clients" }, { category: "Autres entrées" }] },
  });
  const link = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const all = { societe: companyId, annee: String(year), ...extra };
    for (const [k, v] of Object.entries(all)) if (v) p.set(k, v);
    return `/comptabilite?${p}`;
  };


  const hrefFor = Object.fromEntries([...st.entrees, ...st.sorties].map((r) => [r.category, link({ cat: r.category })]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap justify-between gap-3 items-end">
        <div>
          <h1 className="text-xl font-bold">Comptabilité {year}{company ? ` — ${company.name}` : " — tout le groupe"}</h1>
          <p className="text-sm text-slate-500">
            Toutes les entrées et sorties d&apos;argent des comptes courants, classées par catégorie et par mois. Hors virements entre
            sociétés du groupe, séquestre dépôt-vente, prêts et comptes exclus.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/comptabilite?annee=${year}`} className={`btn text-xs ${!companyId ? "btn-primary" : "btn-secondary"}`}>Groupe</Link>
          {companies.map((c) => (
            <Link key={c.id} href={`/comptabilite?annee=${year}&societe=${c.id}`} className={`btn text-xs ${companyId === c.id ? "btn-primary" : "btn-secondary"}`}>{c.name}</Link>
          ))}
          <Link href={link({ annee: String(year - 1) })} className="btn-secondary text-xs">← {year - 1}</Link>
          <Link href={link({ annee: String(year + 1) })} className="btn-secondary text-xs">{year + 1} →</Link>
        </div>
      </div>
      {q.msg && <p className="card text-sm bg-sky-50 border-sky-200 text-sky-900">{q.msg}</p>}

      {admin && (
        <div className="card flex flex-wrap justify-between items-center gap-3 text-sm">
          <p>
            {uncategorized > 0
              ? <><strong>{uncategorized}</strong> opération(s) encore en catégorie générique. Lancez le classement pour que l&apos;IA les range (loyer, électricité, salaires...).</>
              : "Toutes les opérations sont classées."}
            <span className="block text-xs text-slate-500">Chaque libellé appris est classé automatiquement ensuite ; une correction manuelle est prioritaire.</span>
          </p>
          <form action={runCategorization}><button className="btn-primary" style={{ background: "#7f1d1d" }}>Classer toutes les opérations (IA)</button></form>
        </div>
      )}

      <section className="card overflow-x-auto">
        <h2 className="font-semibold mb-3">Équilibre {year} par société</h2>
        <table className="table-base">
          <thead><tr><th>Société</th><th className="text-right">Entrées</th><th className="text-right">Sorties</th><th className="text-right">Solde</th><th>Plus gros postes de dépense</th></tr></thead>
          <tbody>
            {group.map(({ c, s }) => (
              <tr key={c.id}>
                <td><Link href={`/comptabilite?annee=${year}&societe=${c.id}`} className="underline">{c.name}</Link></td>
                <td className="text-right text-emerald-700">{eur(s.totalEntrees.total)}</td>
                <td className="text-right text-red-800">{eur(s.totalSorties.total)}</td>
                <td className={`text-right font-semibold ${s.solde.total >= 0 ? "text-emerald-700" : "text-red-700"}`}>{s.solde.total >= 0 ? "✅ " : "❌ "}{eur(s.solde.total)}</td>
                <td className="text-xs text-slate-600">{s.sorties.slice(0, 3).map((x) => `${x.category} ${eur(x.total)}`).join(" · ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="font-semibold mb-3">Compte de résultat de trésorerie {year}{company ? ` — ${company.name}` : ""}</h2>
        {shownMonths.length === 0 ? (
          <p className="text-sm text-slate-400">Aucune opération sur {year}.</p>
        ) : (
          <table className="table-base text-sm">
            <thead>
              <tr><th>Catégorie</th>{shownMonths.map((m) => <th key={m} className="text-right">{MOIS[m]}</th>)}<th className="text-right">Total</th></tr>
            </thead>
            <tbody>
              <CategoryRows title="Entrées" rows={st.entrees} total={st.totalEntrees} tone="text-emerald-700" shownMonths={shownMonths} hrefFor={hrefFor} />
              <CategoryRows title="Sorties" rows={st.sorties} total={st.totalSorties} tone="text-red-800" shownMonths={shownMonths} hrefFor={hrefFor} />
              <tr className="bg-slate-900 text-white font-bold">
                <td>Solde (entrées − sorties)</td>
                {shownMonths.map((m) => <td key={m} className="text-right text-xs">{cell(st.solde.months[m])}</td>)}
                <td className="text-right">{eur(st.solde.total)}</td>
              </tr>
            </tbody>
          </table>
        )}
        {st.virementsInternesNet !== 0 && (
          <p className="text-xs text-slate-500 mt-2">Virements avec les autres sociétés du groupe (non comptés) : {eur(st.virementsInternesNet)} net.</p>
        )}
        <p className="text-xs text-slate-500 mt-1">Cliquez une catégorie pour voir et corriger ses opérations.</p>
      </section>

      {q.cat && (
        <section className="card overflow-x-auto">
          <div className="flex justify-between items-center mb-3">
            <h2 className="font-semibold">{q.cat} — {detail.length} opération(s)</h2>
            <Link href={link({ cat: undefined })} className="text-xs underline">fermer</Link>
          </div>
          <table className="table-base">
            <thead><tr><th>Date</th><th>Société</th><th>Libellé</th><th className="text-right">Montant</th>{admin && <th>Reclasser ce libellé</th>}</tr></thead>
            <tbody>
              {detail.map((t) => (
                <tr key={t.id}>
                  <td className="whitespace-nowrap text-xs">{t.date.toLocaleDateString("fr-FR")}</td>
                  <td className="text-xs">{t.company.name}</td>
                  <td className="text-xs">{t.label}</td>
                  <td className={`text-right text-xs font-medium whitespace-nowrap ${t.amount >= 0 ? "text-emerald-700" : "text-red-800"}`}>{t.amount.toLocaleString("fr-FR", { style: "currency", currency: "EUR" })}</td>
                  {admin && (
                    <td>
                      <form action={recategorize} className="flex gap-1">
                        <input type="hidden" name="label" value={t.label} />
                        <select name="category" defaultValue={t.category ?? ""} className="input py-1 text-xs">
                          {ALL_CATEGORIES.map((c) => <option key={c} value={c}>{c === INTERNAL ? "Virement interne au groupe" : c}</option>)}
                        </select>
                        <button className="text-xs underline">ok</button>
                      </form>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-slate-500 mt-2">Reclasser un libellé reclasse toutes les opérations qui ont le même libellé (et les futures).</p>
        </section>
      )}
    </div>
  );
}
