import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export type SessionUser = { id: string; name?: string | null; email?: string | null; role: string; totpEnabled: boolean };

/** Utilisateur connecté, relu en base à chaque requête (un compte désactivé perd l'accès immédiatement). */
export async function requireUser(): Promise<SessionUser> {
  const session = await auth();
  const id = (session?.user as { id?: string } | undefined)?.id;
  if (!id) redirect("/login");
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user || !user.active) redirect("/login");
  return { id: user.id, name: user.name, email: user.email, role: user.role, totpEnabled: await strongAuth(user) };
}

/**
 * Actions sensibles (banques, documents, accès, agents) : fondateur uniquement, et double
 * authentification obligatoire (désactivable uniquement avec REQUIRE_2FA=off, déconseillé).
 */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") redirect("/agents");
  if (!user.totpEnabled) {
    redirect("/acces?msg=" + encodeURIComponent("Activez la double authentification pour accéder à cette fonction."));
  }
  return user;
}

export const isAdmin = (role?: string | null) => role === "ADMIN";

/**
 * Authentification forte : code à 6 chiffres activé OU clé d'accès (Face ID / empreinte / code du téléphone,
 * qui combine l'appareil et la vérification de la personne).
 */
export async function strongAuth(user: { id: string; totpEnabled: boolean }) {
  if (process.env.REQUIRE_2FA === "off" || user.totpEnabled) return true;
  return (await prisma.passkey.count({ where: { userId: user.id } })) > 0;
}
