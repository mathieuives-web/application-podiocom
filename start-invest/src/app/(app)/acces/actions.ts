"use server";

import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireUser } from "@/lib/session";

const s = (v: FormDataEntryValue | null) => (v ?? "").toString().trim();

export async function createUser(formData: FormData) {
  await requireAdmin();
  const password = s(formData.get("password"));
  if (password.length < 10) redirect("/acces?msg=" + encodeURIComponent("Mot de passe trop court (10 caractères minimum)."));
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
  revalidatePath("/acces");
}

export async function changeMyPassword(formData: FormData) {
  const me = await requireUser();
  const current = s(formData.get("current"));
  const next = s(formData.get("next"));
  const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
  let msg = "Mot de passe modifié.";
  if (!(await bcrypt.compare(current, user.passwordHash))) msg = "Mot de passe actuel incorrect.";
  else if (next.length < 10) msg = "Nouveau mot de passe trop court (10 caractères minimum).";
  else await prisma.user.update({ where: { id: me.id }, data: { passwordHash: await bcrypt.hash(next, 10) } });
  redirect("/acces?msg=" + encodeURIComponent(msg));
}
