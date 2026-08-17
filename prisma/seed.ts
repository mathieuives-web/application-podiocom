import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const adminPassword = await bcrypt.hash("podiocom2026", 10);
  const admin = await prisma.user.upsert({
    where: { email: "admin@podiocom.com" },
    update: {},
    create: {
      email: "admin@podiocom.com",
      name: "Administrateur Podiocom",
      passwordHash: adminPassword,
      role: "ADMIN",
    },
  });

  const driverPassword = await bcrypt.hash("chauffeur2026", 10);
  const driver = await prisma.user.upsert({
    where: { email: "chauffeur1@podiocom.com" },
    update: {},
    create: {
      email: "chauffeur1@podiocom.com",
      name: "Amadou Diallo",
      passwordHash: driverPassword,
      role: "DRIVER",
    },
  });

  const provider = await prisma.partner.upsert({
    where: { id: "seed-provider-1" },
    update: {},
    create: {
      id: "seed-provider-1",
      type: "PROVIDER",
      name: "Garage Central",
      contact: "M. Traoré",
      phone: "+225 07 00 00 00",
      speciality: "Mécanique générale",
    },
  });

  const renterPartner = await prisma.partner.upsert({
    where: { id: "seed-renter-1" },
    update: {},
    create: {
      id: "seed-renter-1",
      type: "RENTER",
      name: "Société Koffi Transport",
      contact: "Mme Koffi",
      phone: "+225 05 00 00 00",
    },
  });

  const renterPassword = await bcrypt.hash("locataire2026", 10);
  await prisma.user.upsert({
    where: { email: "locataire1@podiocom.com" },
    update: {},
    create: {
      email: "locataire1@podiocom.com",
      name: "Mme Koffi",
      passwordHash: renterPassword,
      role: "RENTER",
      partnerId: renterPartner.id,
    },
  });

  await prisma.validityConfig.upsert({
    where: { vehicleType_inspectionType: { vehicleType: "TRUCK", inspectionType: "CT" } },
    update: {},
    create: { vehicleType: "TRUCK", inspectionType: "CT", validityMonths: 6, reminderDaysBefore: 30 },
  });
  await prisma.validityConfig.upsert({
    where: { vehicleType_inspectionType: { vehicleType: "TRUCK", inspectionType: "MINE" } },
    update: {},
    create: { vehicleType: "TRUCK", inspectionType: "MINE", validityMonths: 12, reminderDaysBefore: 30 },
  });
  await prisma.validityConfig.upsert({
    where: { vehicleType_inspectionType: { vehicleType: "TRAILER", inspectionType: "CT" } },
    update: {},
    create: { vehicleType: "TRAILER", inspectionType: "CT", validityMonths: 6, reminderDaysBefore: 30 },
  });
  await prisma.validityConfig.upsert({
    where: { vehicleType_inspectionType: { vehicleType: "TRAILER", inspectionType: "MINE" } },
    update: {},
    create: { vehicleType: "TRAILER", inspectionType: "MINE", validityMonths: 12, reminderDaysBefore: 30 },
  });

  const truck = await prisma.vehicle.upsert({
    where: { plate: "CI-1234-AB" },
    update: {},
    create: {
      type: "TRUCK",
      name: "Tracteur 1",
      plate: "CI-1234-AB",
      chassisNumber: "VF1CH0001234567",
      brand: "Volvo",
      model: "FH16",
      year: 2019,
    },
  });

  await prisma.vehicle.upsert({
    where: { plate: "CI-5678-CD" },
    update: {},
    create: {
      type: "TRAILER",
      name: "Remorque 1",
      plate: "CI-5678-CD",
      chassisNumber: "VF1RM0007654321",
      brand: "Schmitz",
      year: 2020,
    },
  });

  const past = new Date();
  past.setMonth(past.getMonth() - 5);
  const expiry = new Date(past);
  expiry.setMonth(expiry.getMonth() + 6);

  await prisma.inspection.create({
    data: { vehicleId: truck.id, type: "CT", validatedOn: past, expiresOn: expiry },
  });

  await prisma.maintenanceRecord.create({
    data: {
      vehicleId: truck.id,
      date: new Date(),
      description: "Vidange + filtres",
      cost: 150000,
      providerId: provider.id,
    },
  });

  const departure = new Date();
  departure.setDate(departure.getDate() + 2);

  await prisma.booking.create({
    data: {
      vehicleId: truck.id,
      kind: "MISSION",
      driverId: driver.id,
      departureDate: departure,
      departureLocation: "Abidjan",
      arrivalLocation: "Yamoussoukro",
      status: "PLANNED",
    },
  });

  console.log("Seed terminé.");
  console.log("Comptes créés :");
  console.log("  admin@podiocom.com / podiocom2026");
  console.log("  chauffeur1@podiocom.com / chauffeur2026");
  console.log("  locataire1@podiocom.com / locataire2026");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
