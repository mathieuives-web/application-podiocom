import { prisma } from "@/lib/prisma";

/** Trace une action sensible. Ne bloque jamais l'action si l'écriture du journal échoue. */
export async function audit(user: { id?: string | null; email?: string | null } | null, action: string, detail?: string) {
  // Trace aussi dans les journaux du serveur (sans données sensibles) pour le suivi d'exploitation.
  console.log(`[journal] ${action}${detail ? " — " + detail.slice(0, 200) : ""}`);
  try {
    await prisma.auditLog.create({
      data: { userId: user?.id ?? null, userEmail: user?.email ?? null, action, detail: detail?.slice(0, 1000) ?? null },
    });
  } catch (e) {
    console.error("[audit]", e);
  }
}
