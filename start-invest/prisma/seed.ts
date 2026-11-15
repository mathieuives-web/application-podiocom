import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  // Compte du fondateur. Identifiants modifiables via ADMIN_EMAIL / ADMIN_PASSWORD au premier lancement.
  const email = process.env.ADMIN_EMAIL || "admin@start-invest.fr";
  const password = process.env.ADMIN_PASSWORD || "startinvest2026";
  await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: "Administrateur", role: "ADMIN", passwordHash: await bcrypt.hash(password, 10) },
  });

  const companies = [
    { id: "start-invest", name: "Start Invest", activity: "Holding du groupe", color: "#1e293b" },
    { id: "fabrique-automobile", name: "La Fabrique Automobile", activity: "Vente, dépôt-vente, recherche personnalisée, carte grise", color: "#1d4ed8" },
    { id: "auto-rac-ives", name: "Auto Rac Ives", activity: "Atelier mécanique", color: "#0891b2" },
    { id: "fabrique-restaurant", name: "La Fabrique Restaurant", activity: "Restaurant", color: "#b45309" },
    { id: "bar-lusine", name: "Le Bar L'Usine", activity: "Bar", color: "#7f1d1d" },
    { id: "sci-mapo", name: "SCI Mapo", activity: "Immobilier (SCI)", color: "#15803d" },
  ];
  for (const c of companies) await prisma.company.upsert({ where: { id: c.id }, update: {}, create: c });

  console.log(`Seed terminé. Connexion : ${email} / ${password} (à changer dans « Accès »).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
