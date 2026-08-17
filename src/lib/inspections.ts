import { addMonths, differenceInCalendarDays } from "date-fns";
import { prisma } from "@/lib/prisma";
import type { InspectionType, VehicleType } from "@prisma/client";

export const DEFAULT_VALIDITY_MONTHS = 6;
export const DEFAULT_REMINDER_DAYS = 30;

export async function getValidityConfig(vehicleType: VehicleType, inspectionType: InspectionType) {
  const config = await prisma.validityConfig.findUnique({
    where: { vehicleType_inspectionType: { vehicleType, inspectionType } },
  });
  return {
    validityMonths: config?.validityMonths ?? DEFAULT_VALIDITY_MONTHS,
    reminderDaysBefore: config?.reminderDaysBefore ?? DEFAULT_REMINDER_DAYS,
  };
}

export function computeExpiry(validatedOn: Date, validityMonths: number) {
  return addMonths(validatedOn, validityMonths);
}

export type InspectionStatus = "ok" | "warning" | "expired";

export function getInspectionStatus(expiresOn: Date, reminderDaysBefore: number): InspectionStatus {
  const daysLeft = differenceInCalendarDays(expiresOn, new Date());
  if (daysLeft < 0) return "expired";
  if (daysLeft <= reminderDaysBefore) return "warning";
  return "ok";
}
