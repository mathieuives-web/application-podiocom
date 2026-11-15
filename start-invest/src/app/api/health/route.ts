import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Vérification de bon fonctionnement (hébergeur) : ne renvoie aucune donnée.
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
