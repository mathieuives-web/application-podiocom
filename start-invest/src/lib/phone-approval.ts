import { createHash, randomBytes, randomInt } from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";

// Connexion sur ordinateur : mot de passe + approbation sur le téléphone (Face ID), avec un code à 2 chiffres
// affiché des deux côtés (on vérifie que c'est bien SA demande). L'ordinateur garde un secret dans un cookie :
// seul lui peut finir la connexion, même si quelqu'un d'autre connaît l'identifiant de la demande.

const WINDOW = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const TTL = 3 * 60 * 1000;
export const LR_COOKIE = "lr_secret";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** Vérifie l'adresse et le mot de passe (avec blocage après 5 échecs en 15 min). */
export async function passwordCheck(emailRaw: string, password: string, ip: string | null) {
  const email = emailRaw.trim().toLowerCase();
  if (!email || !password) return null;
  const failures = await prisma.loginAttempt.count({ where: { success: false, createdAt: { gte: new Date(Date.now() - WINDOW) }, OR: [{ email }, ...(ip ? [{ ip }] : [])] } });
  if (failures >= MAX_FAILURES) {
    await audit({ email }, "connexion_bloquee", `IP ${ip ?? "?"}`);
    return null;
  }
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv");
  if (!user || !user.active || !ok) {
    await prisma.loginAttempt.create({ data: { email, ip, success: false } });
    await audit({ email }, "connexion_echec", `identifiants — IP ${ip ?? "?"}`);
    return null;
  }
  return user;
}

/** Faut-il valider sur le téléphone ? Oui dès qu'une clé d'accès (Face ID) existe et qu'il n'y a pas de code à 6 chiffres. */
export async function needsPhoneApproval(user: { id: string; totpEnabled: boolean }) {
  return !user.totpEnabled && (await prisma.passkey.count({ where: { userId: user.id } })) > 0;
}

export async function createRequest(userId: string, ip: string | null, device: string | null) {
  await prisma.loginRequest.updateMany({ where: { userId, status: "PENDING" }, data: { status: "DENIED" } }); // une seule demande à la fois
  const secret = randomBytes(32).toString("base64url");
  const code = String(randomInt(10, 100));
  const r = await prisma.loginRequest.create({ data: { userId, secretHash: hash(secret), code, ip, device: device?.slice(0, 120) ?? null, expiresAt: new Date(Date.now() + TTL) } });
  return { id: r.id, secret, code };
}

export async function requestState(id: string, secret: string) {
  const r = await prisma.loginRequest.findUnique({ where: { id } });
  if (!r || r.secretHash !== hash(secret)) return null;
  const expired = r.expiresAt < new Date() && r.status === "PENDING";
  return { status: expired ? "EXPIRED" : r.status, code: r.code, expiresAt: r.expiresAt };
}

export async function pendingFor(userId: string) {
  return prisma.loginRequest.findMany({ where: { userId, status: "PENDING", expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, take: 3, select: { id: true, code: true, ip: true, device: true, createdAt: true } });
}

export async function decide(id: string, userId: string, approve: boolean) {
  const r = await prisma.loginRequest.updateMany({ where: { id, userId, status: "PENDING", expiresAt: { gt: new Date() } }, data: { status: approve ? "APPROVED" : "DENIED" } });
  return r.count > 0;
}

/** Fin de connexion sur l'ordinateur : demande approuvée, non expirée, secret correct, utilisable une seule fois. */
export async function consume(id: string, secret: string) {
  const r = await prisma.loginRequest.findUnique({ where: { id } });
  if (!r || r.secretHash !== hash(secret) || r.status !== "APPROVED" || r.expiresAt < new Date(Date.now() - 60000)) return null;
  const used = await prisma.loginRequest.updateMany({ where: { id, status: "APPROVED" }, data: { status: "USED" } });
  if (!used.count) return null;
  return prisma.user.findUnique({ where: { id: r.userId } });
}
