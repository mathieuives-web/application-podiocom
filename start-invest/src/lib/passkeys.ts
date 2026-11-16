import { cookies } from "next/headers";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON, AuthenticatorTransportFuture } from "@simplewebauthn/types";
import { prisma } from "@/lib/prisma";
import { decryptJson, encryptJson } from "@/lib/crypto";

// Clés d'accès (WebAuthn) : connexion par Face ID, empreinte ou code du téléphone. La clé privée ne quitte
// jamais l'appareil ; le serveur garde seulement la clé publique. Liée au domaine de l'application (inutile sur
// un faux site), et la vérification de l'utilisateur (visage / empreinte / code) est exigée à chaque fois.

const CHALLENGE_COOKIE = "pk_challenge";

function rp() {
  const url = new URL(process.env.NEXTAUTH_URL || "http://localhost:3000");
  return { rpID: url.hostname, origin: url.origin };
}

async function saveChallenge(kind: "reg" | "auth", challenge: string, userId?: string) {
  (await cookies()).set(CHALLENGE_COOKIE, encryptJson({ kind, challenge, userId, exp: Date.now() + 5 * 60 * 1000 }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 300,
    path: "/",
  });
}

async function takeChallenge(kind: "reg" | "auth") {
  const jar = await cookies();
  const raw = jar.get(CHALLENGE_COOKIE)?.value;
  jar.delete(CHALLENGE_COOKIE);
  if (!raw) throw new Error("Demande expirée : recommencez.");
  const c = decryptJson<{ kind: string; challenge: string; userId?: string; exp: number }>(raw);
  if (c.kind !== kind || c.exp < Date.now()) throw new Error("Demande expirée : recommencez.");
  return c;
}

export async function registrationOptions(user: { id: string; email: string; name: string }) {
  const existing = await prisma.passkey.findMany({ where: { userId: user.id } });
  const options = await generateRegistrationOptions({
    rpName: "Start Invest",
    rpID: rp().rpID,
    userID: user.id,
    userName: user.email,
    userDisplayName: user.name,
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: isoBase64URL.toBuffer(p.id), type: "public-key" as const, transports: (p.transports?.split(",").filter(Boolean) ?? []) as AuthenticatorTransportFuture[] })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  await saveChallenge("reg", options.challenge, user.id);
  return options;
}

export async function verifyRegistration(user: { id: string }, response: RegistrationResponseJSON, name: string) {
  const c = await takeChallenge("reg");
  if (c.userId !== user.id) throw new Error("Demande invalide.");
  const { verified, registrationInfo } = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: rp().origin, expectedRPID: rp().rpID, requireUserVerification: true });
  if (!verified || !registrationInfo) throw new Error("La clé n'a pas pu être vérifiée.");
  const id = isoBase64URL.fromBuffer(registrationInfo.credentialID);
  await prisma.passkey.create({
    data: { id, userId: user.id, publicKey: Buffer.from(registrationInfo.credentialPublicKey), counter: registrationInfo.counter, transports: (response.response.transports ?? []).join(","), name: name.slice(0, 60) || "Mon appareil" },
  });
  return id;
}

export async function authenticationOptions() {
  const options = await generateAuthenticationOptions({ rpID: rp().rpID, userVerification: "required", allowCredentials: [] });
  await saveChallenge("auth", options.challenge);
  return options;
}

/** Vérifie une connexion par clé d'accès ; renvoie l'utilisateur ou null. */
export async function verifyAuthentication(response: AuthenticationResponseJSON) {
  const c = await takeChallenge("auth");
  const pk = await prisma.passkey.findUnique({ where: { id: response.id }, include: { user: true } });
  if (!pk || !pk.user.active) return null;
  const { verified, authenticationInfo } = await verifyAuthenticationResponse({
    response,
    expectedChallenge: c.challenge,
    expectedOrigin: rp().origin,
    expectedRPID: rp().rpID,
    requireUserVerification: true,
    authenticator: { credentialID: isoBase64URL.toBuffer(pk.id), credentialPublicKey: new Uint8Array(pk.publicKey), counter: pk.counter, transports: (pk.transports?.split(",").filter(Boolean) ?? []) as AuthenticatorTransportFuture[] },
  });
  if (!verified) return null;
  await prisma.passkey.update({ where: { id: pk.id }, data: { counter: authenticationInfo.newCounter, lastUsedAt: new Date() } });
  return pk.user;
}
