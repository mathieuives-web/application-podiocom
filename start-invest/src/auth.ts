import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { authConfig } from "@/auth.config";
import { decryptJson } from "@/lib/crypto";
import { verifyTotp } from "@/lib/totp";
import { audit } from "@/lib/audit";
import { verifyAuthentication } from "@/lib/passkeys";
import { consume, LR_COOKIE, needsPhoneApproval } from "@/lib/phone-approval";
import { cookies } from "next/headers";

const WINDOW = 15 * 60 * 1000;
const MAX_FAILURES = 5;

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    // Côté serveur : une session révoquée (déconnexion) n'est plus acceptée, même si le cookie revient.
    async jwt(params) {
      const token = await authConfig.callbacks.jwt(params);
      if (!params.user && typeof token.sid === "string" && (await prisma.revokedSession.findUnique({ where: { sid: token.sid } }))) return null;
      return token;
    },
  },
  providers: [
    // Face ID / empreinte / code du téléphone (clé d'accès) : un seul geste, sans mot de passe.
    Credentials({
      id: "passkey",
      name: "Clé d'accès",
      credentials: { response: { label: "Réponse", type: "text" } },
      authorize: async (credentials, request) => {
        const ip = request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
        const failures = ip ? await prisma.loginAttempt.count({ where: { success: false, ip, createdAt: { gte: new Date(Date.now() - WINDOW) } } }) : 0;
        if (failures >= MAX_FAILURES) return null;
        try {
          const user = await verifyAuthentication(JSON.parse(String(credentials?.response ?? "{}")));
          if (!user) throw new Error("clé inconnue");
          await prisma.loginAttempt.create({ data: { email: user.email, ip, success: true } });
          await audit({ id: user.id, email: user.email }, "connexion", `clé d'accès — IP ${ip ?? "?"}`);
          return { id: user.id, email: user.email, name: user.name, role: user.role };
        } catch (e) {
          await prisma.loginAttempt.create({ data: { email: "clé d'accès", ip, success: false } });
          await audit({ email: "clé d'accès" }, "connexion_echec", `clé d'accès (${(e as Error).message.slice(0, 80)}) — IP ${ip ?? "?"}`);
          return null;
        }
      },
    }),
    // Ordinateur : mot de passe déjà vérifié + demande approuvée sur le téléphone (Face ID).
    Credentials({
      id: "approval",
      name: "Validation par téléphone",
      credentials: { request: { label: "Demande", type: "text" } },
      authorize: async (credentials, request) => {
        const ip = request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
        const raw = (await cookies()).get(LR_COOKIE)?.value ?? "";
        const [id, secret] = raw.split(".");
        if (!id || !secret || id !== String(credentials?.request ?? "")) return null;
        const user = await consume(id, secret);
        (await cookies()).delete(LR_COOKIE);
        if (!user || !user.active) return null;
        await prisma.loginAttempt.create({ data: { email: user.email, ip, success: true } });
        await audit({ id: user.id, email: user.email }, "connexion", `validée par un autre appareil ou un code de secours — IP ${ip ?? "?"}`);
        return { id: user.id, email: user.email, name: user.name, role: user.role };
      },
    }),
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Mot de passe", type: "password" },
        code: { label: "Code de sécurité", type: "text" },
      },
      authorize: async (credentials, request) => {
        const email = String(credentials?.email ?? "").trim().toLowerCase();
        const password = String(credentials?.password ?? "");
        const code = String(credentials?.code ?? "");
        if (!email || !password) return null;
        const ip = request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

        // Blocage : 5 échecs en 15 minutes pour cet email ou cette adresse IP.
        const since = new Date(Date.now() - WINDOW);
        const failures = await prisma.loginAttempt.count({
          where: { success: false, createdAt: { gte: since }, OR: [{ email }, ...(ip ? [{ ip }] : [])] },
        });
        if (failures >= MAX_FAILURES) {
          await audit({ email }, "connexion_bloquee", `IP ${ip ?? "?"}`);
          return null;
        }

        const fail = async (why: string) => {
          await prisma.loginAttempt.create({ data: { email, ip, success: false } });
          await audit({ email }, "connexion_echec", `${why} — IP ${ip ?? "?"}`);
          return null;
        };

        const user = await prisma.user.findUnique({ where: { email } });
        // Comparaison faite même si le compte n'existe pas, pour ne pas révéler les emails valides.
        const valid = await bcrypt.compare(password, user?.passwordHash ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv");
        if (!user || !user.active || !valid) return fail("identifiants");
        // Face ID activé : le mot de passe seul ne suffit plus, il faut la validation sur le téléphone.
        if (await needsPhoneApproval(user)) return null;
        if (user.totpEnabled && user.totpSecret) {
          const { secret } = decryptJson<{ secret: string }>(user.totpSecret);
          if (!verifyTotp(secret, code)) return fail("code de sécurité");
        }

        await prisma.loginAttempt.create({ data: { email, ip, success: true } });
        await audit({ id: user.id, email }, "connexion", `IP ${ip ?? "?"}`);
        return { id: user.id, email: user.email, name: user.name, role: user.role };
      },
    }),
  ],
});
