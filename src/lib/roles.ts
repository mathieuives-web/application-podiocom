import type { Role } from "@prisma/client";

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrateur",
  EMPLOYEE: "Employé",
  DRIVER: "Chauffeur",
  RENTER: "Locataire",
};

export function isStaff(role?: string | null) {
  return role === "ADMIN" || role === "EMPLOYEE";
}

export function isAdmin(role?: string | null) {
  return role === "ADMIN";
}
