"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/session";
import type { PartnerType } from "@prisma/client";

function str(v: FormDataEntryValue | null) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}

export async function createPartner(formData: FormData) {
  await requireStaff();

  await prisma.partner.create({
    data: {
      type: (str(formData.get("type")) as PartnerType) ?? "PROVIDER",
      name: str(formData.get("name"))!,
      contact: str(formData.get("contact")),
      phone: str(formData.get("phone")),
      email: str(formData.get("email")),
      speciality: str(formData.get("speciality")),
      notes: str(formData.get("notes")),
    },
  });

  revalidatePath("/partenaires");
}

export async function archivePartner(partnerId: string) {
  await requireStaff();
  await prisma.partner.update({ where: { id: partnerId }, data: { active: false } });
  revalidatePath("/partenaires");
}
