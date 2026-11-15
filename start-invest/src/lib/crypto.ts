import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

// Chiffrement des identifiants de connexion (banques, logiciels) stockés en base.
// Clé dérivée de AUTH_SECRET : si vous changez AUTH_SECRET, il faudra reconnecter les outils.

function key() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET manquant : impossible de chiffrer les identifiants.");
  return createHash("sha256").update(`start-invest-integrations:${secret}`).digest();
}

export function encryptJson(data: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

export function decryptJson<T = Record<string, string>>(payload: string): T {
  const [iv, tag, enc] = payload.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8")) as T;
}
