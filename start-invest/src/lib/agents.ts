import { readdir, readFile } from "fs/promises";
import path from "path";

// Les agents sont définis dans .claude/agents/*.md (format des sous-agents Claude Code).
// Champs utilisés : name, description, model, tools + champs du board : title, parent,
// structure, skills, works_with. Le corps du fichier est le prompt système de l'agent.

export const AGENTS_DIR = path.join(process.cwd(), ".claude", "agents");

export type AgentDef = {
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
  prompt: string;
};

function list(v: string | undefined) {
  if (!v) return [];
  return v
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseAgent(slug: string, raw: string): AgentDef {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const front: Record<string, string> = {};
  const body = m ? m[2] : raw;
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (kv) front[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return {
    slug,
    name: front.name || slug,
    title: front.title || front.name || slug,
    description: front.description || "",
    model: front.model || "opus",
    tools: list(front.tools),
    skills: list(front.skills),
    worksWith: list(front.works_with),
    parent: front.parent || null,
    structure: front.structure || "Groupe",
    file: `.claude/agents/${slug}.md`,
    prompt: body.trim(),
  };
}

export async function loadAgents(): Promise<AgentDef[]> {
  let files: string[] = [];
  try {
    files = (await readdir(AGENTS_DIR)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const agents = await Promise.all(
    files.map(async (f) => parseAgent(f.replace(/\.md$/, ""), await readFile(path.join(AGENTS_DIR, f), "utf8")))
  );
  const slugs = new Set(agents.map((a) => a.slug));
  // Un parent inexistant est rattaché à la racine pour ne jamais "perdre" un agent.
  const root = agents.find((a) => !a.parent)?.slug ?? null;
  for (const a of agents) {
    if (a.parent && !slugs.has(a.parent)) a.parent = root === a.slug ? null : root;
    a.worksWith = a.worksWith.filter((w) => slugs.has(w) && w !== a.slug);
  }
  return agents.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function getAgent(slug: string) {
  return (await loadAgents()).find((a) => a.slug === slug) ?? null;
}

/** Agents qu'un agent a le droit de consulter : son équipe directe + ceux avec qui il travaille. */
export function reachableFrom(agent: AgentDef, all: AgentDef[]) {
  const team = all.filter((a) => a.parent === agent.slug).map((a) => a.slug);
  return Array.from(new Set([...team, ...agent.worksWith]));
}
