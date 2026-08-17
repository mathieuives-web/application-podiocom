"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/session";
import type { InspectionType, VehicleType } from "@prisma/client";

export async function saveValidityConfig(
  vehicleType: VehicleType,
  inspectionType: InspectionType,
  formData: FormData
) {
  await requireStaff();

  const validityMonths = Number(formData.get("validityMonths") ?? 6);
  const reminderDaysBefore = Number(formData.get("reminderDaysBefore") ?? 30);

  await prisma.validityConfig.upsert({
    where: { vehicleType_inspectionType: { vehicleType, inspectionType } },
    update: { validityMonths, reminderDaysBefore },
    create: { vehicleType, inspectionType, validityMonths, reminderDaysBefore },
  });

  revalidatePath("/parametres");
}
