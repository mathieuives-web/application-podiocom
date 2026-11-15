import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { shineAuthorizeUrl, shineConfigured } from "@/lib/connectors/shine";

// Démarre la connexion Shine d'une société : redirige vers Shine pour autorisation.
export async function GET(req: Request) {
  const session = await auth();
  const uid = (session?.user as { id?: string } | undefined)?.id;
  const me = uid ? await prisma.user.findUnique({ where: { id: uid } }) : null;
  if (!me || !me.active || me.role !== "ADMIN" || (!me.totpEnabled && process.env.REQUIRE_2FA !== "off")) {
    return NextResponse.redirect(new URL("/acces", req.url));
  }
  const companyId = new URL(req.url).searchParams.get("companyId") ?? "";
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company || !shineConfigured()) {
    return NextResponse.redirect(new URL("/connexions?msg=" + encodeURIComponent("Connexion Shine non configurée."), req.url));
  }
  await audit({ id: me.id, email: me.email }, "shine_connexion_demarree", company.name);
  const state = randomBytes(24).toString("hex");
  (await cookies()).set("shine_oauth", JSON.stringify({ state, companyId }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/api/shine",
  });
  return NextResponse.redirect(shineAuthorizeUrl(state));
}
