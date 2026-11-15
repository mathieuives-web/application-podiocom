"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { audit } from "@/lib/audit";

export async function toggleFieldRequest(id: string) {
  const me = await requireAdmin();
  const r = await prisma.fieldRequest.findUniqueOrThrow({ where: { id } });
  await prisma.fieldRequest.update({ where: { id }, data: { status: r.status === "TRAITE" ? "NOUVEAU" : "TRAITE" } });
  await audit(me, "demande_terrain", `${id} → ${r.status === "TRAITE" ? "NOUVEAU" : "TRAITE"}`);
  revalidatePath("/terrain");
}
