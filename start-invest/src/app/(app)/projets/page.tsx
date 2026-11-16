import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { projectAgentSlug } from "@/lib/agents";
import { ensureDefaultProjects } from "@/lib/projects";
import { createProject, reviewNow, setProspectStatus, updateProject, workNow } from "./actions";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { IDEE: "Idée", EN_COURS: "En cours", LANCE: "Lancé", EN_PAUSE: "En pause" };
const PSTATUS: Record<string, string> = { A_CONTACTER: "À contacter", CONTACTE: "Contacté", INTERESSE: "Intéressé", CLIENT: "Client ✅", REFUS: "Refus" };

function Fields({ p }: { p?: { description: string | null; goal: string | null; repo: string | null; website: string | null; status: string; notes: string | null } }) {
  return (
    <>
      <label className="text-xs sm:col-span-2">Description (quoi, pour qui, comment ça gagne de l&apos;argent)<textarea name="description" defaultValue={p?.description ?? ""} rows={3} className="input text-sm w-full" /></label>
      <label className="text-xs sm:col-span-2">Objectif<textarea name="goal" defaultValue={p?.goal ?? ""} rows={2} className="input text-sm w-full" placeholder="ex. lancement public avec paiements réels avant le 31/01" /></label>
      <label className="text-xs">Dépôt GitHub<input name="repo" defaultValue={p?.repo ?? ""} className="input text-sm" placeholder="mathieuives-web/mon-projet" /></label>
      <label className="text-xs">Site<input name="website" defaultValue={p?.website ?? ""} className="input text-sm" placeholder="https://..." /></label>
      <label className="text-xs">Statut<select name="status" defaultValue={p?.status ?? "EN_COURS"} className="input text-sm">{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="text-xs sm:col-span-2">Consignes pour le chef de projet<textarea name="notes" defaultValue={p?.notes ?? ""} rows={2} className="input text-sm w-full" /></label>
    </>
  );
}

export default async function ProjetsPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  await requireAdmin();
  await ensureDefaultProjects();
  const { msg } = await searchParams;
  const [projects, github, runs, prospects] = await Promise.all([
    prisma.project.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }),
    prisma.integration.findFirst({ where: { provider: "GITHUB" } }),
    prisma.agentRun.findMany({ where: { OR: [{ agent: { startsWith: "projet-" } }, { agent: "directeur-projets" }], parentId: null }, orderBy: { startedAt: "desc" }, take: 50 }),
    prisma.prospect.findMany({ where: { status: { not: "REFUS" } }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 400 }),
  ]);
  const last = (slug: string) => runs.find((r) => r.agent === slug);
  const dir = last("directeur-projets");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap justify-between gap-3 items-end">
        <div>
          <h1 className="text-xl font-bold">Projets</h1>
          <p className="text-sm text-slate-500">
            Vos projets à côté des sociétés : un <strong>chef de projet</strong> par projet, sous le <strong>Directeur des projets</strong>.
            Chaque matin, chaque chef de projet travaille pour le premier euro : bloquant à lever, nouveaux clients potentiels trouvés et message prêt.
            Vous n&apos;avez qu&apos;à cliquer « Envoyer ». Le lundi, point de tous les projets par le Directeur des projets.
          </p>
        </div>
        <form action={reviewNow.bind(null, null)}><button className="btn-primary" style={{ background: "#7f1d1d" }}>Point de tous les projets maintenant</button></form>
      </div>
      {msg && <p className="card text-sm bg-sky-50 border-sky-200 text-sky-900">{msg}</p>}
      {!github && (
        <p className="card text-sm bg-amber-50 border-amber-200 text-amber-900">
          Pour que les chefs de projet lisent l&apos;état réel de vos dépôts : <Link href="/connexions" className="underline">Connexions → GitHub (projets)</Link>, jeton en lecture seule.
        </p>
      )}
      {dir?.output && (
        <details className="card text-sm">
          <summary className="cursor-pointer font-medium">Dernier point du Directeur des projets ({dir.startedAt.toLocaleDateString("fr-FR")})</summary>
          <div className="whitespace-pre-wrap text-slate-700 mt-2 max-h-[32rem] overflow-y-auto">{dir.output}</div>
        </details>
      )}
      <section className="grid lg:grid-cols-2 gap-4">
        {projects.map((p) => {
          const slug = projectAgentSlug(p);
          const r = last(slug);
          return (
            <div key={p.id} className={`card space-y-3 ${p.active ? "" : "opacity-60"}`}>
              <div className="flex justify-between gap-2">
                <div>
                  <h2 className="font-semibold">{p.name} <span className="text-xs font-normal text-slate-500">· {STATUS[p.status] ?? p.status}</span></h2>
                  <p className="text-xs text-slate-500">{[p.repo, p.website].filter(Boolean).join(" · ") || "ni dépôt ni site renseigné"}</p>
                </div>
                <div className="flex gap-2 items-start">
                  <Link href={`/agents?agent=${slug}`} className="text-xs underline whitespace-nowrap">Chef de projet</Link>
                  <form action={workNow.bind(null, p.id)}><button className="btn-primary text-xs whitespace-nowrap">Au travail maintenant</button></form>
                  <form action={reviewNow.bind(null, p.id)}><button className="btn-secondary text-xs whitespace-nowrap">Faire le point</button></form>
                </div>
              </div>
              {r?.output && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-xs underline">Dernier point ({r.startedAt.toLocaleDateString("fr-FR")}{r.status === "RUNNING" ? ", en cours…" : ""})</summary>
                  <div className="whitespace-pre-wrap text-slate-700 mt-2 max-h-96 overflow-y-auto">{r.output}</div>
                </details>
              )}
              {prospects.some((x) => x.project === p.name) && (
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold">
                    Clients potentiels ({prospects.filter((x) => x.project === p.name && x.status === "A_CONTACTER").length} à contacter ·{" "}
                    {prospects.filter((x) => x.project === p.name && x.status === "CLIENT").length} client(s))
                  </h3>
                  <ul className="divide-y text-sm max-h-[36rem] overflow-y-auto">
                    {prospects.filter((x) => x.project === p.name).map((x) => (
                      <li key={x.id} className="py-2 space-y-1">
                        <div className="flex flex-wrap justify-between gap-2">
                          <span><strong>{x.name}</strong>{x.city ? ` · ${x.city}` : ""} <span className="text-xs text-slate-500">· {PSTATUS[x.status] ?? x.status}</span></span>
                          <span className="flex flex-wrap gap-2 text-xs">
                            {x.email && <a className="btn-primary text-xs py-0.5" href={`mailto:${x.email}?subject=${encodeURIComponent(x.subject ?? p.name)}&body=${encodeURIComponent(x.message ?? "")}`}>Envoyer l&apos;e-mail</a>}
                            {x.phone && <a className="btn-secondary text-xs py-0.5" href={`tel:${x.phone.replace(/\s/g, "")}`}>Appeler {x.phone}</a>}
                            {x.website && <a className="underline" href={x.website} target="_blank" rel="noreferrer">site</a>}
                            <a className="underline text-slate-500" href={x.source} target="_blank" rel="noreferrer">source</a>
                          </span>
                        </div>
                        {x.message && (
                          <details className="text-xs text-slate-600">
                            <summary className="cursor-pointer">message préparé{x.subject ? ` : « ${x.subject} »` : ""}</summary>
                            <p className="whitespace-pre-wrap mt-1">{x.message}</p>
                          </details>
                        )}
                        <div className="flex flex-wrap gap-1">
                          {["CONTACTE", "INTERESSE", "CLIENT", "REFUS"].filter((st) => st !== x.status).map((st) => (
                            <form key={st} action={setProspectStatus.bind(null, x.id, st)}><button className="text-xs border rounded px-1.5 py-0.5 hover:bg-slate-50">{st === "CONTACTE" ? "envoyé / appelé" : PSTATUS[st]}</button></form>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <details>
                <summary className="text-xs underline cursor-pointer">Modifier</summary>
                <form action={updateProject.bind(null, p.id)} className="grid sm:grid-cols-2 gap-2 mt-2">
                  <Fields p={p} />
                  <label className="text-xs flex items-center gap-1"><input type="checkbox" name="active" defaultChecked={p.active} /> actif</label>
                  <button className="btn-primary text-xs">Enregistrer</button>
                </form>
              </details>
            </div>
          );
        })}
      </section>
      <form action={createProject} className="card grid sm:grid-cols-2 gap-2">
        <h2 className="font-semibold sm:col-span-2">Ajouter un projet</h2>
        <label className="text-xs">Nom *<input name="name" required className="input text-sm" /></label>
        <Fields />
        <button className="btn-primary sm:col-span-2">Créer le projet et son chef de projet</button>
      </form>
    </div>
  );
}
