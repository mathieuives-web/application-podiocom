import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { encryptJson } from "@/lib/crypto";
import { shineMcpExchange } from "@/lib/connectors/shine-mcp";
import { syncIntegration } from "@/lib/connectors";

// Retour de Shine après autorisation : échange le code contre les jetons, enregistre la connexion, synchronise.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (msg: string) => NextResponse.redirect(new URL("/connexions?msg=" + encodeURIComponent(msg), req.url));
  const session = await auth();
  const uid = (session?.user as { id?: string } | undefined)?.id;
  const me = uid ? await prisma.user.findUnique({ where: { id: uid } }) : null;
  if (!me || !me.active || me.role !== "ADMIN" || (!me.totpEnabled && process.env.REQUIRE_2FA !== "off")) {
    return NextResponse.redirect(new URL("/acces", req.url));
  }

  const jar = await cookies();
  const saved = jar.get("shine_oauth")?.value;
  jar.delete({ name: "shine_oauth", path: "/api/shine" });
  if (url.searchParams.get("error")) {
    console.log(`[shine] retour avec erreur : ${url.searchParams.get("error")} ${url.searchParams.get("error_description") ?? ""}`.slice(0, 300));
    return back("Connexion Shine annulée.");
  }
  let expected: { state: string; companyId: string; verifier: string } | null = null;
  try {
    expected = saved ? JSON.parse(saved) : null;
  } catch {
    expected = null;
  }
  if (!expected || expected.state !== url.searchParams.get("state")) {
    console.log("[shine] retour refusé : session expirée ou état invalide");
    return back("Connexion Shine refusée (session expirée). Réessayez.");
  }
  const code = url.searchParams.get("code");
  if (!code) return back("Shine n'a pas renvoyé de code d'autorisation.");

  let msg: string;
  try {
    const creds = await shineMcpExchange(code, expected.verifier);
    // Une seule connexion Shine par société : on remplace l'ancienne.
    const old = await prisma.integration.findFirst({ where: { companyId: expected.companyId, provider: "SHINE" } });
    const integ = old
      ? await prisma.integration.update({ where: { id: old.id }, data: { credentials: encryptJson(creds), status: "PENDING", lastError: null } })
      : await prisma.integration.create({ data: { companyId: expected.companyId, provider: "SHINE", credentials: encryptJson(creds) } });
    await audit(me, "shine_connecte", `société ${expected.companyId}`);
    const r = await syncIntegration(integ.id);
    msg = `Shine connecté : ${r.accounts} compte(s), ${r.transactions} opération(s), ${r.invoices} facture(s) synchronisé(s).`;
    console.log(`[shine] connexion OK pour ${expected.companyId} : ${r.accounts} compte(s), ${r.transactions} ligne(s), ${r.invoices} facture(s)`);
  } catch (e) {
    msg = `Connexion Shine impossible : ${(e as Error).message}`;
    console.log(`[shine] connexion ÉCHOUÉE pour ${expected.companyId} : ${(e as Error).message.slice(0, 300)}`);
  }
  return back(msg);
}
