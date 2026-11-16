import Link from "next/link";
import { isAdmin, requireUser } from "@/lib/session";
import { eur } from "@/lib/finance";
import { groupResults, type CompanyResults } from "@/lib/results";
import { redoCompanyAction } from "./actions";

export const dynamic = "force-dynamic";

const MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-red-700" : ""}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

function Company({ r, admin }: { r: CompanyResults; admin: boolean }) {
  const b = r.banque;
  const last = r.bilans[0];
  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-lg">{r.societe}</h2>
        {admin && (
          <form action={redoCompanyAction.bind(null, r.id)}>
            <button className="btn-secondary text-xs" title="Reclasse toutes les opérations avec le métier de la société, relit Auto Cerfa / GTA Pro, puis l'agent comptable refait l'analyse complète">
              Tout refaire (agent comptable){r.remiseAPlat ? ` · dernière fois le ${new Date(r.remiseAPlat).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" })}` : ""}
            </button>
          </form>
        )}
        <p className="text-xs text-slate-500 basis-full">
          Banque : {b.comptes} compte(s){b.derniereOperation ? `, dernière opération le ${b.derniereOperation.toLocaleDateString("fr-FR")}` : ""}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi
          label={`Gagné en ${r.annee} (banque, hors prêts)`}
          value={!b.resultatConnu ? "à calculer" : b.moisCouverts ? eur(b.resultatActivite) : "—"}
          sub={b.resultatMoyenParMois !== null ? `${eur(b.resultatMoyenParMois)} / mois sur ${b.moisCouverts} mois${b.financement.remboursementsEtPrelevementsDirigeant ? ` · après emprunts et prélèvements : ${eur(b.resultatActivite - b.financement.remboursementsEtPrelevementsDirigeant)}` : ""}` : "pas d'opérations"}
          tone={!b.resultatConnu ? undefined : b.resultatActivite >= 0 ? "good" : "bad"}
        />
        <Kpi label="Entrées d'argent" value={eur(b.entrees)} />
        <Kpi label="Sorties d'argent" value={eur(b.sorties)} sub={b.stock.corrige ? `dont ${eur(b.stock.achatsVehiculesAnnee)} de véhicules achetés ; ${eur(b.stock.prixAchatDesVendus)} pour ceux vendus` : undefined} />
        <Kpi
          label={b.decouvertAutorise ? "Disponible (avec découvert)" : "Solde des comptes aujourd'hui"}
          value={eur(b.soldeActuel + b.decouvertAutorise)}
          sub={b.decouvertAutorise ? `solde ${eur(b.soldeActuel)} · découvert autorisé ${eur(b.decouvertAutorise)}` : undefined}
          tone={b.soldeActuel + b.decouvertAutorise >= 0 ? undefined : "bad"}
        />
      </div>

      {r.vehicules && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Véhicules (Auto Cerfa)</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi label="Vendus ce mois-ci" value={String(r.vehicules.vendusMois)} />
            <Kpi label={`Vendus en ${r.annee}`} value={String(r.vehicules.vendusAnnee)} sub={`dont ${r.vehicules.dontDepotVente} en dépôt-vente`} />
            <Kpi label="Marge totale (connue)" value={eur(r.vehicules.margeTotaleConnue)} sub={r.vehicules.margeMoyenne !== null ? `${eur(r.vehicules.margeMoyenne)} par véhicule` : undefined} tone="good" />
            <Kpi label="En stock" value={String(r.vehicules.enStock)} sub={`${eur(r.vehicules.valeurStockAchat)} achat + frais`} />
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {r.vehicules.financementsVendus} financement(s) et {r.vehicules.garantiesVendues} garantie(s) vendus · <Link href="/vehicules" className="underline">détail par véhicule</Link>
          </p>
        </div>
      )}

      {r.factures && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Factures clients ({r.factures.source === "GTAPRO" ? "GTA Pro" : r.factures.source})</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi label="Factures ce mois-ci" value={String(r.factures.nombreMois)} sub={eur(r.factures.montantMoisTTC) + " TTC"} />
            <Kpi label={`Factures en ${r.annee}`} value={String(r.factures.nombreAnnee)} sub={eur(r.factures.montantAnneeTTC) + " TTC"} />
            <Kpi label="Facture moyenne" value={eur(r.factures.panierMoyenTTC)} sub="TTC" />
            <Kpi label="Reste à encaisser" value={eur(r.factures.resteAEncaisser)} tone={r.factures.resteAEncaisser > 0 ? "bad" : undefined} />
          </div>
        </div>
      )}

      {(b.loyersPercus > 0 || b.loyersPayes > 0) && (
        <p className="text-sm">
          {b.loyersPercus > 0 && <>Loyers encaissés en {r.annee} : <strong>{eur(b.loyersPercus)}</strong>{b.moisCouverts ? ` (${eur(b.loyersPercus / b.moisCouverts)} / mois)` : ""}. </>}
          {b.loyersPayes > 0 && <>Loyers payés : <strong>{eur(b.loyersPayes)}</strong>.</>}
        </p>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <h3 className="text-sm font-semibold mb-1">Où part l&apos;argent ({r.annee})</h3>
          <table className="table-base text-xs">
            <tbody>
              {b.principalesDepenses.map((d) => <tr key={d.categorie}><td>{d.categorie}</td><td className="text-right tabular-nums">{eur(d.montant)}</td></tr>)}
              {!b.principalesDepenses.length && <tr><td className="text-slate-500">Aucune dépense enregistrée.</td></tr>}
            </tbody>
          </table>
          <Link href="/comptabilite" className="text-xs underline">tout le détail, mois par mois</Link>
        </div>
        {b.parMois.length > 0 && <div>
          <h3 className="text-sm font-semibold mb-1">Mois par mois (banque)</h3>
          <table className="table-base text-xs">
            <thead><tr><th>Mois</th><th className="text-right">Entrées</th><th className="text-right">Sorties</th><th className="text-right">Écart</th></tr></thead>
            <tbody>
              {b.parMois.map((m) => (
                <tr key={m.mois}><td>{MOIS[m.mois - 1]}</td><td className="text-right tabular-nums">{eur(m.entrees)}</td><td className="text-right tabular-nums">{eur(m.sorties)}</td><td className={`text-right tabular-nums ${m.solde >= 0 ? "text-emerald-700" : "text-red-700"}`}>{eur(m.solde)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>}
      </div>

      {last && (
        <p className="text-sm">
          Dernier bilan ({last.annee}) : chiffre d&apos;affaires <strong>{last.chiffreAffaires !== null ? eur(last.chiffreAffaires) : "—"}</strong>, résultat net{" "}
          <strong className={last.resultatNet !== null && last.resultatNet < 0 ? "text-red-700" : "text-emerald-700"}>{last.resultatNet !== null ? eur(last.resultatNet) : "—"}</strong>
          {r.bilans.length > 1 && <span className="text-slate-500"> · {r.bilans.slice(1).map((x) => `${x.annee} : ${x.resultatNet !== null ? eur(x.resultatNet) : "—"}`).join(" · ")}</span>}
        </p>
      )}

      {r.manques.length > 0 && (
        <ul className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 space-y-0.5">
          {r.manques.map((m) => <li key={m}>⚠️ {m}</li>)}
        </ul>
      )}
    </section>
  );
}

export default async function ResultatsPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const me = await requireUser();
  const { msg } = await searchParams;
  const admin = isAdmin(me.role);
  const year = new Date().getFullYear();
  const all = await groupResults(year);
  const total = all.reduce((s, r) => s + (r.banque.moisCouverts && r.banque.resultatConnu ? r.banque.resultatActivite : 0), 0);
  const unknown = all.filter((r) => r.banque.moisCouverts && !r.banque.resultatConnu).map((r) => r.societe);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Résultats</h1>
        <p className="text-sm text-slate-500">
          Ce que chaque société gagne réellement, calculé sur vos relevés bancaires, Auto Cerfa, GTA Pro et vos bilans. Mis à jour à chaque synchronisation.
          « Gagné » = argent entré − argent sorti, sans compter les prêts reçus, les remboursements d&apos;emprunt, vos prélèvements ni les virements entre vos sociétés.
          Pour le négoce auto, une voiture achetée n&apos;est comptée qu&apos;une fois vendue (à son prix d&apos;achat Auto Cerfa). Un solde négatif dans la limite du découvert autorisé est normal.
        </p>
        <p className="mt-2 text-sm">Groupe, {year} : <strong className={total >= 0 ? "text-emerald-700" : "text-red-700"}>{eur(total)}</strong>{unknown.length > 0 && <span className="text-amber-700"> (sans {unknown.join(", ")} : résultat à calculer)</span>}</p>
      </div>
      {msg && <p className="card text-sm bg-sky-50 border-sky-200 text-sky-900">{msg}</p>}
      {all.map((r) => <Company key={r.societe} r={r} admin={admin} />)}
    </div>
  );
}
