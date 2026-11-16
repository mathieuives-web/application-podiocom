import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { strongAuth } from "@/lib/session";
import { newPkce, shineMcpAuthorizeUrl, shineMcpAvailable } from "@/lib/connectors/shine-mcp";

// Démarre la connexion Shine d'une société : page de connexion Shine (identifiant Shine habituel).
export async function GET(req: Request) {
  const session = await auth();
  const uid = (session?.user as { id?: string } | undefined)?.id;
  const me = uid ? await prisma.user.findUnique({ where: { id: uid } }) : null;
  if (!me || !me.active || me.role !== "ADMIN" || !(await strongAuth(me))) {
    return NextResponse.redirect(new URL("/acces", req.url));
  }
  const companyId = new URL(req.url).searchParams.get("companyId") ?? "";
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company || !shineMcpAvailable()) {
    return NextResponse.redirect(new URL("/connexions?msg=" + encodeURIComponent("Connexion Shine indisponible (adresse du site inconnue)."), req.url));
  }
  await audit({ id: me.id, email: me.email }, "shine_connexion_demarree", company.name);
  const state = randomBytes(24).toString("hex");
  const { verifier, challenge } = newPkce();
  (await cookies()).set("shine_oauth", JSON.stringify({ state, companyId, verifier }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 900,
    path: "/api/shine",
  });
  try {
    return NextResponse.redirect(await shineMcpAuthorizeUrl(state, challenge));
  } catch (e) {
    return NextResponse.redirect(new URL("/connexions?msg=" + encodeURIComponent((e as Error).message), req.url));
  }
}
