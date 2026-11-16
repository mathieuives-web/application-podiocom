"use server";

import { after } from "next/server";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { audit } from "@/lib/audit";

/** Le fondateur demande de tout refaire pour une société : reclassement, relecture des logiciels, analyse complète. */
export async function redoCompanyAction(companyId: string) {
  const me = await requireAdmin();
  const c = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  await audit(me, "remise_a_plat", c.name);
  after(() => import("@/lib/daily-control").then((m) => m.redoCompany(companyId, me.id)).then(() => undefined).catch((e) => console.error("[remise à plat]", e)));
  redirect("/resultats?msg=" + encodeURIComponent(`${c.name} : remise à plat lancée (reclassement de toutes les opérations, relecture des logiciels, puis analyse complète par l'agent comptable). Comptez 10 à 20 minutes ; le rapport arrive dans le Board d'agents.`));
}
