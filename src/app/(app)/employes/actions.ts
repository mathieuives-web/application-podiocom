"use server";

import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";
import type { Role } from "@prisma/client";

function str(v: FormDataEntryValue | null) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}

export async function createEmployee(formData: FormData) {
  await requireAdmin();

  const password = str(formData.get("password")) ?? Math.random().toString(36).slice(2, 10);
  const passwordHash = await bcrypt.hash(password, 10);
  const role = (str(formData.get("role")) as Role) ?? "EMPLOYEE";

  await prisma.user.create({
    data: {
      name: str(formData.get("name"))!,
      email: str(formData.get("email"))!,
      passwordHash,
      role,
      phone: str(formData.get("phone")),
      partnerId: role === "RENTER" ? str(formData.get("partnerId")) : null,
    },
  });

  revalidatePath("/employes");
}

export async function toggleEmployeeActive(userId: string, active: boolean) {
  await requireAdmin();
  await prisma.user.update({ where: { id: userId }, data: { active } });
  revalidatePath("/employes");
}

export async function resetEmployeePassword(userId: string, formData: FormData) {
  await requireAdmin();
  const newPassword = str(formData.get("password"));
  if (!newPassword) return;
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  revalidatePath("/employes");
}
