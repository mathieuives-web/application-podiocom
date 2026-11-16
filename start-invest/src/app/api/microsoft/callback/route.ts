import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { encryptJson } from "@/lib/crypto";
import { exchangeMicrosoftCode } from "@/lib/connectors/microsoft";

// Retour de Microsoft : accès permanent enregistré chiffré.
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
  const saved = jar.get("microsoft_oauth")?.value;
  jar.delete({ name: "microsoft_oauth", path: "/api/microsoft" });
  if (url.searchParams.get("error")) return back(`Connexion Outlook annulée (${url.searchParams.get("error")}).`);
  let expected: { state: string; companyId: string } | null = null;
  try {
    expected = saved ? JSON.parse(saved) : null;
  } catch {
    expected = null;
  }
  if (!expected || expected.state !== url.searchParams.get("state")) return back("Connexion Outlook refusée (session expirée). Réessayez.");
  try {
    const creds = await exchangeMicrosoftCode(url.searchParams.get("code") ?? "");
    const label = creds.email ?? "Outlook";
    for (const o of await prisma.integration.findMany({ where: { provider: "OUTLOOK", companyId: expected.companyId, label } })) await prisma.integration.delete({ where: { id: o.id } });
    await prisma.integration.create({ data: { companyId: expected.companyId, provider: "OUTLOOK", label, credentials: encryptJson(creds), status: "OK", lastSyncAt: new Date() } });
    await audit({ id: me.id, email: me.email }, "outlook_connecte", `${label} — société ${expected.companyId}`);
    return back(`Outlook connecté (${label}) : le secrétariat le trie chaque matin.`);
  } catch (e) {
    console.log(`[outlook] connexion ÉCHOUÉE : ${(e as Error).message.slice(0, 300)}`);
    return back(`Connexion Outlook impossible : ${(e as Error).message}`);
  }
}
