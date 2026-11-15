import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { readDocument } from "@/lib/documents";
import { audit } from "@/lib/audit";

// Téléchargement d'un document archivé (déchiffré à la volée) : fondateur avec double authentification.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const uid = (session?.user as { id?: string } | undefined)?.id;
  const me = uid ? await prisma.user.findUnique({ where: { id: uid } }) : null;
  if (!me || !me.active || me.role !== "ADMIN" || (!me.totpEnabled && process.env.REQUIRE_2FA !== "off")) {
    return new NextResponse("Accès refusé", { status: 403 });
  }
  const { id } = await params;
  const { doc, content } = await readDocument(id);
  await audit({ id: me.id, email: me.email }, "document_telecharge", doc.fileName);
  return new NextResponse(new Uint8Array(content), {
    headers: {
      "Content-Type": doc.mime,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
      "Cache-Control": "no-store",
    },
  });
}
