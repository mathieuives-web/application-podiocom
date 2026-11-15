"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { audit } from "@/lib/audit";
import { computeCommissions } from "@/lib/team";
import { parseAmount } from "@/lib/statement-import";

/** Correction manuelle d'un véhicule : ces champs ne seront plus écrasés par les imports Auto Cerfa. */
export async function updateVehicle(vehicleId: string, formData: FormData) {
  const me = await requireAdmin();
  const v = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
  const num = (k: string) => {
    const raw = String(formData.get(k) ?? "").trim();
    return raw ? Math.abs(parseAmount(raw) ?? 0) : null;
  };
  const id = (k: string) => String(formData.get(k) ?? "") || null;
  const data = {
    sellerId: id("sellerId"),
    buyerId: id("buyerId"),
    mode: formData.get("mode") === "DEPOT_VENTE" ? "DEPOT_VENTE" : "ACHAT",
    purchasePrice: num("purchasePrice"),
    costs: num("costs") ?? 0,
    salePrice: num("salePrice"),
    depotFee: num("depotFee"),
    financingSold: formData.get("financingSold") === "on",
    financingIncome: num("financingIncome"),
    warrantySold: formData.get("warrantySold") === "on",
    warrantyPrice: num("warrantyPrice"),
  };
  const changed = Object.entries(data).filter(([k, val]) => (v as Record<string, unknown>)[k] !== val).map(([k]) => k);
  if (!changed.length) return;
  const locked = new Set([...v.manualFields.split(",").filter(Boolean), ...changed]);
  await prisma.vehicle.update({ where: { id: vehicleId }, data: { ...data, manualFields: [...locked].join(",") } });
  await audit(me, "vehicule_corrige", `${v.ref} : ${changed.join(", ")}`);
  await computeCommissions(v.companyId);
  revalidatePath("/vehicules");
}
