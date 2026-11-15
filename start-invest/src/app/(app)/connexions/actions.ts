"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { encryptJson } from "@/lib/crypto";
import { PROVIDERS, syncIntegration } from "@/lib/connectors";
import { audit } from "@/lib/audit";

export async function addIntegration(formData: FormData) {
  const me = await requireAdmin();
  const provider = PROVIDERS.find((p) => p.id === formData.get("provider") && p.available);
  if (!provider) throw new Error("Connecteur indisponible.");
  const creds: Record<string, string> = {};
  for (const f of provider.fields) {
    const v = (formData.get(f.name) ?? "").toString().trim();
    if (!v) redirect(`/connexions?msg=${encodeURIComponent(`Champ manquant : ${f.label}`)}`);
    creds[f.name] = v;
  }
  const integ = await prisma.integration.create({
    data: {
      companyId: (formData.get("companyId") ?? "").toString(),
      provider: provider.id,
      label: (formData.get("label") ?? "").toString().trim() || null,
      credentials: encryptJson(creds),
    },
  });
  await audit(me, "connexion_outil_ajoutee", `${provider.name} — société ${integ.companyId}`);
  let msg: string;
  try {
    const r = await syncIntegration(integ.id);
    msg = `${provider.name} connecté : ${r.accounts} compte(s), ${r.transactions} opération(s), ${r.invoices} facture(s) synchronisé(s).`;
  } catch (e) {
    msg = `${provider.name} enregistré mais la synchronisation a échoué : ${(e as Error).message}`;
  }
  revalidatePath("/connexions");
  revalidatePath("/finances");
  redirect(`/connexions?msg=${encodeURIComponent(msg)}`);
}

export async function syncNow(integrationId: string) {
  const me = await requireAdmin();
  await audit(me, "synchronisation_manuelle", integrationId);
  let msg: string;
  try {
    const r = await syncIntegration(integrationId);
    msg = `Synchronisé : ${r.accounts} compte(s), ${r.transactions} opération(s), ${r.invoices} facture(s).`;
  } catch (e) {
    msg = `Échec : ${(e as Error).message}`;
  }
  revalidatePath("/connexions");
  revalidatePath("/finances");
  redirect(`/connexions?msg=${encodeURIComponent(msg)}`);
}

export async function removeIntegration(integrationId: string) {
  const me = await requireAdmin();
  await audit(me, "connexion_outil_supprimee", integrationId);
  // Les comptes et opérations déjà importés sont conservés (historique).
  await prisma.integration.delete({ where: { id: integrationId } });
  revalidatePath("/connexions");
}
