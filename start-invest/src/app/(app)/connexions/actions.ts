"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import { encryptJson } from "@/lib/crypto";
import { PROVIDERS, syncIntegration } from "@/lib/connectors";
import { audit } from "@/lib/audit";
import { cancelLive, finishLive, startLive } from "@/lib/connectors/live-browser";
import { AUTOCERFA_DEFAULT_URL } from "@/lib/connectors/autocerfa";
import { GTAPRO_DEFAULT_URL } from "@/lib/connectors/gtapro";

export async function addIntegration(formData: FormData) {
  const me = await requireAdmin();
  const backTo = formData.get("back") === "/tout-connecter" ? "/tout-connecter" : "/connexions";
  const provider = PROVIDERS.find((p) => p.id === formData.get("provider") && p.available);
  if (!provider) throw new Error("Connecteur indisponible.");
  const creds: Record<string, string> = {};
  for (const f of provider.fields) {
    const v = (formData.get(f.name) ?? "").toString().trim();
    if (!v && !f.optional) redirect(`${backTo}?msg=${encodeURIComponent(`Champ manquant : ${f.label}`)}`);
    if (v) creds[f.name] = v;
  }
  const integ = await prisma.integration.create({
    data: {
      companyId: (formData.get("companyId") ?? "").toString(),
      provider: provider.id,
      label: provider.id === "PORTAIL" ? creds.name?.slice(0, 80) ?? "Portail" : provider.id === "IMAP" ? creds.email?.toLowerCase().slice(0, 120) ?? null : (formData.get("label") ?? "").toString().trim() || null,
      credentials: encryptJson(creds),
    },
  });
  await audit(me, "connexion_outil_ajoutee", `${provider.name} — société ${integ.companyId}`);
  if (provider.id === "PORTAIL") {
    if (!/^https:\/\//.test(creds.url ?? "")) redirect(`/connexions?msg=${encodeURIComponent("Adresse du portail invalide (https://...).")}`);
    if (!creds.password) {
      const sid = await startLive(integ.id, me.id, creds.url!);
      redirect(`/connexions/direct?sid=${sid}&nom=${encodeURIComponent(creds.name ?? "le portail")}`);
    }
    revalidatePath("/connexions");
    redirect(`${backTo}?msg=${encodeURIComponent(`${creds.name} enregistré : les agents peuvent maintenant y chercher des informations.`)}`);
  }
  const site = ROBOT_SITES[provider.id];
  if (site && !creds.password) {
    // Pas de mot de passe : le fondateur se connecte lui-même dans la fenêtre en direct.
    const sid = await startLive(integ.id, me.id, site.url);
    redirect(`/connexions/direct?sid=${sid}&nom=${encodeURIComponent(site.name)}`);
  }
  if (site) {
    // Le robot met plusieurs minutes : il travaille en arrière-plan.
    after(() => syncIntegration(integ.id, { force: true }).then(() => undefined).catch(() => undefined));
    revalidatePath("/connexions");
    redirect(`/connexions?msg=${encodeURIComponent(`${site.name} enregistré. Le robot se connecte maintenant (2 à 5 minutes) : rechargez la page pour voir le résultat.`)}`);
  }
  let msg: string;
  try {
    const r = await syncIntegration(integ.id);
    msg = `${provider.name} connecté : ${r.accounts} compte(s), ${r.transactions} opération(s), ${r.invoices} facture(s) synchronisé(s).`;
  } catch (e) {
    msg = `${provider.name} enregistré mais la synchronisation a échoué : ${(e as Error).message}`;
  }
  revalidatePath("/connexions");
  revalidatePath("/tout-connecter");
  revalidatePath("/finances");
  redirect(`${backTo}?msg=${encodeURIComponent(msg)}`);
}

export async function syncNow(integrationId: string) {
  const me = await requireAdmin();
  await audit(me, "synchronisation_manuelle", integrationId);
  const integ = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  if (ROBOT_SITES[integ.provider]) {
    await prisma.integration.update({ where: { id: integrationId }, data: { status: "PENDING", lastError: null } });
    after(() => syncIntegration(integrationId, { force: true }).then(() => undefined).catch(() => undefined));
    revalidatePath("/connexions");
    redirect(`/connexions?msg=${encodeURIComponent(`Le robot ${ROBOT_SITES[integ.provider].name} travaille (2 à 5 minutes) : rechargez la page pour voir le résultat.`)}`);
  }
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

const ROBOT_SITES: Record<string, { name: string; url: string }> = {
  AUTOCERFA: { name: "Auto Cerfa", url: AUTOCERFA_DEFAULT_URL },
  GTAPRO: { name: "GTA Pro", url: GTAPRO_DEFAULT_URL },
};

/** Ouvre la fenêtre de connexion en direct pour un logiciel sans API. */
export async function startDirect(integrationId: string) {
  const me = await requireAdmin();
  const integ = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  const site = ROBOT_SITES[integ.provider] ?? (integ.provider === "PORTAIL" ? { name: integ.label ?? "Portail", url: "" } : undefined);
  if (!site) throw new Error("Connexion en direct indisponible pour cet outil.");
  await audit(me, "connexion_directe_ouverte", `${site.name} — société ${integ.companyId}`);
  const sid = await startLive(integ.id, me.id, site.url);
  redirect(`/connexions/direct?sid=${sid}&nom=${encodeURIComponent(site.name)}`);
}

export async function finishDirect(sid: string) {
  const me = await requireAdmin();
  const integrationId = await finishLive(sid, me.id);
  await audit(me, "connexion_directe_enregistree", integrationId);
  after(() => syncIntegration(integrationId, { force: true }).then(() => undefined).catch(() => undefined));
  revalidatePath("/connexions");
  revalidatePath("/tout-connecter");
  redirect(`/tout-connecter?msg=${encodeURIComponent("Session enregistrée : c'est connecté. Le robot fait sa première lecture maintenant (2 à 5 minutes), puis travaille tout seul chaque jour.")}`);
}

export async function cancelDirect(sid: string) {
  const me = await requireAdmin();
  await cancelLive(sid, me.id).catch(() => undefined);
  redirect("/tout-connecter");
}

const PRESENCE = ["website", "instagram", "facebook", "tiktok", "googleBusiness", "linkedin"] as const;

/** Adresses du site et des réseaux sociaux d'une société (suivies par son agent Site & réseaux). */
export async function setPresence(companyId: string, formData: FormData) {
  const me = await requireAdmin();
  const data: Record<string, string | null> = {};
  for (const k of PRESENCE) {
    let v = (formData.get(k) ?? "").toString().trim().slice(0, 300);
    if (v && !/^https?:\/\//i.test(v) && !v.startsWith("@")) v = `https://${v}`;
    data[k] = v || null;
  }
  const c = await prisma.company.update({ where: { id: companyId }, data });
  await audit(me, "presence_en_ligne", c.name);
  revalidatePath("/connexions");
}

/**
 * Connexion en un clic depuis « Tout connecter » : crée la connexion prévue pour la société (si elle n'existe pas)
 * et ouvre la fenêtre en direct où le fondateur tape ses identifiants.
 */
export async function quickConnect(provider: string, companyName: string, label?: string, url?: string) {
  const me = await requireAdmin();
  if (!["AUTOCERFA", "GTAPRO", "PORTAIL"].includes(provider)) throw new Error("Connexion directe indisponible.");
  const company = await prisma.company.findFirstOrThrow({ where: { name: companyName } });
  let integ = await prisma.integration.findFirst({ where: { provider, companyId: company.id, ...(provider === "PORTAIL" ? { label } : {}) } });
  if (!integ) {
    integ = await prisma.integration.create({
      data: { companyId: company.id, provider, label: provider === "PORTAIL" ? label ?? "Portail" : null, credentials: encryptJson(provider === "PORTAIL" ? { name: label, url, purpose: label === "Autodata" ? "temps de main-d'œuvre et valeurs constructeur" : undefined } : url ? { url } : {}) },
    });
    await audit(me, "connexion_outil_ajoutee", `${provider} ${label ?? ""} — ${company.name}`);
  }
  const site = ROBOT_SITES[provider] ?? { name: label ?? "le portail", url: url ?? "" };
  const sid = await startLive(integ.id, me.id, site.url);
  redirect(`/connexions/direct?sid=${sid}&nom=${encodeURIComponent(site.name)}`);
}
