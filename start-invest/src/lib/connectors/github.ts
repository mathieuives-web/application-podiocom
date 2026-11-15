import { prisma } from "@/lib/prisma";
import { decryptJson } from "@/lib/crypto";

// Lecture seule des dépôts GitHub des projets du fondateur (jeton « fine-grained » en lecture),
// pour que chaque chef de projet voie l'état réel : README, derniers changements, tâches ouvertes, CI.

const API = process.env.GITHUB_API_URL || "https://api.github.com";

async function token() {
  const i = await prisma.integration.findFirst({ where: { provider: "GITHUB" } });
  if (!i) throw new Error("GitHub n'est pas connecté : Connexions → GitHub (jeton en lecture seule).");
  return decryptJson<{ token: string }>(i.credentials).token;
}

async function gh<T>(path: string, raw = false): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${await token()}`, Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "start-invest" },
    cache: "no-store",
  });
  if (r.status === 404) throw new Error("Introuvable (dépôt ou fichier absent, ou jeton sans accès à ce dépôt).");
  if (!r.ok) throw new Error(`GitHub ${r.status} : ${(await r.text()).slice(0, 200)}`);
  return (raw ? await r.text() : await r.json()) as T;
}

const repoPath = (repo: string) => {
  const m = repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new Error(`Dépôt invalide : « ${repo} » (attendu propriétaire/nom).`);
  return `${m[1]}/${m[2]}`;
};

export async function checkGitHub() {
  return gh<{ login: string }>("/user").catch(() => gh<unknown>("/rate_limit"));
}

/** État d'un dépôt : description, README, 15 derniers changements, tâches et PR ouvertes, derniers builds, documents. */
export async function repoStatus(repo: string) {
  const p = repoPath(repo);
  const [info, readme, commits, issues, runs, tree] = await Promise.all([
    gh<{ description: string | null; default_branch: string; pushed_at: string; open_issues_count: number; homepage: string | null }>(`/repos/${p}`),
    gh<string>(`/repos/${p}/readme`, true).catch(() => ""),
    gh<{ sha: string; commit: { message: string; author: { date: string } } }[]>(`/repos/${p}/commits?per_page=15`).catch(() => []),
    gh<{ number: number; title: string; pull_request?: unknown; labels: { name: string }[]; updated_at: string }[]>(`/repos/${p}/issues?state=open&per_page=30`).catch(() => []),
    gh<{ workflow_runs: { name: string; head_branch: string; conclusion: string | null; status: string; created_at: string }[] }>(`/repos/${p}/actions/runs?per_page=8`).catch(() => ({ workflow_runs: [] })),
    gh<{ tree: { path: string; type: string }[] }>(`/repos/${p}/git/trees/HEAD?recursive=1`).catch(() => ({ tree: [] })),
  ]);
  return {
    depot: p,
    description: info.description,
    site: info.homepage,
    brancheParDefaut: info.default_branch,
    dernierPush: info.pushed_at,
    readme: readme.slice(0, 12000),
    derniersChangements: commits.map((c) => ({ date: c.commit.author.date.slice(0, 10), message: c.commit.message.split("\n")[0].slice(0, 160) })),
    tachesOuvertes: issues.filter((i) => !i.pull_request).map((i) => ({ n: i.number, titre: i.title, etiquettes: i.labels.map((l) => l.name) })),
    demandesDeFusionOuvertes: issues.filter((i) => i.pull_request).map((i) => ({ n: i.number, titre: i.title })),
    derniersBuilds: runs.workflow_runs.map((r) => ({ nom: r.name, branche: r.head_branch, resultat: r.conclusion ?? r.status, date: r.created_at.slice(0, 10) })),
    documents: tree.tree.filter((t) => t.type === "blob" && /\.(md|txt)$/i.test(t.path) && !t.path.includes("node_modules")).map((t) => t.path).slice(0, 150),
  };
}

/** Lit un fichier texte du dépôt (documentation, plan de lancement...). */
export async function repoFile(repo: string, file: string) {
  const p = repoPath(repo);
  const f = file.replace(/^\/+/, "");
  if (f.includes("..") || /(^|\/)\.env/.test(f)) throw new Error("Fichier refusé.");
  return { depot: p, fichier: f, contenu: (await gh<string>(`/repos/${p}/contents/${f.split("/").map(encodeURIComponent).join("/")}`, true)).slice(0, 30000) };
}
