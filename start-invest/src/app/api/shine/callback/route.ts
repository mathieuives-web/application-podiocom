import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { encryptJson } from "@/lib/crypto";
import { shineExchangeCode } from "@/lib/connectors/shine";
import { syncIntegration } from "@/lib/connectors";

// Retour de Shine après autorisation : échange le code contre les jetons, enregistre la connexion, synchronise.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (msg: string) => NextResponse.redirect(new URL("/connexions?msg=" + encodeURIComponent(msg), req.url));
  const session = await auth();
  if ((session?.user as { role?: string } | undefined)?.role !== "ADMIN") return NextResponse.redirect(new URL("/login", req.url));

  const jar = await cookies();
  const saved = jar.get("shine_oauth")?.value;
  jar.delete({ name: "shine_oauth", path: "/api/shine" });
  if (url.searchParams.get("error")) return back("Connexion Shine annulée.");
  let expected: { state: string; companyId: string } | null = null;
  try {
    expected = saved ? JSON.parse(saved) : null;
  } catch {
    expected = null;
  }
  if (!expected || expected.state !== url.searchParams.get("state")) return back("Connexion Shine refusée (session expirée). Réessayez.");
  const code = url.searchParams.get("code");
  if (!code) return back("Shine n'a pas renvoyé de code d'autorisation.");

  let msg: string;
  try {
    const creds = await shineExchangeCode(code);
    // Une seule connexion Shine par société : on remplace l'ancienne.
    const old = await prisma.integration.findFirst({ where: { companyId: expected.companyId, provider: "SHINE" } });
    const integ = old
      ? await prisma.integration.update({ where: { id: old.id }, data: { credentials: encryptJson(creds), status: "PENDING", lastError: null } })
      : await prisma.integration.create({ data: { companyId: expected.companyId, provider: "SHINE", credentials: encryptJson(creds) } });
    const r = await syncIntegration(integ.id);
    msg = `Shine connecté : ${r.accounts} compte(s), ${r.transactions} opération(s), ${r.invoices} facture(s) synchronisé(s).`;
  } catch (e) {
    msg = `Connexion Shine impossible : ${(e as Error).message}`;
  }
  return back(msg);
}
