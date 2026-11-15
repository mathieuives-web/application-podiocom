import { prisma } from "@/lib/prisma";
import { decryptJson, encryptJson } from "@/lib/crypto";

// Google (Gmail + Drive) d'une société, connexion officielle OAuth : le fondateur clique « Se connecter
// avec Google » et accepte. Les agents Secrétariat trient les e-mails (libellés, archivage, marquer lu)
// et rangent le Drive (dossiers, déplacements, renommage). Ils ne peuvent NI envoyer, NI supprimer.

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive",
];
export type GoogleCreds = { refreshToken: string; accessToken?: string; expiresAt?: number; email?: string };

const AUTH_URL = process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const API = process.env.GOOGLE_API_URL || "https://www.googleapis.com";
const GMAIL = process.env.GMAIL_API_URL || "https://gmail.googleapis.com";

export const googleConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.NEXTAUTH_URL);
export const googleRedirectUri = () => `${(process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "")}/api/google/callback`;

export function googleAuthUrl(state: string) {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${q}`;
}

async function tokenRequest(body: Record<string, string>) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "", ...body }),
    cache: "no-store",
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!r.ok || !j.access_token) {
    if (j.error === "invalid_grant") throw new Error("Accès Google expiré ou retiré : reconnectez Google dans Connexions.");
    throw new Error(`Google refuse la connexion : ${j.error_description ?? j.error ?? r.status}`);
  }
  return j;
}

export async function exchangeGoogleCode(code: string): Promise<GoogleCreds> {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: googleRedirectUri() });
  if (!t.refresh_token) throw new Error("Google n'a pas donné d'accès permanent : retirez l'accès à « Start Invest » dans votre compte Google puis reconnectez.");
  const creds: GoogleCreds = { refreshToken: t.refresh_token, accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
  const me = await fetch(`${API}/oauth2/v3/userinfo`, { headers: { Authorization: `Bearer ${t.access_token}` } }).then((r) => r.json()).catch(() => ({}));
  creds.email = (me as { email?: string }).email;
  return creds;
}

/** Client Google d'une intégration : renouvelle le jeton si besoin (et l'enregistre chiffré). */
export async function googleClient(integrationId: string) {
  const integ = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  let creds = decryptJson<GoogleCreds>(integ.credentials);
  const token = async () => {
    if (!creds.accessToken || !creds.expiresAt || creds.expiresAt < Date.now() + 60000) {
      const t = await tokenRequest({ refresh_token: creds.refreshToken, grant_type: "refresh_token" });
      creds = { ...creds, accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
      await prisma.integration.update({ where: { id: integ.id }, data: { credentials: encryptJson(creds) } });
    }
    return creds.accessToken!;
  };
  const call = async <T>(url: string, init?: { method?: string; body?: unknown }) => {
    const r = await fetch(url, {
      method: init?.method ?? "GET",
      headers: { Authorization: `Bearer ${await token()}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`Google ${r.status} : ${(await r.text()).slice(0, 200)}`);
    return (r.status === 204 ? {} : await r.json()) as T;
  };
  return { integ, email: creds.email, call };
}

// ------------------------------------------------------------------ Gmail

type GmailMsg = { id: string; threadId: string; labelIds?: string[]; snippet?: string; payload?: GmailPart; internalDate?: string };
type GmailPart = { mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: GmailPart[] };

const header = (m: GmailMsg, n: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? null;
const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function bodyText(p?: GmailPart): string {
  if (!p) return "";
  if (p.mimeType === "text/plain" && p.body?.data) return b64(p.body.data);
  for (const c of p.parts ?? []) {
    const t = bodyText(c);
    if (t) return t;
  }
  if (p.mimeType === "text/html" && p.body?.data) return b64(p.body.data).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  return "";
}

function attachments(p?: GmailPart): string[] {
  if (!p) return [];
  return [...(p.filename ? [p.filename] : []), ...(p.parts ?? []).flatMap(attachments)];
}

export async function gmailSearch(integrationId: string, q: string, max = 30) {
  const g = await googleClient(integrationId);
  const list = await g.call<{ messages?: { id: string }[] }>(`${GMAIL}/gmail/v1/users/me/messages?${new URLSearchParams({ q, maxResults: String(Math.min(max, 100)) })}`);
  const out = [];
  for (const { id } of list.messages ?? []) {
    const m = await g.call<GmailMsg>(`${GMAIL}/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`);
    out.push({ id, de: header(m, "From"), a: header(m, "To"), objet: header(m, "Subject"), date: header(m, "Date"), extrait: m.snippet, libelles: m.labelIds ?? [], nonLu: (m.labelIds ?? []).includes("UNREAD") });
  }
  return { boite: g.email, messages: out };
}

export async function gmailRead(integrationId: string, id: string) {
  const g = await googleClient(integrationId);
  const m = await g.call<GmailMsg>(`${GMAIL}/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
  return { id, de: header(m, "From"), a: header(m, "To"), objet: header(m, "Subject"), date: header(m, "Date"), texte: bodyText(m.payload).slice(0, 12000), piecesJointes: attachments(m.payload), libelles: m.labelIds ?? [] };
}

/** Range un e-mail : ajoute un libellé (créé s'il n'existe pas, ex. « Start Invest/Factures »), archive, marque lu. */
export async function gmailOrganize(integrationId: string, id: string, opts: { libelle?: string; archiver?: boolean; marquerLu?: boolean; important?: boolean }) {
  const g = await googleClient(integrationId);
  const add: string[] = [];
  const remove: string[] = [];
  if (opts.libelle) {
    const name = opts.libelle.slice(0, 100);
    const labels = await g.call<{ labels: { id: string; name: string }[] }>(`${GMAIL}/gmail/v1/users/me/labels`);
    let label = labels.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (!label) label = await g.call<{ id: string; name: string }>(`${GMAIL}/gmail/v1/users/me/labels`, { method: "POST", body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } });
    add.push(label.id);
  }
  if (opts.important) add.push("STARRED");
  if (opts.archiver) remove.push("INBOX");
  if (opts.marquerLu) remove.push("UNREAD");
  if (!add.length && !remove.length) return { ok: true, rien: true };
  await g.call(`${GMAIL}/gmail/v1/users/me/messages/${encodeURIComponent(id)}/modify`, { method: "POST", body: { addLabelIds: add, removeLabelIds: remove } });
  return { ok: true, ajoutes: add.length, retires: remove };
}

// ------------------------------------------------------------------ Drive

const FOLDER = "application/vnd.google-apps.folder";

export async function driveList(integrationId: string, opts: { dossier?: string; recherche?: string; max?: number }) {
  const g = await googleClient(integrationId);
  const parts = ["trashed = false"];
  if (opts.dossier) parts.push(`'${opts.dossier.replace(/[^\w-]/g, "")}' in parents`);
  if (opts.recherche) parts.push(`name contains '${opts.recherche.replace(/'/g, " ")}'`);
  if (!opts.dossier && !opts.recherche) parts.push("'root' in parents");
  const r = await g.call<{ files: { id: string; name: string; mimeType: string; modifiedTime: string; size?: string; parents?: string[] }[] }>(
    `${API}/drive/v3/files?${new URLSearchParams({ q: parts.join(" and "), pageSize: String(Math.min(opts.max ?? 100, 200)), fields: "files(id,name,mimeType,modifiedTime,size,parents)", orderBy: "folder,name" })}`
  );
  return { compte: g.email, fichiers: r.files.map((f) => ({ id: f.id, nom: f.name, dossier: f.mimeType === FOLDER, type: f.mimeType, modifie: f.modifiedTime.slice(0, 10), taille: f.size ? Number(f.size) : null, parents: f.parents })) };
}

export async function driveCreateFolder(integrationId: string, name: string, parent?: string) {
  const g = await googleClient(integrationId);
  return g.call<{ id: string; name: string }>(`${API}/drive/v3/files?fields=id,name`, { method: "POST", body: { name: name.slice(0, 120), mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) } });
}

/** Déplace et/ou renomme un fichier (jamais de suppression). */
export async function driveMove(integrationId: string, fileId: string, opts: { versDossier?: string; nouveauNom?: string }) {
  const g = await googleClient(integrationId);
  const f = await g.call<{ parents?: string[] }>(`${API}/drive/v3/files/${encodeURIComponent(fileId)}?fields=parents`);
  const q = new URLSearchParams({ fields: "id,name,parents" });
  if (opts.versDossier) {
    q.set("addParents", opts.versDossier.replace(/[^\w-]/g, ""));
    if (f.parents?.length) q.set("removeParents", f.parents.join(","));
  }
  return g.call(`${API}/drive/v3/files/${encodeURIComponent(fileId)}?${q}`, { method: "PATCH", body: opts.nouveauNom ? { name: opts.nouveauNom.slice(0, 200) } : {} });
}
