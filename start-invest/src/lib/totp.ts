import { createHmac, randomBytes, timingSafeEqual } from "crypto";

// Codes à usage unique (RFC 6238) compatibles Google Authenticator, Microsoft Authenticator, Authy...
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newTotpSecret() {
  const bytes = randomBytes(20);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(s: string) {
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const v = ALPHABET.indexOf(c);
    if (v >= 0) bits += v.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function codeAt(secret: string, counter: number) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

/** Vérifie un code (tolérance d'un intervalle de 30 s avant/après pour le décalage d'horloge). */
export function verifyTotp(secret: string, code: string) {
  const c = (code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  const t = Math.floor(Date.now() / 30000);
  return [-1, 0, 1].some((d) => timingSafeEqual(Buffer.from(codeAt(secret, t + d)), Buffer.from(c)));
}

export function totpUri(secret: string, email: string) {
  return `otpauth://totp/${encodeURIComponent("Start Invest:" + email)}?secret=${secret}&issuer=${encodeURIComponent("Start Invest")}`;
}
