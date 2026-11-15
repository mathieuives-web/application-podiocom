import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { eur } from "@/lib/finance";
import { employeeAgentSlug } from "@/lib/agents";
import { commissionStatement, describeRule, EVENTS, leaveYear, MODES, parseRules, previousMonth, type CommissionEvent } from "@/lib/team";
import { addLeave, createEmployee, deleteLeave, markPaid, recompute, setCommissionStatus, updateEmployee } from "./actions";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { ACHAT: "Achat", VENTE: "Vente", CREDIT: "Crédit", GARANTIE: "Garantie", MANUEL: "Manuel" };
const LEAVES: Record<string, string> = { CP: "Congés payés", RTT: "RTT", MALADIE: "Maladie", SANS_SOLDE: "Sans solde", AUTRE: "Autre" };
const monthLabel = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });

export default async function EquipePage({ searchParams }: { searchParams: Promise<{ mois?: string; msg?: string }> }) {
  await requireAdmin(); // contrats, salaires et commissions : fondateur uniquement
  const { mois, msg } = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(mois ?? "") ? mois! : previousMonth();
  const [companies, employees, statement, report] = await Promise.all([
    prisma.company.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ include: { company: true, leaves: { orderBy: { start: "desc" }, take: 20 } }, orderBy: [{ active: "desc" }, { firstName: "asc" }] }),
    commissionStatement(month),
    prisma.agentRun.findFirst({ where: { kind: "COMMISSIONS" }, orderBy: { startedAt: "desc" } }),
  ]);
  const ly = leaveYear();
  const total = statement.reduce((s, e) => s + e.aVerser, 0);
  const months = Array.from({ length: 13 }, (_, i) => {
    const x = new Date();
    x.setDate(1);
    x.setMonth(x.getMonth() - i);
    return x.toISOString().slice(0, 7);
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap justify-between gap-3 items-end">
        <div>
          <h1 className="text-xl font-bold">Équipe &amp; commissions</h1>
          <p className="text-sm text-slate-500">
            Commissions calculées automatiquement à partir des contrats et des véhicules d&apos;Auto Cerfa (achat, vente, crédit, garantie),
            congés posés. Le 1er de chaque mois, le Directeur des ventes établit le relevé à verser.
          </p>
        </div>
        <div className="flex gap-2">
          <form className="flex gap-2">
            <select name="mois" defaultValue={month} className="input">
              {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
            <button className="btn-secondary">Voir</button>
          </form>
          <form action={recompute}><button className="btn-secondary">Recalculer</button></form>
        </div>
      </div>
      {msg && <p className="card text-sm bg-sky-50 border-sky-200 text-sky-900">{msg}</p>}

      <section className="card space-y-3">
        <div className="flex justify-between flex-wrap gap-2">
          <h2 className="font-semibold">À verser pour {monthLabel(month)} — {eur(total)}</h2>
          <p className="text-xs text-slate-500">« À verser » inclut les commissions des mois précédents encore non versées. Les lignes « à vérifier » ne sont pas marquées versées automatiquement.</p>
        </div>
        {statement.length === 0 ? (
          <p className="text-sm text-slate-500">Aucune commission pour ce mois. Il faut : les salariés (contrats déposés dans Archives ou ajoutés ci-dessous) et les véhicules vendus / achetés (export Auto Cerfa) avec le nom du vendeur.</p>
        ) : (
          statement.map((e) => (
            <details key={e.employeeId} className="border rounded-md p-3">
              <summary className="cursor-pointer flex flex-wrap justify-between gap-2">
                <span className="font-medium">{e.salarie} <span className="text-xs text-slate-500">· {e.societe}</span></span>
                <span className="text-sm">
                  <strong>{eur(e.aVerser)}</strong> à verser
                  {e.dontMoisPrecedents > 0 && <span className="text-xs text-slate-500"> (dont {eur(e.dontMoisPrecedents)} des mois précédents)</span>}
                  {e.dejaVerseCeMois > 0 && <span className="text-xs text-emerald-700"> · {eur(e.dejaVerseCeMois)} déjà versé</span>}
                  {e.aVerifier > 0 && <span className="text-xs text-amber-700"> · {e.aVerifier} à vérifier</span>}
                </span>
              </summary>
              <table className="table-base mt-3">
                <thead><tr><th>Mois</th><th>Type</th><th>Véhicule</th><th>Calcul</th><th className="text-right">Montant</th><th>Statut</th><th /></tr></thead>
                <tbody>
                  {e.lignes.map((l) => (
                    <tr key={l.id}>
                      <td className="text-xs">{l.mois}</td>
                      <td className="text-xs">{TYPES[l.type] ?? l.type}</td>
                      <td className="text-xs">{l.vehicule}</td>
                      <td className="text-xs">{l.calcul}{l.aVerifier && <span className="block text-amber-700">⚠ {l.aVerifier}</span>}</td>
                      <td className="text-right font-medium">{eur(l.montant)}</td>
                      <td className="text-xs">{l.statut === "VERSE" ? <span className="text-emerald-700">versée</span> : "à verser"}</td>
                      <td>
                        <form action={setCommissionStatus.bind(null, l.id, l.statut === "VERSE" ? "A_VERSER" : "VERSE")}>
                          <button className="text-xs underline">{l.statut === "VERSE" ? "annuler" : "versée"}</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {e.aVerser > 0 && (
                <form action={markPaid.bind(null, e.employeeId, month)} className="mt-2">
                  <button className="btn-primary text-xs">J&apos;ai versé les commissions de {e.salarie.split(" ")[0]}</button>
                </form>
              )}
            </details>
          ))
        )}
        {report && (
          <details className="text-sm">
            <summary className="cursor-pointer text-xs underline">
              Dernier relevé du Directeur des ventes ({report.startedAt.toLocaleDateString("fr-FR")}{report.status === "RUNNING" ? ", en cours…" : ""})
            </summary>
            <div className="whitespace-pre-wrap text-slate-700 mt-2 max-h-[32rem] overflow-y-auto">{report.output ?? report.error}</div>
          </details>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Salariés</h2>
        <div className="grid lg:grid-cols-2 gap-3">
          {employees.map((e) => {
            const rules = parseRules(e.rules);
            const taken = e.leaves.filter((l) => l.type === "CP" && l.start >= ly.start && l.start <= ly.end).reduce((s, l) => s + l.days, 0);
            return (
              <div key={e.id} className={`card space-y-3 ${e.active ? "" : "opacity-60"}`}>
                <div className="flex justify-between gap-2">
                  <div>
                    <p className="font-medium">{e.firstName} {e.lastName}</p>
                    <p className="text-xs text-slate-500">{[e.role, e.company.name, e.phone && `📱 ${e.phone}`, e.startDate && `depuis le ${e.startDate.toLocaleDateString("fr-FR")}`].filter(Boolean).join(" · ")}</p>
                  </div>
                  <Link href={`/agents?agent=${employeeAgentSlug(e)}`} className="text-xs underline whitespace-nowrap">Agent « {e.firstName} »</Link>
                </div>
                <ul className="text-xs grid grid-cols-2 gap-x-3">
                  {(Object.keys(EVENTS) as CommissionEvent[]).map((ev) => <li key={ev}><span className="text-slate-500">{TYPES[ev]} :</span> {describeRule(rules[ev])}</li>)}
                </ul>
                {e.rulesNote && <p className="text-xs text-slate-600 bg-slate-50 rounded p-2">{e.rulesNote}</p>}
                <details>
                  <summary className="text-xs underline cursor-pointer">Modifier les règles de commission</summary>
                  <form action={updateEmployee.bind(null, e.id)} className="space-y-2 mt-2 text-xs">
                    {(Object.keys(EVENTS) as CommissionEvent[]).map((ev) => {
                      const r = rules[ev];
                      return (
                        <div key={ev} className="grid grid-cols-[5rem_1fr_4.5rem_6.5rem_5.5rem] gap-1 items-center">
                          <span>{TYPES[ev]}</span>
                          <select name={`${ev}.mode`} defaultValue={r?.mode ?? "AUCUNE"} className="input py-1 text-xs">
                            {Object.entries(MODES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                          </select>
                          <input name={`${ev}.valeur`} defaultValue={r?.valeur ?? ""} placeholder="valeur" className="input py-1 text-xs" />
                          <select name={`${ev}.vehicules`} defaultValue={r?.vehicules ?? "TOUS"} className="input py-1 text-xs">
                            <option value="TOUS">Tous</option><option value="ACHAT">Achats</option><option value="DEPOT_VENTE">Dépôts-ventes</option>
                          </select>
                          <input name={`${ev}.min`} defaultValue={r?.minimum_marge ?? ""} placeholder="marge min." className="input py-1 text-xs" />
                        </div>
                      );
                    })}
                    <textarea name="rulesNote" defaultValue={e.rulesNote ?? ""} placeholder="Conditions particulières (paliers, objectifs, délai de versement...)" className="input text-xs w-full" rows={2} />
                    <div className="flex flex-wrap gap-2 items-center">
                      <label>Poste <input name="role" defaultValue={e.role ?? ""} className="input py-1 text-xs w-36" /></label>
                      <label>Portable (WhatsApp) <input name="phone" defaultValue={e.phone ?? ""} placeholder="06 12 34 56 78" className="input py-1 text-xs w-32" /></label>
                      <label>E-mail <input name="email" defaultValue={e.email ?? ""} className="input py-1 text-xs w-40" /></label>
                      <label>Congés / an <input name="leaveDaysPerYear" defaultValue={e.leaveDaysPerYear} className="input py-1 text-xs w-14" /></label>
                      <label className="flex items-center gap-1"><input type="checkbox" name="active" defaultChecked={e.active} /> actif</label>
                      <button className="btn-primary text-xs">Enregistrer</button>
                    </div>
                  </form>
                </details>
                <div className="text-xs space-y-1">
                  <p>
                    <strong>Congés payés {ly.label}</strong> : {taken} j pris sur {e.leaveDaysPerYear} — <strong>{e.leaveDaysPerYear - taken} j restants</strong>
                  </p>
                  {e.leaves.map((l) => (
                    <div key={l.id} className="flex justify-between gap-2">
                      <span>{LEAVES[l.type] ?? l.type} du {l.start.toLocaleDateString("fr-FR")} au {l.end.toLocaleDateString("fr-FR")} · {l.days} j{l.note ? ` · ${l.note}` : ""}</span>
                      <form action={deleteLeave.bind(null, l.id)}><button className="underline text-slate-500">supprimer</button></form>
                    </div>
                  ))}
                  <form action={addLeave.bind(null, e.id)} className="flex flex-wrap gap-1 items-center pt-1">
                    <input type="date" name="start" required className="input py-1 text-xs" aria-label="Du" />
                    <input type="date" name="end" required className="input py-1 text-xs" aria-label="Au" />
                    <select name="type" className="input py-1 text-xs">{Object.entries(LEAVES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                    <input name="days" placeholder="jours (auto)" className="input py-1 text-xs w-24" />
                    <input name="note" placeholder="note" className="input py-1 text-xs w-24" />
                    <button className="text-xs underline">poser</button>
                  </form>
                </div>
              </div>
            );
          })}
        </div>
        <form action={createEmployee} className="card flex flex-wrap gap-2 items-end">
          <div><label className="label">Prénom *</label><input name="firstName" required className="input" /></div>
          <div><label className="label">Nom</label><input name="lastName" className="input" /></div>
          <div><label className="label">Poste</label><input name="role" className="input" placeholder="vendeur, acheteur..." /></div>
          <div><label className="label">Portable (WhatsApp)</label><input name="phone" className="input" placeholder="06 12 34 56 78" /></div>
          <div>
            <label className="label">Société *</label>
            <select name="companyId" className="input" defaultValue={companies.find((c) => /fabrique automobile/i.test(c.name))?.id}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <button className="btn-primary">Ajouter un salarié</button>
          <p className="text-xs text-slate-500 w-full">
            Le plus simple : déposez son <strong>contrat de travail</strong> (PDF) dans <Link href="/archives" className="underline">Archives</Link> → le salarié et ses règles de commission sont créés automatiquement.
          </p>
        </form>
      </section>
    </div>
  );
}
