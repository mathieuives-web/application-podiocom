import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { googleAuthUrl, googleConfigured } from "@/lib/connectors/google";

// Démarre la connexion Google (Gmail + Drive) d'une société.
export async function GET(req: Request) {
  const session = await auth();
  const uid = (session?.user as { id?: string } | undefined)?.id;
  const me = uid ? await prisma.user.findUnique({ where: { id: uid } }) : null;
  if (!me || !me.active || me.role !== "ADMIN" || (!me.totpEnabled && process.env.REQUIRE_2FA !== "off")) {
    return NextResponse.redirect(new URL("/acces", req.url));
  }
  const companyId = new URL(req.url).searchParams.get("companyId") ?? "";
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  const back = (m: string) => NextResponse.redirect(new URL("/connexions?msg=" + encodeURIComponent(m), req.url));
  if (!company) return back("Choisissez la société.");
  if (!googleConfigured()) return back("Connexion Google non configurée (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET dans Railway).");
  const state = randomBytes(24).toString("hex");
  (await cookies()).set("google_oauth", JSON.stringify({ state, companyId }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 1800,
    path: "/api/google",
  });
  await audit({ id: me.id, email: me.email }, "google_connexion_demarree", company.name);
  return NextResponse.redirect(googleAuthUrl(state));
}
