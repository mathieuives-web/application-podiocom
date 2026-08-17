"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/session";
import { saveUploadedFile } from "@/lib/storage";
import { computeExpiry, getValidityConfig } from "@/lib/inspections";
import type { DocumentType, InspectionType, VehicleType } from "@prisma/client";

function str(v: FormDataEntryValue | null) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}

export async function createVehicle(formData: FormData) {
  await requireStaff();

  const vehicle = await prisma.vehicle.create({
    data: {
      type: (str(formData.get("type")) as VehicleType) ?? "TRUCK",
      name: str(formData.get("name")),
      plate: str(formData.get("plate"))!,
      chassisNumber: str(formData.get("chassisNumber"))!,
      brand: str(formData.get("brand")),
      model: str(formData.get("model")),
      year: formData.get("year") ? Number(formData.get("year")) : null,
      notes: str(formData.get("notes")),
    },
  });

  revalidatePath("/parc");
  redirect(`/parc/${vehicle.id}`);
}

export async function updateVehicle(vehicleId: string, formData: FormData) {
  await requireStaff();

  await prisma.vehicle.update({
    where: { id: vehicleId },
    data: {
      type: (str(formData.get("type")) as VehicleType) ?? undefined,
      name: str(formData.get("name")),
      plate: str(formData.get("plate"))!,
      chassisNumber: str(formData.get("chassisNumber"))!,
      brand: str(formData.get("brand")),
      model: str(formData.get("model")),
      year: formData.get("year") ? Number(formData.get("year")) : null,
      notes: str(formData.get("notes")),
    },
  });

  revalidatePath(`/parc/${vehicleId}`);
  revalidatePath("/parc");
}

export async function archiveVehicle(vehicleId: string) {
  await requireStaff();
  await prisma.vehicle.update({ where: { id: vehicleId }, data: { active: false } });
  revalidatePath("/parc");
  redirect("/parc");
}

export async function addMaintenanceRecord(vehicleId: string, formData: FormData) {
  await requireStaff();

  await prisma.maintenanceRecord.create({
    data: {
      vehicleId,
      date: new Date(str(formData.get("date")) ?? Date.now()),
      description: str(formData.get("description")) ?? "",
      cost: Number(formData.get("cost") ?? 0),
      providerId: str(formData.get("providerId")),
    },
  });

  revalidatePath(`/parc/${vehicleId}`);
}

export async function addInspection(vehicleId: string, formData: FormData) {
  await requireStaff();

  const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
  const type = str(formData.get("type")) as InspectionType;
  const validatedOn = new Date(str(formData.get("validatedOn")) ?? Date.now());
  const manualExpiry = str(formData.get("expiresOn"));

  let expiresOn: Date;
  if (manualExpiry) {
    expiresOn = new Date(manualExpiry);
  } else {
    const config = await getValidityConfig(vehicle.type, type);
    expiresOn = computeExpiry(validatedOn, config.validityMonths);
  }

  await prisma.inspection.create({
    data: {
      vehicleId,
      type,
      validatedOn,
      expiresOn,
      notes: str(formData.get("notes")),
    },
  });

  revalidatePath(`/parc/${vehicleId}`);
  revalidatePath("/parc");
}

export async function addPlannedTask(vehicleId: string, formData: FormData) {
  await requireStaff();

  await prisma.plannedTask.create({
    data: {
      vehicleId,
      description: str(formData.get("description")) ?? "",
      providerId: str(formData.get("providerId")),
      dueDate: str(formData.get("dueDate")) ? new Date(str(formData.get("dueDate"))!) : null,
    },
  });

  revalidatePath(`/parc/${vehicleId}`);
}

export async function updatePlannedTaskStatus(taskId: string, vehicleId: string, status: string) {
  await requireStaff();
  await prisma.plannedTask.update({
    where: { id: taskId },
    data: { status: status as "TODO" | "IN_PROGRESS" | "DONE" },
  });
  revalidatePath(`/parc/${vehicleId}`);
}

export async function uploadVehicleDocument(vehicleId: string, formData: FormData) {
  const user = await requireStaff();
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) return;

  const { filePath, fileName } = await saveUploadedFile(file, `vehicules/${vehicleId}`);

  await prisma.document.create({
    data: {
      type: (str(formData.get("type")) as DocumentType) ?? "PHOTO",
      filePath,
      fileName,
      vehicleId,
      uploadedById: user.id,
      note: str(formData.get("note")),
    },
  });

  revalidatePath(`/parc/${vehicleId}`);
}

export async function deleteDocument(documentId: string, vehicleId: string) {
  await requireStaff();
  await prisma.document.delete({ where: { id: documentId } });
  revalidatePath(`/parc/${vehicleId}`);
}
