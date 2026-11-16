import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { eur } from "@/lib/finance";
import { atelierSnapshot } from "@/lib/connectors/gtapro";
import { askAtelier, refuseTask, validateTask } from "./actions";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { BROUILLON: "À valider", VALIDE: "Validé, en attente du robot", EN_COURS: "Saisie en cours…", FAIT: "Saisi dans GTA Pro", ERREUR: "Erreur", REFUSE: "Refusé" };
type Line = { type: string; designation: string; reference?: string; quantite: number; prix_unitaire_ht: number; source?: string };
type Payload = { client?: { nom?: string; telephone?: string }; vehicule?: { immatriculation?: string; marque?: string; modele?: string; kilometrage?: number }; lignes?: Line[]; remarques?: string; total_ht?: number };

export default async function AtelierPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  await requireAdmin();
  const { msg } = await searchParams;
  const company = await prisma.company.findFirst({ where: { name: "Auto Rac Ives" } });
  if (!company) return <p className="card">Société Auto Rac Ives introuvable.</p>;
  const [tasks, integ, snap, invoices] = await Promise.all([
    prisma.robotTask.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "desc" }, take: 60 }),
    prisma.integration.findFirst({ where: { provider: "GTAPRO", companyId: company.id } }),
    atelierSnapshot(company.id),
    prisma.invoice.findMany({ where: { companyId: company.id, provider: "GTAPRO" }, orderBy: { issueDate: "desc" }, take: 300 }),
  ]);
  const unpaid = invoices.filter((i) => i.amount - i.paidAmount > 0.01);
  const working = tasks.some((t) => ["VALIDE", "EN_COURS"].includes(t.status));

  return (
    <div className="space-y-6">
      {working && <meta httpEquiv="refresh" content="10" />}
      <div>
        <h1 className="text-xl font-bold">Atelier Auto Rac&apos;Ives</h1>
        <p className="text-sm text-slate-500">
          Devis et ordres de réparation préparés par l&apos;agent, validés par vous, saisis par le robot dans GTA Pro. Paiements contrôlés
          à partir des factures GTA Pro (lues plusieurs fois par jour).
        </p>
      </div>
      {msg && <p className="card text-sm bg-sky-50 border-sky-200 text-sky-900">{msg}</p>}
      {!integ && (
        <p className="card text-sm bg-amber-50 border-amber-200 text-amber-900">
          GTA Pro n&apos;est pas connecté : <Link href="/connexions" className="underline">Connexions → GTA Pro</Link> (société Auto Rac Ives), puis « se connecter moi-même ».
        </p>
      )}
      {integ?.lastError && <p className="card text-sm bg-red-50 border-red-200 text-red-900">GTA Pro : {integ.lastError}</p>}

      <form action={askAtelier} className="card space-y-2">
        <h2 className="font-semibold">Demander un devis ou un OR</h2>
        <textarea name="demande" rows={3} required className="input w-full text-sm" placeholder="Ex. : M. Dupont 06 12 34 56 78, Clio 3 1.5 dCi AB-123-CD, 142 000 km : vidange + filtres, plaquettes avant, diagnostic voyant moteur." />
        <div className="flex gap-2 items-center">
          <select name="type" className="input w-40"><option value="DEVIS">Devis</option><option value="OR">Ordre de réparation</option></select>
          <button className="btn-primary">Préparer</button>
          <span className="text-xs text-slate-500">L&apos;agent prépare le brouillon ; rien n&apos;est saisi dans GTA Pro sans votre validation.</span>
        </div>
      </form>

      <section className="space-y-3">
        <h2 className="font-semibold">Documents préparés</h2>
        {tasks.length === 0 && <p className="text-sm text-slate-500">Aucun pour l&apos;instant.</p>}
        {tasks.map((t) => {
          const p = JSON.parse(t.payload) as Payload;
          return (
            <div key={t.id} className={`card space-y-2 ${t.status === "BROUILLON" ? "border-amber-300" : ""}`}>
              <div className="flex flex-wrap justify-between gap-2">
                <div>
                  <p className="font-medium">{t.title}</p>
                  <p className="text-xs text-slate-500">
                    {STATUS[t.status] ?? t.status} · préparé par {t.createdBy ?? "—"} le {t.createdAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" })}
                    {t.validatedBy && ` · validé par ${t.validatedBy}`}
                  </p>
                </div>
                <div className="flex gap-2">
                  {["BROUILLON", "ERREUR"].includes(t.status) && (
                    <form action={validateTask.bind(null, t.id)}><button className="btn-primary text-xs" style={{ background: "#047857" }}>{t.status === "ERREUR" ? "Relancer la saisie" : "Valider et saisir dans GTA Pro"}</button></form>
                  )}
                  {t.status === "BROUILLON" && <form action={refuseTask.bind(null, t.id)}><button className="btn-secondary text-xs">Refuser</button></form>}
                </div>
              </div>
              <p className="text-xs">
                <strong>Client :</strong> {p.client?.nom} {p.client?.telephone ?? ""} · <strong>Véhicule :</strong> {[p.vehicule?.marque, p.vehicule?.modele, p.vehicule?.immatriculation].filter(Boolean).join(" ")}
                {p.vehicule?.kilometrage ? ` · ${p.vehicule.kilometrage.toLocaleString("fr-FR")} km` : ""}
              </p>
              <table className="table-base text-xs">
                <thead><tr><th>Type</th><th>Désignation</th><th className="text-right">Qté</th><th className="text-right">PU HT</th><th className="text-right">Total HT</th><th>Source</th></tr></thead>
                <tbody>
                  {(p.lignes ?? []).map((l, i) => (
                    <tr key={i}><td>{l.type === "MAIN_OEUVRE" ? "Main-d'œuvre" : l.type === "PIECE" ? "Pièce" : "Forfait"}</td><td>{l.designation}{l.reference ? ` (${l.reference})` : ""}</td><td className="text-right">{l.quantite}</td><td className="text-right">{eur(l.prix_unitaire_ht)}</td><td className="text-right">{eur(l.quantite * l.prix_unitaire_ht)}</td><td className={!l.prix_unitaire_ht || /compl/i.test(l.source ?? "") ? "text-red-700 font-medium" : "text-slate-500"}>{l.source ?? "—"}</td></tr>
                  ))}
                  <tr><td colSpan={4} className="text-right font-medium">Total HT</td><td className="text-right font-medium">{eur(p.total_ht ?? 0)}</td><td /></tr>
                </tbody>
              </table>
              {p.remarques && <p className="text-xs text-slate-600">Remarques : {p.remarques}</p>}
              {t.result && <p className="text-xs text-emerald-700">Robot : {t.result}</p>}
              {t.error && <p className="text-xs text-red-700">{t.error}</p>}
              {t.documentId && <a href={`/api/documents/${t.documentId}`} target="_blank" className="text-xs underline">capture de fin de saisie</a>}
            </div>
          );
        })}
      </section>

      <section className="grid lg:grid-cols-2 gap-4">
        <div className="card overflow-x-auto">
          <h2 className="font-semibold mb-2">Factures GTA Pro non réglées ({unpaid.length}) — {eur(unpaid.reduce((s, i) => s + i.amount - i.paidAmount, 0))}</h2>
          <table className="table-base text-xs">
            <thead><tr><th>N°</th><th>Client</th><th>Date</th><th className="text-right">Reste dû</th></tr></thead>
            <tbody>{unpaid.slice(0, 60).map((i) => <tr key={i.id}><td>{i.number}</td><td>{i.counterparty}</td><td>{i.issueDate.toLocaleDateString("fr-FR")}</td><td className="text-right">{eur(i.amount - i.paidAmount)}</td></tr>)}</tbody>
          </table>
          <p className="text-xs text-slate-500 mt-2">Les relances automatiques et le rapprochement bancaire se règlent dans <Link href="/finances" className="underline">Finances</Link>.</p>
        </div>
        <div className="card overflow-x-auto">
          <h2 className="font-semibold mb-2">Devis et OR dans GTA Pro{snap ? ` (lus le ${new Date(snap.lu).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" })})` : ""}</h2>
          <table className="table-base text-xs">
            <thead><tr><th>Type</th><th>N°</th><th>Client</th><th>Véhicule</th><th className="text-right">Montant</th><th>Statut</th></tr></thead>
            <tbody>{(snap?.documents ?? []).slice(0, 80).map((d, i) => <tr key={i}><td>{d.type}</td><td>{d.numero}</td><td>{d.client}</td><td>{d.vehicule ?? "—"}</td><td className="text-right">{d.montant_ttc === null ? "—" : eur(d.montant_ttc)}</td><td>{d.statut ?? "—"}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
