import { resolveMx } from "dns/promises";
import { prisma } from "@/lib/prisma";
import { decryptJson } from "@/lib/crypto";

// Boîte mail par IMAP : seulement l'adresse et le mot de passe (pour Gmail : un « mot de passe d'application »).
// Marche avec Gmail / Google Workspace, Orange, Free, SFR, La Poste, OVH, Ionos et la plupart des hébergeurs.
// Mêmes règles que les autres boîtes : lire, ranger (dossier / libellé), marquer lu ou important, enregistrer
// les factures ; jamais envoyer ni supprimer.

export type ImapCreds = { email: string; password: string; host?: string; port?: string };

const BY_DOMAIN: Record<string, string> = {
  "gmail.com": "imap.gmail.com",
  "googlemail.com": "imap.gmail.com",
  "orange.fr": "imap.orange.fr",
  "wanadoo.fr": "imap.orange.fr",
  "free.fr": "imap.free.fr",
  "sfr.fr": "imap.sfr.fr",
  "neuf.fr": "imap.sfr.fr",
  "laposte.net": "imap.laposte.net",
  "yahoo.fr": "imap.mail.yahoo.com",
  "yahoo.com": "imap.mail.yahoo.com",
  "icloud.com": "imap.mail.me.com",
  "me.com": "imap.mail.me.com",
  "outlook.com": "outlook.office365.com",
  "outlook.fr": "outlook.office365.com",
  "hotmail.com": "outlook.office365.com",
  "hotmail.fr": "outlook.office365.com",
  "live.fr": "outlook.office365.com",
  "live.com": "outlook.office365.com",
};

/** Serveur IMAP d'une adresse : domaine connu, sinon d'après l'hébergeur de ses e-mails (MX). */
export async function imapHost(email: string) {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (BY_DOMAIN[domain]) return BY_DOMAIN[domain];
  const mx = (await resolveMx(domain).catch(() => [])).map((m) => m.exchange.toLowerCase()).join(" ");
  if (/google|googlemail/.test(mx)) return "imap.gmail.com";
  if (/outlook|protection\.outlook/.test(mx)) return "outlook.office365.com";
  if (/ovh/.test(mx)) return "ssl0.ovh.net";
  if (/ionos|1and1|kundenserver/.test(mx)) return "imap.ionos.fr";
  if (/o2switch/.test(mx)) return `mail.${domain}`;
  if (/gandi/.test(mx)) return "mail.gandi.net";
  if (/zoho/.test(mx)) return "imap.zoho.eu";
  return `imap.${domain}`;
}

const isMicrosoft = (host: string) => /office365|outlook/.test(host);

async function connect(creds: ImapCreds) {
  const { ImapFlow } = await import("imapflow");
  const host = creds.host || (await imapHost(creds.email));
  const port = Number(creds.port) || 993;
  const client = new ImapFlow({ host, port, secure: port !== 143, auth: { user: creds.email, pass: creds.password }, logger: false, socketTimeout: 60000 });
  try {
    await client.connect();
  } catch (e) {
    const msg = (e as Error & { responseText?: string }).responseText ?? (e as Error).message;
    if (isMicrosoft(host)) throw new Error("Microsoft n'accepte plus le mot de passe seul pour Outlook / Hotmail : utilisez la carte « Outlook » (connexion Microsoft).");
    if (host === "imap.gmail.com") throw new Error(`Gmail refuse la connexion : il faut un « mot de passe d'application » (myaccount.google.com/apppasswords, la validation en deux étapes doit être activée), pas le mot de passe habituel. Détail : ${msg.slice(0, 120)}`);
    throw new Error(`Connexion à la boîte ${creds.email} (${host}) refusée : ${msg.slice(0, 160)}`);
  }
  return client;
}

async function withBox<T>(integrationId: string, fn: (c: Awaited<ReturnType<typeof connect>>, creds: ImapCreds) => Promise<T>) {
  const integ = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  const creds = decryptJson<ImapCreds>(integ.credentials);
  const client = await connect(creds);
  try {
    return await fn(client, creds);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export async function checkImap(creds: ImapCreds) {
  const c = await connect(creds);
  await c.logout().catch(() => undefined);
}

/** Identifiant d'un message : « dossier::uid ». */
const ref = (folder: string, uid: number) => `${folder}::${uid}`;
const unref = (id: string) => {
  const i = id.lastIndexOf("::");
  return i < 0 ? { folder: "INBOX", uid: Number(id) } : { folder: id.slice(0, i), uid: Number(id.slice(i + 2)) };
};

/**
 * Recherche : texte libre (expéditeur, objet, contenu) ; préfixes acceptés « from: », « subject: », « depuis:N » (jours),
 * « non-lus », « tout » (sans limite de date). Vide = boîte de réception des 3 derniers jours.
 */
export async function imapSearch(integrationId: string, q: string, max = 30) {
  return withBox(integrationId, async (c, creds) => {
    const lock = await c.getMailboxLock("INBOX");
    try {
      const days = Number(q.match(/depuis:(\d+)/)?.[1] ?? (q.trim() ? 30 : 3));
      const criteria: Record<string, unknown> = /\btout\b/.test(q) ? { all: true } : { since: new Date(Date.now() - days * 86400000) };
      const from = q.match(/from:(\S+)/)?.[1];
      const subject = q.match(/subject:"([^"]+)"|subject:(\S+)/);
      const rest = q.replace(/from:\S+|subject:"[^"]+"|subject:\S+|depuis:\d+|non-lus|\btout\b/g, "").trim();
      if (from) criteria.from = from;
      if (subject) criteria.subject = subject[1] ?? subject[2];
      if (rest) criteria.body = rest;
      if (/non-lus/.test(q)) criteria.seen = false;
      const uids = ((await c.search(criteria, { uid: true })) || []).slice(-Math.min(max, 100)).reverse();
      const out = [];
      if (uids.length) {
        for await (const m of c.fetch(uids, { uid: true, envelope: true, flags: true, bodyStructure: true }, { uid: true })) {
          const hasAtt = JSON.stringify(m.bodyStructure ?? {}).includes('"disposition":"attachment"');
          out.push({ id: ref("INBOX", m.uid), de: m.envelope?.from?.map((f) => `${f.name ?? ""} <${f.address ?? ""}>`).join(", "), objet: m.envelope?.subject, date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : null, nonLu: !m.flags?.has("\\Seen"), important: m.flags?.has("\\Flagged") ?? false, piecesJointes: hasAtt });
        }
      }
      return { boite: creds.email, messages: out.sort((a, b) => String(b.date).localeCompare(String(a.date))) };
    } finally {
      lock.release();
    }
  });
}

async function parsed(c: Awaited<ReturnType<typeof connect>>, id: string) {
  const { folder, uid } = unref(id);
  const lock = await c.getMailboxLock(folder);
  try {
    const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) throw new Error("E-mail introuvable (déjà déplacé ?).");
    const { simpleParser } = await import("mailparser");
    return await simpleParser(msg.source);
  } finally {
    lock.release();
  }
}

export async function imapRead(integrationId: string, id: string) {
  return withBox(integrationId, async (c) => {
    const p = await parsed(c, id);
    return {
      id,
      de: p.from?.text,
      a: Array.isArray(p.to) ? p.to.map((t) => t.text).join(", ") : p.to?.text,
      objet: p.subject,
      date: p.date?.toISOString(),
      texte: (p.text ?? String(p.html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").slice(0, 12000),
      piecesJointes: p.attachments.map((a) => ({ nom: a.filename, type: a.contentType, taille: a.size })),
    };
  });
}

export async function imapAttachments(integrationId: string, id: string) {
  return withBox(integrationId, async (c) => {
    const p = await parsed(c, id);
    return p.attachments.slice(0, 10).map((a) => ({ name: a.filename ?? "piece-jointe", mime: a.contentType, content: a.content }));
  });
}

/** Range : dossier (créé si besoin ; sur Gmail un dossier = un libellé), lu, important. */
export async function imapOrganize(integrationId: string, id: string, opts: { dossier?: string; marquerLu?: boolean; important?: boolean }) {
  return withBox(integrationId, async (c) => {
    const { folder, uid } = unref(id);
    const lock = await c.getMailboxLock(folder);
    try {
      const flags = [...(opts.marquerLu ? ["\\Seen"] : []), ...(opts.important ? ["\\Flagged"] : [])];
      if (flags.length) await c.messageFlagsAdd(String(uid), flags, { uid: true });
      if (opts.dossier) {
        const name = opts.dossier.split("/").map((x) => x.trim().replace(/[\\"*%]/g, "")).filter(Boolean).slice(0, 3).join("/");
        const list = await c.list();
        if (!list.some((b) => b.path.toLowerCase() === name.toLowerCase())) await c.mailboxCreate(name).catch(() => undefined);
        await c.messageMove(String(uid), name, { uid: true });
      }
      return { ok: true };
    } finally {
      lock.release();
    }
  });
}
