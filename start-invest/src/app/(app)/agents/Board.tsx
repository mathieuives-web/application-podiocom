"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { convoquerAgent } from "./actions";

type Agent = {
  slug: string;
  name: string;
  title: string;
  description: string;
  model: string;
  tools: string[];
  skills: string[];
  worksWith: string[];
  parent: string | null;
  structure: string;
  file: string;
  promptLength: number;
};

type Run = {
  id: string;
  agent: string;
  task: string;
  status: string;
  output: string | null;
  error: string | null;
  parentId: string | null;
  startedAt: string;
  finishedAt: string | null;
};

type Node = Agent & { x: number; y: number; angle: number; depth: number; leaves: number };

const RADII = [0, 380, 650, 840, 1000];
const VIEW = { x: -930, y: -880, w: 1860, h: 1760 };
const MAROON = "#7f1d1d";

function layout(agents: Agent[]): Node[] {
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  const children = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const a of agents) {
    if (a.parent && bySlug.has(a.parent)) {
      const list = children.get(a.parent) ?? [];
      list.push(a);
      children.set(a.parent, list);
    } else roots.push(a);
  }
  // Racine = l'agent sans parent qui a le plus d'équipe (le CEO) ; les autres racines lui sont rattachées.
  roots.sort((a, b) => (children.get(b.slug)?.length ?? 0) - (children.get(a.slug)?.length ?? 0));
  const root = roots[0];
  if (!root) return [];
  for (const r of roots.slice(1)) children.set(root.slug, [...(children.get(root.slug) ?? []), r]);
  // Structures (DG...) d'abord, puis le board, pour regrouper visuellement.
  for (const [k, list] of children) {
    children.set(
      k,
      [...list].sort((a, b) => (children.get(b.slug)?.length ?? 0) - (children.get(a.slug)?.length ?? 0))
    );
  }

  const leafCount = (a: Agent): number => {
    const kids = children.get(a.slug) ?? [];
    return kids.length ? kids.reduce((s, k) => s + leafCount(k), 0) : 1;
  };

  // Poids angulaire : chaque membre du board garde assez de place pour son nom.
  const weight = (a: Agent, depth: number) => (depth === 1 ? Math.max(leafCount(a), 2.5) : leafCount(a));

  const nodes: Node[] = [];
  const place = (a: Agent, depth: number, start: number, end: number) => {
    const angle = (start + end) / 2;
    const r = RADII[Math.min(depth, RADII.length - 1)];
    nodes.push({ ...a, depth, angle, leaves: leafCount(a), x: r * Math.cos(angle), y: r * Math.sin(angle) });
    const kids = children.get(a.slug) ?? [];
    const total = kids.reduce((s, k) => s + weight(k, depth + 1), 0);
    let cursor = start;
    for (const k of kids) {
      const span = ((end - start) * weight(k, depth + 1)) / total;
      place(k, depth + 1, cursor, cursor + span);
      cursor += span;
    }
  };
  place(root, 0, -Math.PI / 2, (3 * Math.PI) / 2);
  return nodes;
}

/** Coupe un nom long en deux lignes équilibrées pour éviter les chevauchements. */
function twoLines(title: string): string[] {
  const words = title.split(" ");
  if (title.length <= 14 || words.length < 2) return [title];
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const diff = Math.abs(words.slice(0, i).join(" ").length - words.slice(i).join(" ").length);
    if (diff < bestDiff) [best, bestDiff] = [i, diff];
  }
  return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}

const fmtDate = (s: string) =>
  new Date(s).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function Board({ agents, runs, configured, canConvoke }: { agents: Agent[]; runs: Run[]; configured: boolean; canConvoke: boolean }) {
  const router = useRouter();
  const nodes = useMemo(() => layout(agents), [agents]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.slug, n])), [nodes]);
  const [selected, setSelected] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [view, setView] = useState(VIEW);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const working = new Set(runs.filter((r) => r.status === "RUNNING").map((r) => r.agent));
  const anyRunning = working.size > 0;

  // Rafraîchit la page tant qu'un agent est au travail.
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [anyRunning, router]);

  const groupStructure = nodes[0]?.structure ?? "Groupe";
  const sel = selected ? byId.get(selected) : null;
  const related = new Set<string>();
  if (sel) {
    related.add(sel.slug);
    if (sel.parent) related.add(sel.parent);
    nodes.filter((n) => n.parent === sel.slug).forEach((n) => related.add(n.slug));
    sel.worksWith.forEach((w) => related.add(w));
  }

  const toSvg = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: view.x + ((clientX - rect.left) / rect.width) * view.w, y: view.y + ((clientY - rect.top) / rect.height) * view.h };
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = toSvg(e.clientX, e.clientY);
    const k = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    const w = Math.min(4000, Math.max(300, view.w * k));
    const h = (w / view.w) * view.h;
    setView({ x: p.x - ((p.x - view.x) * w) / view.w, y: p.y - ((p.y - view.y) * h) / view.h, w, h });
  };

  const zoom = (k: number) =>
    setView((v) => {
      const w = Math.min(4000, Math.max(300, v.w * k));
      const h = (w / v.w) * v.h;
      return { x: v.x + (v.w - w) / 2, y: v.y + (v.h - h) / 2, w, h };
    });

  const focus = (slug: string) => {
    setSelected(slug);
    const n = byId.get(slug);
    if (n) setView((v) => ({ ...v, x: n.x - v.w / 2 + v.w * 0.12, y: n.y - v.h / 2 }));
  };

  const worksWithPairs = useMemo(() => {
    const seen = new Set<string>();
    const pairs: [Node, Node][] = [];
    for (const n of nodes)
      for (const w of n.worksWith) {
        const m = byId.get(w);
        const key = [n.slug, w].sort().join("|");
        if (m && !seen.has(key) && m.slug !== n.parent && n.slug !== m.parent) {
          seen.add(key);
          pairs.push([n, m]);
        }
      }
    return pairs;
  }, [nodes, byId]);

  const run = openRun ? runs.find((r) => r.id === openRun) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Board d&apos;agents · Start Invest</h1>
          <p className="text-sm text-slate-500">
            {agents.length} agents IA pilotent le groupe. Cliquez sur un agent pour voir son rôle, son équipe et le convoquer.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={() => { setView(VIEW); setSelected(null); }}>
            Recentrer
          </button>
          <button className="btn-secondary" onClick={() => setShowHistory((s) => !s)}>
            Historique
          </button>
          <button className="btn-primary" style={{ background: MAROON }} onClick={() => focus(nodes[0]?.slug)} hidden={!canConvoke}>
            Convoquer le CEO
          </button>
        </div>
      </div>

      {canConvoke && !configured && (
        <p className="card text-sm border-amber-300 bg-amber-50 text-amber-900">
          Le board est visible, mais pour <strong>convoquer</strong> les agents il faut ajouter la variable{" "}
          <code>ANTHROPIC_API_KEY</code> sur le serveur (clé créée sur console.anthropic.com).
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-[1fr_380px]">
        <div
          className="relative rounded-lg border border-stone-300 overflow-hidden select-none touch-none"
          style={{ background: "#f7f2ea", height: "min(78vh, 820px)", minHeight: 420 }}
        >
          <svg
            ref={svgRef}
            viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
            className="w-full h-full cursor-grab active:cursor-grabbing"
            onWheel={onWheel}
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture?.(e.pointerId);
              drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
            }}
            onPointerMove={(e) => {
              if (!drag.current || !svgRef.current) return;
              const rect = svgRef.current.getBoundingClientRect();
              setView((v) => ({
                ...v,
                x: drag.current!.vx - ((e.clientX - drag.current!.x) / rect.width) * v.w,
                y: drag.current!.vy - ((e.clientY - drag.current!.y) / rect.height) * v.h,
              }));
            }}
            onPointerUp={() => (drag.current = null)}
          >
            <defs>
              <style>{`@keyframes pulse{0%{r:8;opacity:1}100%{r:22;opacity:0}} .pulse{animation:pulse 1.4s ease-out infinite}`}</style>
            </defs>

            {[1, 2, 3].map((d) => (
              <circle key={d} r={RADII[d]} fill="none" stroke="#d6cbbb" strokeDasharray="2 8" />
            ))}

            {/* travaillent ensemble */}
            {worksWithPairs.map(([a, b]) => {
              const on = !sel || related.has(a.slug) && related.has(b.slug) && (a.slug === sel.slug || b.slug === sel.slug);
              const mx = (a.x + b.x) / 2 * 0.55;
              const my = (a.y + b.y) / 2 * 0.55;
              return (
                <path
                  key={a.slug + b.slug}
                  d={`M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`}
                  fill="none"
                  stroke={MAROON}
                  strokeWidth={on && sel ? 2 : 1}
                  strokeDasharray="6 6"
                  opacity={sel ? (on ? 0.8 : 0.05) : 0.18}
                />
              );
            })}

            {/* dirige */}
            {nodes.filter((n) => n.parent).map((n) => {
              const p = byId.get(n.parent!)!;
              const on = !sel || (related.has(n.slug) && related.has(p.slug) && (n.slug === sel.slug || p.slug === sel.slug));
              return (
                <line key={n.slug} x1={p.x} y1={p.y} x2={n.x} y2={n.y} stroke={MAROON} strokeWidth={on && sel ? 2.5 : 1.3} opacity={sel ? (on ? 0.9 : 0.12) : 0.55} />
              );
            })}

            {nodes.map((n) => {
              const isRoot = n.depth === 0;
              const r = isRoot ? 78 : n.depth === 1 ? 34 : 22;
              const dim = sel && !related.has(n.slug);
              const isSel = sel?.slug === n.slug;
              const deg = (n.angle * 180) / Math.PI;
              const flip = deg > 90 && deg < 270;
              return (
                <g
                  key={n.slug}
                  transform={`translate(${n.x},${n.y})`}
                  opacity={dim ? 0.25 : 1}
                  className="cursor-pointer"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setSelected(n.slug)}
                >
                  {working.has(n.slug) && <circle className="pulse" r={8} cx={r * 0.75} cy={-r * 0.75} fill="#16a34a" />}
                  <circle
                    r={r}
                    fill={isRoot ? MAROON : "#fffdf9"}
                    stroke={MAROON}
                    strokeWidth={isSel ? 4 : n.structure !== groupStructure && n.depth === 1 ? 3 : 1.6}
                    strokeDasharray={n.structure !== groupStructure && n.depth > 1 ? "4 3" : undefined}
                  />
                  {working.has(n.slug) && <circle r={7} cx={r * 0.75} cy={-r * 0.75} fill="#16a34a" />}
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={isRoot ? "#fff" : MAROON}
                    fontSize={isRoot ? 32 : n.depth === 1 ? 20 : 14}
                    fontWeight={600}
                  >
                    {isRoot ? n.title : n.structure !== groupStructure && n.depth === 1 ? "S" : "A"}
                  </text>
                  {n.depth === 1 && (
                    <text y={r + 30} textAnchor="middle" fontSize={27} fontWeight={600} fill="#292524" paintOrder="stroke" stroke="#f7f2ea" strokeWidth={6}>
                      {twoLines(n.title).map((line, i) => (
                        <tspan key={i} x={0} dy={i === 0 ? 0 : 30}>{line}</tspan>
                      ))}
                    </text>
                  )}
                  {n.depth > 1 && (
                    <text
                      transform={`rotate(${flip ? deg - 180 : deg})`}
                      x={flip ? -(r + 8) : r + 8}
                      textAnchor={flip ? "end" : "start"}
                      dominantBaseline="central"
                      fontSize={23}
                      fill="#44403c"
                    >
                      {n.title}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          <div className="absolute top-2 right-2 flex flex-col gap-1">
            <button className="btn-secondary w-9 h-9 p-0 text-lg" onClick={() => zoom(1 / 1.3)} aria-label="Zoomer">+</button>
            <button className="btn-secondary w-9 h-9 p-0 text-lg" onClick={() => zoom(1.3)} aria-label="Dézoomer">−</button>
          </div>

          <div className="absolute bottom-2 left-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-stone-500">
            <span>— dirige</span>
            <span>- - - travaillent ensemble</span>
            <span>A agent · S structure</span>
            <span className="inline-flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-green-600" /> au travail</span>
            <span>molette : zoom · glisser : déplacer</span>
          </div>
        </div>

        <aside className="card lg:max-h-[min(78vh,820px)] overflow-y-auto" style={{ background: "#fffdf9" }}>
          {showHistory ? (
            <History runs={runs} byId={byId} onOpen={setOpenRun} onClose={() => setShowHistory(false)} />
          ) : sel ? (
            <AgentPanel
              agent={sel}
              nodes={nodes}
              byId={byId}
              runs={runs.filter((r) => r.agent === sel.slug)}
              working={working.has(sel.slug)}
              configured={configured && canConvoke}
              groupStructure={groupStructure}
              onSelect={focus}
              onOpenRun={setOpenRun}
              onClose={() => setSelected(null)}
              onDone={() => router.refresh()}
            />
          ) : (
            <div className="space-y-3 text-sm text-stone-600">
              <p className="text-xs uppercase tracking-widest text-stone-400">Board</p>
              <p>
                Le <strong>CEO</strong> est au centre. Autour, son board (CFO, Moneymaker, CMO, CTO, Stratège, Avocat du diable,
                Knowledge keeper) et les <strong>structures</strong> du groupe Start Invest (La Fabrique Automobile, Auto Rac Ives, La Fabrique Restaurant, Le Bar L&apos;Usine, SCI Mapo) — chacun dirige sa propre équipe d&apos;agents.
              </p>
              <p>
                Convoquez le CEO avec un objectif : il découpe la demande, consulte les bons agents (qui lisent vos vraies données
                financières et de flotte) et vous rend une décision avec les actions chiffrées.
              </p>
              <p className="text-xs text-stone-400">
                Les agents sont définis dans <code>.claude/agents/*.md</code> — ajoutez un fichier pour créer un agent ou une nouvelle structure.
              </p>
            </div>
          )}
        </aside>
      </div>

      {run && <RunModal run={run} runs={runs} byId={byId} onOpen={setOpenRun} onClose={() => setOpenRun(null)} />}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="inline-block rounded-full border border-stone-300 px-2 py-0.5 text-xs text-stone-600 mr-1 mb-1">{children}</span>;
}

function LinkList({ slugs, byId, onSelect }: { slugs: string[]; byId: Map<string, Node>; onSelect: (s: string) => void }) {
  if (!slugs.length) return <span className="text-stone-400">—</span>;
  return (
    <span>
      {slugs.map((s, i) => (
        <span key={s}>
          <button className="underline decoration-stone-400 hover:text-red-900" onClick={() => onSelect(s)}>
            {byId.get(s)?.title ?? s}
          </button>
          {i < slugs.length - 1 && ", "}
        </span>
      ))}
    </span>
  );
}

function AgentPanel({
  agent, nodes, byId, runs, working, configured, groupStructure, onSelect, onOpenRun, onClose, onDone,
}: {
  agent: Node; nodes: Node[]; byId: Map<string, Node>; runs: Run[]; working: boolean; configured: boolean; groupStructure: string;
  onSelect: (s: string) => void; onOpenRun: (id: string) => void; onClose: () => void; onDone: () => void;
}) {
  const [task, setTask] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const team = nodes.filter((n) => n.parent === agent.slug).map((n) => n.slug);
  const parent = agent.parent ? byId.get(agent.parent) : null;
  const place = !parent
    ? "Dirige le groupe, rend compte au fondateur"
    : agent.depth === 1
      ? agent.structure !== groupStructure
        ? `Dirige la structure ${agent.structure}`
        : "Membre du board" + (team.length ? ", il dirige son équipe" : "")
      : `Dans l'équipe de ${parent.title}`;

  const rows: [string, React.ReactNode][] = [
    ["Place", place],
    ["Son équipe", <LinkList key="t" slugs={team} byId={byId} onSelect={onSelect} />],
    ["Modèle", agent.model],
    ["Outils", agent.tools.length ? agent.tools.join(", ") : "—"],
    ["Skills", agent.skills.length ? agent.skills.map((s) => <Pill key={s}>{s}</Pill>) : "—"],
    ["Travaille avec", <LinkList key="w" slugs={agent.worksWith} byId={byId} onSelect={onSelect} />],
    ["Fichier", <code key="f" className="text-xs">{agent.file}</code>],
  ];

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-stone-400">Agent · {agent.structure}</p>
          <h2 className="text-2xl font-bold text-stone-900">{agent.title}</h2>
        </div>
        <button className="text-stone-400 hover:text-stone-700 text-lg" onClick={onClose} aria-label="Fermer">×</button>
      </div>
      <p className={`rounded-md px-3 py-1.5 text-xs ${working ? "bg-green-50 text-green-800" : "bg-stone-100 text-stone-500"}`}>
        {working ? "● Au travail" : "Au repos"}
      </p>
      <p className="text-stone-700 leading-relaxed">{agent.description}</p>

      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-stone-500">{k}</dt>
            <dd className="text-stone-800 min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>

      <form
        className="space-y-2 border-t border-stone-200 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          start(async () => {
            const res = await convoquerAgent(agent.slug, task);
            if (!res.ok) setError(res.error ?? "Erreur");
            else {
              setTask("");
              onDone();
            }
          });
        }}
      >
        <label className="label">Convoquer {agent.title}</label>
        <textarea
          className="input"
          rows={3}
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder={
            agent.slug === "cfo"
              ? "Ex : Fais le point sur la trésorerie et dis-moi où on perd de l'argent."
              : agent.depth === 0
                ? "Ex : Quelle société du groupe doit recevoir le prochain euro investi, et pour faire quoi ?"
                : "Votre demande..."
          }
        />
        {error && <p className="text-xs text-red-600">{error}</p>}
        <button className="btn-primary w-full" style={{ background: MAROON }} disabled={pending || working || !configured || !task.trim()}>
          {pending ? "Envoi..." : working ? "Au travail..." : "Convoquer"}
        </button>
      </form>

      <div className="border-t border-stone-200 pt-3">
        <p className="text-[11px] uppercase tracking-[0.2em] text-red-900 font-semibold mb-2">Derniers passages</p>
        {runs.length === 0 && <p className="text-stone-400 text-xs">Pas encore convoqué.</p>}
        <ul className="space-y-1">
          {runs.slice(0, 8).map((r) => (
            <li key={r.id}>
              <button className="w-full text-left grid grid-cols-[92px_1fr] gap-2 text-xs hover:bg-stone-100 rounded px-1 py-1" onClick={() => onOpenRun(r.id)}>
                <span className="text-stone-400">{fmtDate(r.startedAt)}</span>
                <span className="truncate">
                  <StatusDot status={r.status} /> {r.task}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const c = status === "RUNNING" ? "bg-green-500 animate-pulse" : status === "ERROR" ? "bg-red-500" : "bg-stone-400";
  return <span className={`inline-block w-2 h-2 rounded-full ${c} mr-1`} />;
}

function History({ runs, byId, onOpen, onClose }: { runs: Run[]; byId: Map<string, Node>; onOpen: (id: string) => void; onClose: () => void }) {
  const top = runs.filter((r) => !r.parentId);
  return (
    <div className="space-y-3 text-sm">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-bold">Historique des convocations</h2>
        <button className="text-stone-400 hover:text-stone-700 text-lg" onClick={onClose}>×</button>
      </div>
      {top.length === 0 && <p className="text-stone-400 text-xs">Aucune convocation pour l&apos;instant.</p>}
      <ul className="space-y-2">
        {top.map((r) => (
          <li key={r.id}>
            <button className="w-full text-left rounded border border-stone-200 p-2 hover:bg-stone-50" onClick={() => onOpen(r.id)}>
              <p className="text-xs text-stone-400">
                <StatusDot status={r.status} />
                {fmtDate(r.startedAt)} · {byId.get(r.agent)?.title ?? r.agent} · {runs.filter((x) => x.parentId === r.id).length} sous-agent(s)
              </p>
              <p className="line-clamp-2">{r.task}</p>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunModal({ run, runs, byId, onOpen, onClose }: { run: Run; runs: Run[]; byId: Map<string, Node>; onOpen: (id: string) => void; onClose: () => void }) {
  const children = runs.filter((r) => r.parentId === run.id);
  const parent = run.parentId ? runs.find((r) => r.id === run.parentId) : null;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start gap-4">
          <div>
            <p className="text-xs text-stone-400">
              <StatusDot status={run.status} />
              {byId.get(run.agent)?.title ?? run.agent} · {fmtDate(run.startedAt)}
              {run.finishedAt && ` · ${Math.round((+new Date(run.finishedAt) - +new Date(run.startedAt)) / 1000)} s`}
            </p>
            <h3 className="font-semibold mt-1">{run.task}</h3>
            {parent && (
              <button className="text-xs underline text-stone-500" onClick={() => onOpen(parent.id)}>
                ← demandé par {byId.get(parent.agent)?.title ?? parent.agent}
              </button>
            )}
          </div>
          <button className="text-stone-400 hover:text-stone-700 text-xl" onClick={onClose}>×</button>
        </div>
        {run.status === "RUNNING" && <p className="text-sm text-green-700">L&apos;agent travaille… cette fenêtre se met à jour automatiquement.</p>}
        {run.error && <p className="text-sm text-red-700 bg-red-50 rounded p-2">{run.error}</p>}
        {run.output && <div className="whitespace-pre-wrap text-sm leading-relaxed text-stone-800">{run.output}</div>}
        {children.length > 0 && (
          <div className="border-t pt-3">
            <p className="text-xs uppercase tracking-widest text-stone-400 mb-2">Agents consultés</p>
            <ul className="space-y-1">
              {children.map((c) => (
                <li key={c.id}>
                  <button className="text-left text-sm hover:underline" onClick={() => onOpen(c.id)}>
                    <StatusDot status={c.status} />
                    <strong>{byId.get(c.agent)?.title ?? c.agent}</strong> — {c.task.slice(0, 120)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
