"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/session";
import type { BookingKind, BookingStatus } from "@prisma/client";

function str(v: FormDataEntryValue | null) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}

export async function createBooking(formData: FormData) {
  await requireStaff();

  const kind = (str(formData.get("kind")) as BookingKind) ?? "MISSION";

  await prisma.booking.create({
    data: {
      vehicleId: str(formData.get("vehicleId"))!,
      kind,
      driverId: kind === "MISSION" ? str(formData.get("driverId")) : null,
      renterId: kind === "LOCATION" ? str(formData.get("renterId")) : null,
      departureDate: new Date(str(formData.get("departureDate"))!),
      departureLocation: str(formData.get("departureLocation")),
      arrivalDate: str(formData.get("arrivalDate")) ? new Date(str(formData.get("arrivalDate"))!) : null,
      arrivalLocation: str(formData.get("arrivalLocation")),
      notes: str(formData.get("notes")),
    },
  });

  revalidatePath("/planning");
}

export async function updateBookingStatus(bookingId: string, status: string) {
  await requireStaff();
  await prisma.booking.update({ where: { id: bookingId }, data: { status: status as BookingStatus } });
  revalidatePath("/planning");
}
