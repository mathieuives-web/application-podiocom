import { prisma } from "@/lib/prisma";
import { isAdmin, requireUser } from "@/lib/session";
import { loadAgents } from "@/lib/agents";
import { agentsConfigured } from "@/lib/agent-runtime";
import Board from "./Board";

export const dynamic = "force-dynamic";

type DbRun = Awaited<ReturnType<typeof prisma.agentRun.findMany>>[number];

function serializeRuns(runs: DbRun[]) {
  // Un passage bloqué depuis plus de 30 min (serveur redémarré...) n'est plus « au travail ».
  const stale = Date.now() - 30 * 60 * 1000;
  return runs.map((r) => {
    const dead = r.status === "RUNNING" && r.startedAt.getTime() < stale;
    return {
      id: r.id,
      agent: r.agent,
      task: r.task,
      status: dead ? "ERROR" : r.status,
      output: r.output,
      error: r.error ?? (dead ? "Interrompu." : null),
      parentId: r.parentId,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  });
}

export default async function AgentsPage() {
  const user = await requireUser();
  const [agents, runs] = await Promise.all([
    loadAgents(),
    prisma.agentRun.findMany({ orderBy: { startedAt: "desc" }, take: 150 }),
  ]);

  return (
    <Board
      configured={agentsConfigured()}
      canConvoke={isAdmin(user.role)}
      agents={agents.map(({ prompt, ...a }) => ({ ...a, promptLength: prompt.length }))}
      runs={serializeRuns(runs)}
    />
  );
}
