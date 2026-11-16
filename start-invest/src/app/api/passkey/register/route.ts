import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { verifyRegistration } from "@/lib/passkeys";

export async function POST(req: Request) {
  const session = await auth();
  const uid = (session?.user as { id?: string } | undefined)?.id;
  const me = uid ? await prisma.user.findUnique({ where: { id: uid } }) : null;
  if (!me || !me.active) return new NextResponse("Accès refusé", { status: 403 });
  try {
    const { response, name } = (await req.json()) as { response: Parameters<typeof verifyRegistration>[1]; name?: string };
    await verifyRegistration(me, response, String(name ?? "Mon appareil"));
    await audit({ id: me.id, email: me.email }, "cle_acces_ajoutee", String(name ?? ""));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
