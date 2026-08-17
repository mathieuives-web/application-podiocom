"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { saveUploadedFile } from "@/lib/storage";
import type { DocumentType } from "@prisma/client";

function str(v: FormDataEntryValue | null) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}

export async function uploadMissionDocument(bookingId: string, formData: FormData) {
  const user = await requireUser();

  const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });

  // Sécurité : un chauffeur/locataire ne peut ajouter un document que sur SA mission.
  const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const isOwner =
    dbUser.role === "ADMIN" ||
    dbUser.role === "EMPLOYEE" ||
    (dbUser.role === "DRIVER" && booking.driverId === user.id) ||
    (dbUser.role === "RENTER" && booking.renterId && booking.renterId === dbUser.partnerId);
  if (!isOwner) throw new Error("Accès refusé à cette mission.");

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) return;

  const { filePath, fileName } = await saveUploadedFile(file, `missions/${bookingId}`);

  await prisma.document.create({
    data: {
      type: (str(formData.get("type")) as DocumentType) ?? "FUEL_RECEIPT",
      filePath,
      fileName,
      vehicleId: booking.vehicleId,
      bookingId,
      uploadedById: user.id,
      note: str(formData.get("note")),
    },
  });

  revalidatePath("/mes-missions");
}
