import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { audit } from "@/lib/audit";
import { decide } from "@/lib/phone-approval";
import { verifyAuthentication } from "@/lib/passkeys";

// Téléphone : approuver (avec Face ID / empreinte, vérifié côté serveur) ou refuser une connexion d'ordinateur.
export async function POST(req: Request) {
  const u = (await auth())?.user as { id?: string; email?: string } | undefined;
  if (!u?.id) return NextResponse.json({ ok: false }, { status: 401 });
  const { id, approve, response } = (await req.json()) as { id: string; approve: boolean; response?: Parameters<typeof verifyAuthentication>[0] };
  if (approve) {
    const who = response ? await verifyAuthentication(response).catch(() => null) : null;
    if (!who || who.id !== u.id) return NextResponse.json({ ok: false, error: "Face ID non vérifié." }, { status: 403 });
  }
  const ok = await decide(String(id), u.id, Boolean(approve));
  await audit({ id: u.id, email: u.email ?? null }, approve ? "connexion_ordinateur_approuvee" : "connexion_ordinateur_refusee", String(id));
  return NextResponse.json({ ok });
}
