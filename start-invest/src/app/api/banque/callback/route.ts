import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { encryptJson } from "@/lib/crypto";
import { createBankSession } from "@/lib/connectors/enablebanking";
import { syncIntegration } from "@/lib/connectors";

// Retour de la banque : ouverture de la session d'accès, enregistrement chiffré, première synchro.
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
  const saved = jar.get("bank_oauth")?.value;
  jar.delete({ name: "bank_oauth", path: "/api/banque" });
  if (url.searchParams.get("error")) {
    console.log(`[banque] retour avec erreur : ${url.searchParams.get("error")} ${url.searchParams.get("error_description") ?? ""}`.slice(0, 300));
    return back(`Connexion bancaire annulée ou refusée par la banque (${url.searchParams.get("error")}).`);
  }
  let expected: { state: string; companyId: string; bank: string } | null = null;
  try {
    expected = saved ? JSON.parse(saved) : null;
  } catch {
    expected = null;
  }
  if (!expected || expected.state !== url.searchParams.get("state")) return back("Connexion bancaire refusée (session expirée). Réessayez.");
  const code = url.searchParams.get("code");
  if (!code) return back("La banque n'a pas renvoyé d'autorisation.");

  let msg: string;
  try {
    const creds = await createBankSession(code, expected.bank);
    const integ = await prisma.integration.create({
      data: { companyId: expected.companyId, provider: "BANQUE", label: expected.bank, credentials: encryptJson(creds) },
    });
    await audit({ id: me.id, email: me.email }, "banque_connectee", `${expected.bank} — société ${expected.companyId} — ${creds.accounts.length} compte(s)`);
    const r = await syncIntegration(integ.id);
    msg = `${expected.bank} connectée : ${r.accounts} compte(s), ${r.transactions} opération(s) importée(s). Accord valable jusqu'au ${new Date(creds.validUntil).toLocaleDateString("fr-FR")}.`;
    console.log(`[banque] connexion OK ${expected.companyId} ${expected.bank} : ${r.accounts} compte(s), ${r.transactions} opération(s)`);
  } catch (e) {
    msg = `Connexion bancaire impossible : ${(e as Error).message}`;
    console.log(`[banque] connexion ÉCHOUÉE ${expected.companyId} ${expected.bank} : ${(e as Error).message.slice(0, 300)}`);
  }
  return back(msg);
}
