import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { eur } from "@/lib/finance";
import { atelierSnapshot } from "@/lib/connectors/gtapro";
import { addAppointment, askAtelier, refuseTask, setAppointmentStatus, validateTask } from "./actions";
import { atelierTool } from "@/lib/atelier";
import type { AgentDef } from "@/lib/agents";

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
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
  const reader = { slug: "ceo", structure: "Start Invest" } as AgentDef;
  const [planning, renta, team] = await Promise.all([
    atelierTool("lister_rdv", { du: today }, reader) as Promise<{ rendezVous: { id: string; debut: string; dureeMin: number; client: string; vehicule: string | null; prestation: string; mecanicien: string | null; statut: string }[] }>,
    atelierTool("rentabilite_atelier", {}, reader) as Promise<{ periode: { du: string; au: string }; mecaniciens: { mecanicien: string; poste: string | null; heuresPresencePrevues: number; heuresPlanifieesEnRdv: number; tauxOccupationPct: number | null; rdvTermines: number; heuresDeclarees: number; tauxProductiviteDeclareePct: number | null; interventionsDeclareesWhatsApp: number }[]; aCompleter: string[] }>,
    prisma.employee.findMany({ where: { companyId: company.id, active: true }, orderBy: { firstName: "asc" } }),
  ]);
  const byDay = new Map<string, typeof planning.rendezVous>();
  for (const r of planning.rendezVous) {
    const d = r.debut.split(" ")[0];
    byDay.set(d, [...(byDay.get(d) ?? []), r]);
  }
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

      <section className="card space-y-3">
        <h2 className="font-semibold">Planning des 7 prochains jours</h2>
        {byDay.size === 0 && <p className="text-sm text-slate-500">Aucun rendez-vous noté. Notez-les ci-dessous, ou laissez le Chef d&apos;atelier et le Courrier atelier les noter à partir des mails et du WhatsApp.</p>}
        {[...byDay.entries()].map(([day, list]) => (
          <div key={day}>
            <p className="text-xs font-semibold text-slate-600 mb-1">{day}</p>
            <table className="table-base text-xs">
              <tbody>
                {list.map((r) => (
                  <tr key={r.id} className={["ANNULE", "ABSENT"].includes(r.statut) ? "opacity-50" : ""}>
                    <td className="w-14">{r.debut.split(" ")[1]}</td>
                    <td className="w-20 font-medium">{r.mecanicien ?? <span className="text-amber-700">à affecter</span>}</td>
                    <td>{r.prestation} · {r.vehicule ?? "—"} · {r.client}</td>
                    <td className="w-16 text-right">{Math.round(r.dureeMin / 6) / 10} h</td>
                    <td className="w-48">
                      <span className="mr-2">{r.statut.toLowerCase()}</span>
                      {r.statut !== "TERMINE" && (
                        <>
                          <form className="inline" action={setAppointmentStatus.bind(null, r.id, "TERMINE")}><button className="underline mr-2">terminé</button></form>
                          <form className="inline" action={setAppointmentStatus.bind(null, r.id, "ABSENT")}><button className="underline mr-2">absent</button></form>
                          <form className="inline" action={setAppointmentStatus.bind(null, r.id, "ANNULE")}><button className="underline">annuler</button></form>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        <form action={addAppointment} className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-9 gap-2 items-end text-xs pt-2 border-t">
          <label>Date<input type="date" name="date" required defaultValue={today} className="input py-1 text-xs" /></label>
          <label>Heure<input type="time" name="heure" defaultValue="08:30" className="input py-1 text-xs" /></label>
          <label>Durée (min)<input name="minutes" defaultValue="60" className="input py-1 text-xs" /></label>
          <label>Client<input name="client" required className="input py-1 text-xs" /></label>
          <label>Téléphone<input name="telephone" className="input py-1 text-xs" /></label>
          <label>Véhicule<input name="vehicule" placeholder="Clio AB-123-CD" className="input py-1 text-xs" /></label>
          <label>Prestation<input name="prestation" required className="input py-1 text-xs" /></label>
          <label>Mécanicien<select name="employeeId" className="input py-1 text-xs"><option value="">à affecter</option>{team.map((e) => <option key={e.id} value={e.id}>{e.firstName}</option>)}</select></label>
          <button className="btn-primary text-xs">Noter le RDV</button>
        </form>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="font-semibold mb-2">Rentabilité des mécaniciens ({renta.periode.du} → {renta.periode.au})</h2>
        <table className="table-base text-xs">
          <thead><tr><th>Mécanicien</th><th className="text-right">Présence prévue</th><th className="text-right">Planifié en RDV</th><th className="text-right">Occupation</th><th className="text-right">RDV terminés</th><th className="text-right">Temps déclaré</th><th className="text-right">Productivité déclarée</th><th className="text-right">Interventions WhatsApp</th></tr></thead>
          <tbody>
            {renta.mecaniciens.map((m) => (
              <tr key={m.mecanicien}>
                <td className="font-medium">{m.mecanicien} <span className="text-slate-500">{m.poste ?? ""}</span></td>
                <td className="text-right">{m.heuresPresencePrevues} h</td>
                <td className="text-right">{m.heuresPlanifieesEnRdv} h</td>
                <td className={`text-right ${m.tauxOccupationPct !== null && m.tauxOccupationPct < 70 ? "text-amber-700" : ""}`}>{m.tauxOccupationPct ?? "—"} %</td>
                <td className="text-right">{m.rdvTermines}</td>
                <td className="text-right">{m.heuresDeclarees} h</td>
                <td className="text-right">{m.tauxProductiviteDeclareePct ?? "—"} %</td>
                <td className="text-right">{m.interventionsDeclareesWhatsApp}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {renta.aCompleter.length > 0 && <ul className="text-xs text-slate-500 mt-2 list-disc pl-4">{renta.aCompleter.map((x) => <li key={x}>{x}</li>)}</ul>}
      </section>

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
