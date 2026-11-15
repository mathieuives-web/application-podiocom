import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { projectAgentSlug } from "@/lib/agents";
import { ensureDefaultProjects } from "@/lib/projects";
import { createProject, reviewNow, updateProject } from "./actions";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { IDEE: "Idée", EN_COURS: "En cours", LANCE: "Lancé", EN_PAUSE: "En pause" };

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
  const [projects, github, runs] = await Promise.all([
    prisma.project.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }),
    prisma.integration.findFirst({ where: { provider: "GITHUB" } }),
    prisma.agentRun.findMany({ where: { OR: [{ agent: { startsWith: "projet-" } }, { agent: "directeur-projets" }], parentId: null }, orderBy: { startedAt: "desc" }, take: 50 }),
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
            Chaque lundi, le point de tous les projets : état réel, reste à faire, priorité de la semaine.
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
                  <form action={reviewNow.bind(null, p.id)}><button className="btn-secondary text-xs whitespace-nowrap">Faire le point</button></form>
                </div>
              </div>
              {r?.output && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-xs underline">Dernier point ({r.startedAt.toLocaleDateString("fr-FR")}{r.status === "RUNNING" ? ", en cours…" : ""})</summary>
                  <div className="whitespace-pre-wrap text-slate-700 mt-2 max-h-96 overflow-y-auto">{r.output}</div>
                </details>
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
