import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/session";
import { DEFAULT_REMINDER_DAYS, DEFAULT_VALIDITY_MONTHS } from "@/lib/inspections";
import { saveValidityConfig } from "./actions";
import type { InspectionType, VehicleType } from "@prisma/client";

const VEHICLE_TYPES: { value: VehicleType; label: string }[] = [
  { value: "TRUCK", label: "Camion / tracteur" },
  { value: "TRAILER", label: "Remorque" },
];

const INSPECTION_TYPES: { value: InspectionType; label: string }[] = [
  { value: "CT", label: "Contrôle technique" },
  { value: "MINE", label: "Visite Mine" },
];

export default async function ParametresPage() {
  await requireStaff();
  const configs = await prisma.validityConfig.findMany();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Paramètres</h1>
        <p className="text-sm text-slate-500">
          Définissez la durée de validité du contrôle technique et de la visite Mine, ainsi que le délai de
          rappel avant échéance, par type de véhicule.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        {VEHICLE_TYPES.map((vt) =>
          INSPECTION_TYPES.map((it) => {
            const cfg = configs.find((c) => c.vehicleType === vt.value && c.inspectionType === it.value);
            return (
              <form
                key={`${vt.value}-${it.value}`}
                action={async (formData: FormData) => {
                  "use server";
                  await saveValidityConfig(vt.value, it.value, formData);
                }}
                className="card space-y-3"
              >
                <p className="font-semibold text-sm">
                  {vt.label} — {it.label}
                </p>
                <div>
                  <label className="label">Durée de validité (mois)</label>
                  <input
                    name="validityMonths"
                    type="number"
                    min={1}
                    className="input"
                    defaultValue={cfg?.validityMonths ?? DEFAULT_VALIDITY_MONTHS}
                    required
                  />
                </div>
                <div>
                  <label className="label">Rappel (jours avant échéance)</label>
                  <input
                    name="reminderDaysBefore"
                    type="number"
                    min={0}
                    className="input"
                    defaultValue={cfg?.reminderDaysBefore ?? DEFAULT_REMINDER_DAYS}
                    required
                  />
                </div>
                <button className="btn-primary" type="submit">Enregistrer</button>
              </form>
            );
          })
        )}
      </div>
    </div>
  );
}
