"use server";

import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireUser } from "@/lib/session";
import { audit } from "@/lib/audit";
import { encryptJson, decryptJson } from "@/lib/crypto";
import { newTotpSecret, verifyTotp } from "@/lib/totp";

const s = (v: FormDataEntryValue | null) => (v ?? "").toString().trim();

export async function createUser(formData: FormData) {
  const me = await requireAdmin();
  const password = s(formData.get("password"));
  if (password.length < 12) redirect("/acces?msg=" + encodeURIComponent("Mot de passe trop court (12 caractères minimum)."));
  await audit(me, "acces_cree", `${s(formData.get("email"))} (${s(formData.get("role")) || "MEMBER"})`);
  await prisma.user.create({
    data: {
      name: s(formData.get("name")),
      email: s(formData.get("email")).toLowerCase(),
      role: s(formData.get("role")) === "ADMIN" ? "ADMIN" : "MEMBER",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  revalidatePath("/acces");
}

export async function toggleUser(userId: string) {
  const me = await requireAdmin();
  if (me.id === userId) return;
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await prisma.user.update({ where: { id: userId }, data: { active: !u.active } });
  await audit(me, u.active ? "acces_desactive" : "acces_reactive", u.email);
  revalidatePath("/acces");
}

export async function changeMyPassword(formData: FormData) {
  const me = await requireUser();
  const current = s(formData.get("current"));
  const next = s(formData.get("next"));
  const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
  let msg = "Mot de passe modifié.";
  if (!(await bcrypt.compare(current, user.passwordHash))) msg = "Mot de passe actuel incorrect.";
  else if (next.length < 12) msg = "Nouveau mot de passe trop court (12 caractères minimum).";
  else {
    await prisma.user.update({ where: { id: me.id }, data: { passwordHash: await bcrypt.hash(next, 12) } });
    await audit(me, "mot_de_passe_modifie");
  }
  redirect("/acces?msg=" + encodeURIComponent(msg));
}

// ------------------------------------------------ double authentification

export async function startTotpSetup() {
  const me = await requireUser();
  await prisma.user.update({
    where: { id: me.id },
    data: { totpSecret: encryptJson({ secret: newTotpSecret() }), totpEnabled: false },
  });
  redirect("/acces?setup=1");
}

export async function confirmTotp(formData: FormData) {
  const me = await requireUser();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
  if (!user.totpSecret) redirect("/acces");
  const { secret } = decryptJson<{ secret: string }>(user.totpSecret);
  if (!verifyTotp(secret, s(formData.get("code")))) {
    redirect("/acces?setup=1&msg=" + encodeURIComponent("Code incorrect. Vérifiez l'heure de votre téléphone et réessayez."));
  }
  await prisma.user.update({ where: { id: me.id }, data: { totpEnabled: true } });
  await audit(me, "double_authentification_activee");
  redirect("/acces?msg=" + encodeURIComponent("Double authentification activée : le code sera demandé à chaque connexion."));
}

export async function resetUserTotp(userId: string) {
  const me = await requireAdmin();
  if (me.id === userId) return;
  const u = await prisma.user.update({ where: { id: userId }, data: { totpEnabled: false, totpSecret: null } });
  await audit(me, "double_authentification_reinitialisee", u.email);
  revalidatePath("/acces");
}

export async function removePasskey(id: string) {
  const me = await requireUser();
  const pk = await prisma.passkey.findFirst({ where: { id, userId: me.id } });
  if (!pk) return;
  await prisma.passkey.delete({ where: { id: pk.id } });
  await audit(me, "cle_acces_supprimee", pk.name);
  revalidatePath("/acces");
}
