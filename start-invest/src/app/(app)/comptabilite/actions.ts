"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/session";
import { audit } from "@/lib/audit";
import { aiCategorize, setManualCategory } from "@/lib/categorization";

export async function runCategorization() {
  const me = await requireAdmin();
  await audit(me, "classement_comptable_lance");
  after(() => aiCategorize().then(() => undefined).catch((e) => console.log(`[comptabilite] ÉCHEC : ${(e as Error).message.slice(0, 300)}`)));
  redirect("/comptabilite?msg=" + encodeURIComponent("Classement lancé : l'IA range toutes les opérations par catégorie (quelques minutes). Rechargez la page ensuite."));
}

export async function recategorize(formData: FormData) {
  const me = await requireAdmin();
  const label = String(formData.get("label") ?? "");
  const category = String(formData.get("category") ?? "");
  const companyId = String(formData.get("companyId") ?? "") || undefined;
  const n = await setManualCategory(label, category, companyId);
  await audit(me, "categorie_corrigee", `${label.slice(0, 80)} → ${category} (${n} opération(s))`);
  revalidatePath("/comptabilite");
}
