"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { getAgent } from "@/lib/agents";
import { executeAgent, agentsConfigured } from "@/lib/agent-runtime";

export async function convoquerAgent(slug: string, task: string): Promise<{ ok: boolean; error?: string; runId?: string }> {
  const user = await requireAdmin();
  const agent = await getAgent(slug);
  if (!agent) return { ok: false, error: "Agent introuvable." };
  if (!task.trim()) return { ok: false, error: "Décrivez la demande." };
  if (!agentsConfigured()) return { ok: false, error: "Ajoutez ANTHROPIC_API_KEY dans les variables d'environnement du serveur." };

  const run = await prisma.agentRun.create({ data: { agent: slug, task: task.trim(), userId: user.id } });
  // L'agent travaille en arrière-plan ; la page se rafraîchit tant qu'il est « au travail ».
  after(async () => {
    try {
      await executeAgent({ slug, task: task.trim(), userId: user.id, runId: run.id });
    } catch {
      // l'erreur est déjà enregistrée sur le passage
    }
  });
  revalidatePath("/agents");
  return { ok: true, runId: run.id };
}
