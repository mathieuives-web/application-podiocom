import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";

// Clé du récapitulatif lu par Claude deux fois par jour : seule son empreinte est gardée ; la clé n'est montrée
// qu'une fois au fondateur, qui la colle dans le formulaire sécurisé de Claude (jamais dans une conversation).
const KEY = "recap-key-hash";
const hash = (k: string) => createHash("sha256").update(k).digest("hex");

export async function newRecapKey() {
  const key = `sir_${randomBytes(24).toString("base64url")}`;
  await prisma.appSetting.upsert({ where: { key: KEY }, update: { value: hash(key) }, create: { key: KEY, value: hash(key) } });
  return key;
}

export async function recapKeyExists() {
  return Boolean(await prisma.appSetting.findUnique({ where: { key: KEY } }));
}

export async function checkRecapKey(header: string | null) {
  const given = (header ?? "").replace(/^Bearer\s+/i, "").trim();
  const saved = await prisma.appSetting.findUnique({ where: { key: KEY } });
  if (!given || !saved) return false;
  const a = Buffer.from(hash(given));
  const b = Buffer.from(saved.value);
  return a.length === b.length && timingSafeEqual(a, b);
}
