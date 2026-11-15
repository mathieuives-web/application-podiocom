import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { isAdmin, requireUser } from "@/lib/session";
import { eur } from "@/lib/finance";
import { toggleFieldRequest } from "./actions";

export const dynamic = "force-dynamic";

const KINDS: Record<string, { label: string; color: string }> = {
  FRAIS: { label: "Frais", color: "bg-amber-100 text-amber-900" },
  BESOIN: { label: "Besoin", color: "bg-sky-100 text-sky-900" },
  INTERVENTION: { label: "Intervention", color: "bg-emerald-100 text-emerald-900" },
  AUTRE: { label: "Autre", color: "bg-slate-100 text-slate-700" },
};

export default async function TerrainPage({ searchParams }: { searchParams: Promise<{ societe?: string; type?: string; statut?: string }> }) {
  const me = await requireUser();
  const admin = isAdmin(me.role);
  const { societe, type, statut = "NOUVEAU" } = await searchParams;
  const [companies, rows, whatsapp] = await Promise.all([
    prisma.company.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.fieldRequest.findMany({
      where: { ...(societe ? { companyId: societe } : {}), ...(type ? { kind: type } : {}), ...(statut !== "TOUS" ? { status: statut } : {}) },
      include: { company: true },
      orderBy: [{ urgent: "desc" }, { createdAt: "desc" }],
      take: 300,
    }),
    prisma.integration.count({ where: { provider: "WHATSAPP" } }),
  ]);
  const frais = rows.filter((r) => r.kind === "FRAIS").reduce((s, r) => s + (r.amount ?? 0), 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap justify-between gap-3 items-end">
        <div>
          <h1 className="text-xl font-bold">Terrain</h1>
          <p className="text-sm text-slate-500">
            Ce que les salariés envoient sur le WhatsApp de leur société : frais (tickets, factures), besoins (pièces, matériel),
            interventions. L&apos;IA lit chaque photo, classe et répond « bien reçu ». Le Secrétariat et le directeur financier les traitent.
          </p>
        </div>
        <form className="flex flex-wrap gap-2">
          <select name="societe" defaultValue={societe ?? ""} className="input"><option value="">Toutes les sociétés</option>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <select name="type" defaultValue={type ?? ""} className="input"><option value="">Tous types</option>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
          <select name="statut" defaultValue={statut} className="input"><option value="NOUVEAU">À traiter</option><option value="TRAITE">Traités</option><option value="TOUS">Tous</option></select>
          <button className="btn-secondary">Voir</button>
        </form>
      </div>
      {whatsapp === 0 && (
        <p className="card text-sm bg-amber-50 border-amber-200 text-amber-900">
          Aucun numéro WhatsApp connecté : voir <Link href="/connexions" className="underline">Connexions → WhatsApp Business</Link>.
        </p>
      )}
      <p className="text-sm">{rows.length} message(s){frais ? ` · frais : ${eur(frais)}` : ""}</p>
      <section className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        {rows.map((r) => (
          <div key={r.id} className={`card space-y-2 ${r.urgent ? "border-red-300" : ""}`}>
            <div className="flex justify-between gap-2 text-xs">
              <span className={`px-2 py-0.5 rounded ${KINDS[r.kind]?.color ?? ""}`}>{KINDS[r.kind]?.label ?? r.kind}{r.urgent ? " · URGENT" : ""}</span>
              <span className="text-slate-500">{r.createdAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" })}</span>
            </div>
            <p className="text-sm font-medium">{r.summary ?? r.text ?? "—"}</p>
            <p className="text-xs text-slate-500">
              {r.fromName ?? r.fromPhone} · {r.company.name}
              {r.amount ? ` · ${eur(r.amount)}` : ""}{r.merchant ? ` · ${r.merchant}` : ""}{r.vehicle ? ` · ${r.vehicle}` : ""}
            </p>
            {r.text && r.summary && <p className="text-xs text-slate-600 italic">« {r.text.slice(0, 300)} »</p>}
            <div className="flex justify-between items-center">
              {r.documentId && admin ? <a href={`/api/documents/${r.documentId}`} target="_blank" className="text-xs underline">voir la photo</a> : <span />}
              {admin && (
                <form action={toggleFieldRequest.bind(null, r.id)}>
                  <button className="text-xs underline">{r.status === "TRAITE" ? "remettre à traiter" : "marquer traité"}</button>
                </form>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
