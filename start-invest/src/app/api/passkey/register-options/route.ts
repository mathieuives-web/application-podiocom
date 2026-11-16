import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { registrationOptions } from "@/lib/passkeys";

// Enregistrer Face ID / empreinte sur cet appareil : réservé à l'utilisateur connecté, pour son propre compte.
export async function POST() {
  const session = await auth();
  const uid = (session?.user as { id?: string } | undefined)?.id;
  const me = uid ? await prisma.user.findUnique({ where: { id: uid } }) : null;
  if (!me || !me.active) return new NextResponse("Accès refusé", { status: 403 });
  return NextResponse.json(await registrationOptions(me));
}
