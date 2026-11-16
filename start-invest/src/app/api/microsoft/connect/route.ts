import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { strongAuth } from "@/lib/session";
import { microsoftAuthUrl, microsoftConfigured } from "@/lib/connectors/microsoft";

// Démarre la connexion Outlook d'une société (ou de la boîte personnelle du fondateur).
export async function GET(req: Request) {
  const session = await auth();
  const uid = (session?.user as { id?: string } | undefined)?.id;
  const me = uid ? await prisma.user.findUnique({ where: { id: uid } }) : null;
  if (!me || !me.active || me.role !== "ADMIN" || !(await strongAuth(me))) {
    return NextResponse.redirect(new URL("/acces", req.url));
  }
  const companyId = new URL(req.url).searchParams.get("companyId") ?? "";
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  const back = (m: string) => NextResponse.redirect(new URL("/connexions?msg=" + encodeURIComponent(m), req.url));
  if (!company) return back("Choisissez la société.");
  if (!microsoftConfigured()) return back("Connexion Outlook non configurée (MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET dans Railway).");
  const state = randomBytes(24).toString("hex");
  (await cookies()).set("microsoft_oauth", JSON.stringify({ state, companyId }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 1800,
    path: "/api/microsoft",
  });
  await audit({ id: me.id, email: me.email }, "outlook_connexion_demarree", company.name);
  return NextResponse.redirect(microsoftAuthUrl(state));
}
