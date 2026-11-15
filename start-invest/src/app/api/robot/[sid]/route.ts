import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { liveAction, liveScreenshot, type LiveAction } from "@/lib/connectors/live-browser";

// Fenêtre de connexion en direct : écran (GET) et actions du fondateur (POST). Fondateur avec 2FA uniquement.
async function admin() {
  const session = await auth();
  const uid = (session?.user as { id?: string } | undefined)?.id;
  const me = uid ? await prisma.user.findUnique({ where: { id: uid } }) : null;
  if (!me || !me.active || me.role !== "ADMIN" || (!me.totpEnabled && process.env.REQUIRE_2FA !== "off")) return null;
  return me;
}

export async function GET(_req: Request, { params }: { params: Promise<{ sid: string }> }) {
  const me = await admin();
  if (!me) return new NextResponse("Accès refusé", { status: 403 });
  const { sid } = await params;
  try {
    const { image, url } = await liveScreenshot(sid, me.id);
    return new NextResponse(new Uint8Array(image), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Page-Url": encodeURI(url).slice(0, 500) },
    });
  } catch (e) {
    return new NextResponse((e as Error).message, { status: 410 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ sid: string }> }) {
  const me = await admin();
  if (!me) return new NextResponse("Accès refusé", { status: 403 });
  const { sid } = await params;
  try {
    const action = (await req.json()) as LiveAction;
    await liveAction(sid, me.id, action);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
