import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { isAdmin, requireUser } from "@/lib/session";
import { eur } from "@/lib/finance";
import { daysInStock, vehicleMargin, vehicleSummary } from "@/lib/vehicles";
import { updateVehicle } from "./actions";

export const dynamic = "force-dynamic";

const d = (x: Date | null) => (x ? x.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" }) : "—");
const m = (n: number | null) => (n === null ? <span className="text-amber-700 text-xs">inconnue</span> : <span className={n < 0 ? "text-red-700 font-medium" : "text-emerald-700 font-medium"}>{eur(n)}</span>);
const money = (n: number | null) => (n === null ? "—" : eur(n));

export default async function VehiculesPage({ searchParams }: { searchParams: Promise<{ societe?: string; vue?: string }> }) {
  const me = await requireUser();
  const admin = isAdmin(me.role);
  const { societe, vue = "stock" } = await searchParams;
  const companies = await prisma.company.findMany({ where: { active: true }, orderBy: { name: "asc" }, include: { _count: { select: { vehicles: true } } } });
  const company = companies.find((c) => c.id === societe) ?? companies.find((c) => c._count.vehicles > 0) ?? companies.find((c) => /fabrique automobile/i.test(c.name));
  if (!company) return <p className="card">Aucune société.</p>;
  const [summary, vehicles, employees] = await Promise.all([
    vehicleSummary(company.id, 12),
    prisma.vehicle.findMany({
      where: { companyId: company.id, ...(vue === "stock" ? { status: "STOCK" } : { status: "VENDU" }) },
      include: { seller: true, buyer: true },
      orderBy: vue === "stock" ? { entryDate: "asc" } : { saleDate: "desc" },
      take: 500,
    }),
    prisma.employee.findMany({ where: { companyId: company.id, active: true }, orderBy: { firstName: "asc" } }),
  ]);
  const st = summary.stock;
  const ve = summary.ventes;
  const tab = (key: string, label: string) => (
    <Link href={`/vehicules?societe=${company.id}&vue=${key}`} className={`px-3 py-1.5 rounded-md text-sm ${vue === key ? "bg-slate-900 text-white" : "bg-white border"}`}>{label}</Link>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap justify-between gap-3 items-end">
        <div>
          <h1 className="text-xl font-bold">Véhicules</h1>
          <p className="text-sm text-slate-500">
            Stock et ventes importés d&apos;Auto Cerfa : achats et dépôts-ventes, frais, marge réelle par véhicule, jours en stock.
            Mise à jour : déposez l&apos;export Excel d&apos;Auto Cerfa dans <Link href="/archives" className="underline">Archives</Link> (type « Export Auto Cerfa »).
          </p>
        </div>
        <form className="flex gap-2">
          <select name="societe" defaultValue={company.id} className="input">
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input type="hidden" name="vue" value={vue} />
          <button className="btn-secondary">Voir</button>
        </form>
      </div>

      <section className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3">
        <Kpi label="En stock" value={String(st.total)} sub={`${st.achats} achat(s) · ${st.depotsVente} dépôt(s)-vente`} />
        <Kpi label="Stock acheté (achat + frais)" value={eur(st.valeurAchatImmobilisee)} />
        <Kpi label="+ de 90 jours" value={String(st.plusDe90Jours.length)} tone={st.plusDe90Jours.length ? "neg" : undefined} />
        <Kpi label="Ventes 12 mois" value={String(ve.nombre)} sub={eur(ve.chiffreAffaires)} />
        <Kpi label="Marge réelle 12 mois" value={eur(ve.margeTotale)} sub={ve.margeInconnue ? `${ve.margeInconnue} vente(s) sans marge calculable` : undefined} tone={ve.margeTotale >= 0 ? "pos" : "neg"} />
        <Kpi label="Marge moyenne / véhicule" value={ve.margeMoyenne === null ? "—" : eur(ve.margeMoyenne)} />
        <Kpi label="Crédits · garanties" value={`${ve.creditsVendus} · ${ve.garantiesVendues}`} sub={ve.dureeMoyenneEnStock !== null ? `${ve.dureeMoyenneEnStock} j en stock en moyenne` : undefined} />
      </section>

      <div className="flex gap-2">{tab("stock", `En stock (${st.total})`)}{tab("vendus", "Vendus")}</div>

      <section className="card overflow-x-auto">
        {vehicles.length === 0 ? (
          <p className="text-sm text-slate-500">
            Aucun véhicule pour l&apos;instant. Dans Auto Cerfa : <strong>Stock → Export Excel</strong> (stock complet), et l&apos;export des ventes ou
            l&apos;export comptable mensuel pour les véhicules vendus, puis déposez les fichiers dans Archives.
          </p>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Véhicule</th><th>Type</th><th>Entrée</th>{vue !== "stock" && <th>Vente</th>}<th className="text-right">Jours</th>
                <th className="text-right">Achat</th><th className="text-right">Frais</th>
                <th className="text-right">{vue === "stock" ? "Prix affiché" : "Prix de vente"}</th>
                {vue !== "stock" && <><th className="text-right">Marge réelle</th><th>Crédit / garantie</th></>}
                <th>Acheteur</th>{vue !== "stock" && <th>Vendeur</th>}{admin && <th />}
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => {
                const days = daysInStock(v);
                return (
                  <tr key={v.id}>
                    <td>
                      <p className="font-medium">{[v.make, v.model].filter(Boolean).join(" ") || v.ref}</p>
                      <p className="text-xs text-slate-500">{[v.version, v.plate, v.year, v.mileage ? `${v.mileage.toLocaleString("fr-FR")} km` : null].filter(Boolean).join(" · ")}</p>
                    </td>
                    <td className="text-xs">{v.mode === "DEPOT_VENTE" ? <span className="text-indigo-700">Dépôt-vente</span> : "Achat"}</td>
                    <td className="text-xs whitespace-nowrap">{d(v.entryDate)}</td>
                    {vue !== "stock" && <td className="text-xs whitespace-nowrap">{d(v.saleDate)}</td>}
                    <td className={`text-right text-xs ${days !== null && days > 90 ? "text-red-700 font-semibold" : days !== null && days > 60 ? "text-amber-700" : ""}`}>{days ?? "—"}</td>
                    <td className="text-right text-xs">{v.mode === "DEPOT_VENTE" ? "—" : money(v.purchasePrice)}</td>
                    <td className="text-right text-xs">{v.costs ? eur(v.costs) : "—"}</td>
                    <td className="text-right text-xs">{money(vue === "stock" ? v.askingPrice : v.salePrice)}</td>
                    {vue !== "stock" && (
                      <>
                        <td className="text-right">{m(vehicleMargin(v))}</td>
                        <td className="text-xs">{[v.financingSold && `crédit${v.financingIncome ? ` ${eur(v.financingIncome)}` : ""}`, v.warrantySold && `garantie${v.warrantyPrice ? ` ${eur(v.warrantyPrice)}` : ""}`].filter(Boolean).join(" · ") || "—"}</td>
                      </>
                    )}
                    <td className="text-xs">{v.buyer?.firstName ?? (v.buyerName ? <span className="text-amber-700">{v.buyerName} ?</span> : "—")}</td>
                    {vue !== "stock" && <td className="text-xs">{v.seller?.firstName ?? (v.sellerName ? <span className="text-amber-700">{v.sellerName} ?</span> : <span className="text-amber-700">à renseigner</span>)}</td>}
                    {admin && (
                      <td>
                        <details>
                          <summary className="text-xs underline cursor-pointer">corriger</summary>
                          <form action={updateVehicle.bind(null, v.id)} className="grid grid-cols-2 gap-1 mt-2 w-80 text-xs">
                            <label>Type<select name="mode" defaultValue={v.mode} className="input py-1 text-xs"><option value="ACHAT">Achat</option><option value="DEPOT_VENTE">Dépôt-vente</option></select></label>
                            <label>Acheteur<select name="buyerId" defaultValue={v.buyerId ?? ""} className="input py-1 text-xs"><option value="">—</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.firstName}</option>)}</select></label>
                            <label>Vendeur<select name="sellerId" defaultValue={v.sellerId ?? ""} className="input py-1 text-xs"><option value="">—</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.firstName}</option>)}</select></label>
                            <label>Prix d&apos;achat<input name="purchasePrice" defaultValue={v.purchasePrice ?? ""} className="input py-1 text-xs" /></label>
                            <label>Frais<input name="costs" defaultValue={v.costs || ""} className="input py-1 text-xs" /></label>
                            <label>Prix de vente<input name="salePrice" defaultValue={v.salePrice ?? ""} className="input py-1 text-xs" /></label>
                            <label>Commission dépôt<input name="depotFee" defaultValue={v.depotFee ?? ""} className="input py-1 text-xs" /></label>
                            <label className="flex items-center gap-1"><input type="checkbox" name="financingSold" defaultChecked={v.financingSold} /> Crédit vendu</label>
                            <label>Commission crédit<input name="financingIncome" defaultValue={v.financingIncome ?? ""} className="input py-1 text-xs" /></label>
                            <label className="flex items-center gap-1"><input type="checkbox" name="warrantySold" defaultChecked={v.warrantySold} /> Garantie vendue</label>
                            <label>Prix garantie<input name="warrantyPrice" defaultValue={v.warrantyPrice ?? ""} className="input py-1 text-xs" /></label>
                            <button className="btn-primary col-span-2 text-xs">Enregistrer</button>
                            <p className="col-span-2 text-[11px] text-slate-500">Les champs corrigés ici ne seront plus écrasés par les imports Auto Cerfa.</p>
                          </form>
                        </details>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "pos" | "neg" }) {
  return (
    <div className="card">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-lg font-bold ${tone === "pos" ? "text-emerald-700" : tone === "neg" ? "text-red-700" : ""}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  );
}
