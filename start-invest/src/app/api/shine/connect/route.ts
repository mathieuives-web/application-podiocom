import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { shineAuthorizeUrl, shineConfigured } from "@/lib/connectors/shine";

// Démarre la connexion Shine d'une société : redirige vers Shine pour autorisation.
export async function GET(req: Request) {
  const session = await auth();
  if ((session?.user as { role?: string } | undefined)?.role !== "ADMIN") {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  const companyId = new URL(req.url).searchParams.get("companyId") ?? "";
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company || !shineConfigured()) {
    return NextResponse.redirect(new URL("/connexions?msg=" + encodeURIComponent("Connexion Shine non configurée."), req.url));
  }
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
