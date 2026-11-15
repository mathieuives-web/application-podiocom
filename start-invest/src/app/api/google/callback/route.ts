import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { encryptJson } from "@/lib/crypto";
import { exchangeGoogleCode, GOOGLE_SCOPES } from "@/lib/connectors/google";

// Retour de Google : accès permanent (jeton de rafraîchissement) enregistré chiffré.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (m: string) => NextResponse.redirect(new URL("/connexions?msg=" + encodeURIComponent(m), req.url));
  const session = await auth();
  const uid = (session?.user as { id?: string } | undefined)?.id;
  const me = uid ? await prisma.user.findUnique({ where: { id: uid } }) : null;
  if (!me || !me.active || me.role !== "ADMIN" || (!me.totpEnabled && process.env.REQUIRE_2FA !== "off")) {
    return NextResponse.redirect(new URL("/acces", req.url));
  }
  const jar = await cookies();
  const saved = jar.get("google_oauth")?.value;
  jar.delete({ name: "google_oauth", path: "/api/google" });
  if (url.searchParams.get("error")) return back(`Connexion Google annulée (${url.searchParams.get("error")}).`);
  let expected: { state: string; companyId: string } | null = null;
  try {
    expected = saved ? JSON.parse(saved) : null;
  } catch {
    expected = null;
  }
  if (!expected || expected.state !== url.searchParams.get("state")) return back("Connexion Google refusée (session expirée). Réessayez.");
  const granted = (url.searchParams.get("scope") ?? "").split(" ");
  const missing = GOOGLE_SCOPES.filter((s) => s.startsWith("https") && !granted.includes(s));
  if (missing.length) return back("Il faut cocher l'accès à Gmail ET à Google Drive sur l'écran Google. Recommencez en cochant toutes les cases.");
  try {
    const creds = await exchangeGoogleCode(url.searchParams.get("code") ?? "");
    // Une connexion Google par adresse et par société : une reconnexion remplace l'ancienne.
    const old = await prisma.integration.findMany({ where: { provider: "GOOGLE", companyId: expected.companyId, label: creds.email ?? "Google" } });
    for (const o of old) await prisma.integration.delete({ where: { id: o.id } });
    await prisma.integration.create({
      data: { companyId: expected.companyId, provider: "GOOGLE", label: creds.email ?? "Google", credentials: encryptJson(creds), status: "OK", lastSyncAt: new Date() },
    });
    await audit({ id: me.id, email: me.email }, "google_connecte", `${creds.email} — société ${expected.companyId}`);
    return back(`Google connecté (${creds.email}) : les agents Secrétariat trieront les e-mails et rangeront le Drive chaque matin.`);
  } catch (e) {
    console.log(`[google] connexion ÉCHOUÉE : ${(e as Error).message.slice(0, 300)}`);
    return back(`Connexion Google impossible : ${(e as Error).message}`);
  }
}
