import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { bankConfigured, startBankAuth } from "@/lib/connectors/enablebanking";

// Démarre la connexion d'une banque pour une société (redirection vers la banque via Enable Banking).
export async function GET(req: Request) {
  const session = await auth();
  const uid = (session?.user as { id?: string } | undefined)?.id;
  const me = uid ? await prisma.user.findUnique({ where: { id: uid } }) : null;
  if (!me || !me.active || me.role !== "ADMIN" || (!me.totpEnabled && process.env.REQUIRE_2FA !== "off")) {
    return NextResponse.redirect(new URL("/acces", req.url));
  }
  const q = new URL(req.url).searchParams;
  const companyId = q.get("companyId") ?? "";
  const bank = q.get("bank") ?? "";
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  const back = (m: string) => NextResponse.redirect(new URL("/connexions?msg=" + encodeURIComponent(m), req.url));
  if (!company || !bank) return back("Choisissez la société et la banque.");
  if (!bankConfigured()) return back("Connexion bancaire non configurée (ENABLE_BANKING_APP_ID / ENABLE_BANKING_PRIVATE_KEY).");
  const state = randomBytes(24).toString("hex");
  try {
    const url = await startBankAuth(bank, state);
    (await cookies()).set("bank_oauth", JSON.stringify({ state, companyId, bank }), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 1800,
      path: "/api/banque",
    });
    await audit({ id: me.id, email: me.email }, "banque_connexion_demarree", `${company.name} — ${bank}`);
    return NextResponse.redirect(url);
  } catch (e) {
    console.log(`[banque] démarrage ÉCHOUÉ ${company.name} ${bank} : ${(e as Error).message.slice(0, 300)}`);
    return back(`Connexion à ${bank} impossible : ${(e as Error).message}`);
  }
}
