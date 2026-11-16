import { createHash, randomBytes, randomInt } from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";

// Mot de passe oublié, sans e-mail : codes de secours à usage unique (gardés par le fondateur) ou lien de
// réinitialisation à usage unique créé depuis le serveur. Le nouveau mot de passe est choisi par l'utilisateur.

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const norm = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");
const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans 0/O/1/I

/** Génère 10 nouveaux codes de secours (les anciens sont annulés). Affichés une seule fois. */
export async function newRecoveryCodes(userId: string) {
  await prisma.recoveryCode.deleteMany({ where: { userId } });
  const codes = Array.from({ length: 10 }, () => {
    const c = Array.from({ length: 10 }, () => ALPH[randomInt(ALPH.length)]).join("");
    return `${c.slice(0, 5)}-${c.slice(5)}`;
  });
  await prisma.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: sha(norm(c)) })) });
  return codes;
}

export async function recoveryCodesLeft(userId: string) {
  return prisma.recoveryCode.count({ where: { userId, usedAt: null } });
}

/** Lien de réinitialisation (30 minutes, une seule fois). Renvoie le jeton en clair (à donner à l'utilisateur). */
export async function createResetToken(userId: string) {
  const token = randomBytes(32).toString("base64url");
  await prisma.passwordReset.create({ data: { tokenHash: sha(token), userId, expiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
  return token;
}

/** Adresse + code de secours valides -> jeton de réinitialisation (le code est consommé). */
export async function resetWithRecoveryCode(emailRaw: string, code: string, ip: string | null) {
  const email = emailRaw.trim().toLowerCase();
  const failures = await prisma.loginAttempt.count({ where: { success: false, createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) }, OR: [{ email }, ...(ip ? [{ ip }] : [])] } });
  if (failures >= 5) return null;
  const user = await prisma.user.findUnique({ where: { email } });
  const rc = user ? await prisma.recoveryCode.findFirst({ where: { userId: user.id, usedAt: null, codeHash: sha(norm(code)) } }) : null;
  if (!user || !user.active || !rc) {
    await prisma.loginAttempt.create({ data: { email, ip, success: false } });
    await audit({ email }, "mot_de_passe_oublie_echec", `code de secours — IP ${ip ?? "?"}`);
    return null;
  }
  const used = await prisma.recoveryCode.updateMany({ where: { id: rc.id, usedAt: null }, data: { usedAt: new Date() } });
  if (!used.count) return null;
  await audit({ id: user.id, email }, "code_de_secours_utilise", `IP ${ip ?? "?"}`);
  return createResetToken(user.id);
}

export async function resetTokenValid(token: string) {
  const r = await prisma.passwordReset.findUnique({ where: { tokenHash: sha(token) } });
  return Boolean(r && !r.usedAt && r.expiresAt > new Date());
}

/** Change le mot de passe avec un jeton valide (usage unique) et lève le blocage des essais. */
export async function setPasswordWithToken(token: string, password: string, ip: string | null) {
  const r = await prisma.passwordReset.findUnique({ where: { tokenHash: sha(token) } });
  if (!r || r.usedAt || r.expiresAt < new Date()) return { ok: false, error: "Lien expiré ou déjà utilisé : recommencez." };
  if (password.length < 12) return { ok: false, error: "12 caractères minimum." };
  const used = await prisma.passwordReset.updateMany({ where: { tokenHash: r.tokenHash, usedAt: null }, data: { usedAt: new Date() } });
  if (!used.count) return { ok: false, error: "Lien déjà utilisé." };
  const u = await prisma.user.update({ where: { id: r.userId }, data: { passwordHash: await bcrypt.hash(password, 12) } });
  await prisma.loginAttempt.deleteMany({ where: { email: u.email, success: false } });
  await audit({ id: u.id, email: u.email }, "mot_de_passe_reinitialise", `IP ${ip ?? "?"}`);
  return { ok: true };
}
