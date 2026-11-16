import { NextResponse } from "next/server";
import { decode } from "next-auth/jwt";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";

// Déconnexion fiable (fonctionne même si la page n'a pas fini de charger) : efface le cookie de session.
export async function POST(req: Request) {
  const session = await auth();
  const u = session?.user as { id?: string; email?: string } | undefined;
  // Révocation de CETTE session côté serveur (les autres appareils restent connectés).
  const cookieHeader = req.headers.get("cookie") ?? "";
  for (const name of ["__Secure-authjs.session-token", "authjs.session-token"]) {
    const raw = cookieHeader.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
    if (!raw) continue;
    const t = await decode({ token: decodeURIComponent(raw), secret: process.env.AUTH_SECRET ?? "", salt: name }).catch(() => null);
    if (t?.sid) {
      await prisma.revokedSession.upsert({ where: { sid: String(t.sid) }, update: {}, create: { sid: String(t.sid), expiresAt: new Date(((t.exp as number) ?? Date.now() / 1000 + 86400) * 1000) } });
    }
  }
  await prisma.revokedSession.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => undefined);
  if (u?.id) await audit({ id: u.id, email: u.email ?? null }, "deconnexion", "").catch(() => undefined);
  // Page courte (et non une redirection) : le cookie est effacé de façon fiable sur tous les navigateurs, puis retour à la connexion.
  const res = new NextResponse(
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=/login"><title>Déconnexion</title></head><body style="font-family:system-ui;background:#0c0a09;color:#f5f5f4;display:flex;min-height:100vh;align-items:center;justify-content:center"><p>Déconnexion… <a href="/login" style="color:#fca5a5">continuer</a></p></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
  const names = req.headers.get("cookie")?.split(";").map((c) => c.split("=")[0].trim()).filter((n) => /authjs\.session-token/.test(n)) ?? [];
  for (const n of new Set([...names, "authjs.session-token", "__Secure-authjs.session-token"])) {
    res.cookies.set(n, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax", secure: n.startsWith("__Secure-") });
  }
  return res;
}
