import { prisma } from "@/lib/prisma";
import { decryptJson, encryptJson } from "@/lib/crypto";

// Outlook / Hotmail / Microsoft 365 (API Microsoft Graph, connexion officielle OAuth).
// Mêmes règles que Gmail : les agents trient (dossiers, lu, important), lisent, enregistrent les factures
// reçues ; ils ne peuvent NI envoyer, NI supprimer.

export const MS_SCOPES = ["openid", "email", "offline_access", "User.Read", "Mail.ReadWrite"];
export type MsCreds = { refreshToken: string; accessToken?: string; expiresAt?: number; email?: string };

const LOGIN = process.env.MICROSOFT_LOGIN_URL || "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH = process.env.MICROSOFT_GRAPH_URL || "https://graph.microsoft.com/v1.0";

export const microsoftConfigured = () => Boolean(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET && process.env.NEXTAUTH_URL);
export const microsoftRedirectUri = () => `${(process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "")}/api/microsoft/callback`;

export function microsoftAuthUrl(state: string) {
  const q = new URLSearchParams({ client_id: process.env.MICROSOFT_CLIENT_ID ?? "", response_type: "code", redirect_uri: microsoftRedirectUri(), response_mode: "query", scope: MS_SCOPES.join(" "), state, prompt: "select_account" });
  return `${LOGIN}/authorize?${q}`;
}

async function token(body: Record<string, string>) {
  const r = await fetch(`${LOGIN}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.MICROSOFT_CLIENT_ID ?? "", client_secret: process.env.MICROSOFT_CLIENT_SECRET ?? "", scope: MS_SCOPES.join(" "), ...body }),
    cache: "no-store",
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!r.ok || !j.access_token) {
    if (j.error === "invalid_grant") throw new Error("Accès Outlook expiré ou retiré : reconnectez Outlook dans Connexions.");
    throw new Error(`Microsoft refuse la connexion : ${(j.error_description ?? j.error ?? String(r.status)).slice(0, 200)}`);
  }
  return j;
}

export async function exchangeMicrosoftCode(code: string): Promise<MsCreds> {
  const t = await token({ code, grant_type: "authorization_code", redirect_uri: microsoftRedirectUri() });
  if (!t.refresh_token) throw new Error("Microsoft n'a pas donné d'accès permanent (offline_access).");
  const me = (await fetch(`${GRAPH}/me`, { headers: { Authorization: `Bearer ${t.access_token}` } }).then((r) => r.json()).catch(() => ({}))) as { mail?: string; userPrincipalName?: string };
  return { refreshToken: t.refresh_token, accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000, email: me.mail ?? me.userPrincipalName };
}

export async function msClient(integrationId: string) {
  const integ = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  let creds = decryptJson<MsCreds>(integ.credentials);
  const access = async () => {
    if (!creds.accessToken || !creds.expiresAt || creds.expiresAt < Date.now() + 60000) {
      const t = await token({ refresh_token: creds.refreshToken, grant_type: "refresh_token" });
      // Microsoft renouvelle aussi le jeton de rafraîchissement : on garde le plus récent.
      creds = { ...creds, accessToken: t.access_token, refreshToken: t.refresh_token ?? creds.refreshToken, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
      await prisma.integration.update({ where: { id: integ.id }, data: { credentials: encryptJson(creds) } });
    }
    return creds.accessToken!;
  };
  const call = async <T>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
    const r = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
      method: init?.method ?? "GET",
      headers: { Authorization: `Bearer ${await access()}`, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`Outlook ${r.status} : ${(await r.text()).slice(0, 200)}`);
    return (r.status === 204 ? {} : await r.json()) as T;
  };
  return { email: creds.email, call };
}

type Msg = { id: string; subject?: string; from?: { emailAddress?: { name?: string; address?: string } }; toRecipients?: { emailAddress?: { address?: string } }[]; receivedDateTime?: string; bodyPreview?: string; isRead?: boolean; flag?: { flagStatus?: string }; hasAttachments?: boolean; parentFolderId?: string; body?: { content?: string; contentType?: string } };
const enc = encodeURIComponent;

/** Recherche (syntaxe Outlook / KQL : from:, subject:, received>=2026-11-14, hasattachments:true...). Vide = boîte de réception récente. */
export async function outlookSearch(integrationId: string, q: string, max = 30) {
  const g = await msClient(integrationId);
  const sel = "$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,flag,hasAttachments";
  const top = `$top=${Math.min(max, 100)}`;
  const r = q.trim()
    ? await g.call<{ value: Msg[] }>(`/me/messages?$search=${enc(`"${q.replace(/"/g, "")}"`)}&${sel}&${top}`, { headers: { ConsistencyLevel: "eventual" } })
    : await g.call<{ value: Msg[] }>(`/me/mailFolders/inbox/messages?${sel}&${top}&$orderby=receivedDateTime desc`);
  return {
    boite: g.email,
    messages: r.value.map((m) => ({ id: m.id, de: `${m.from?.emailAddress?.name ?? ""} <${m.from?.emailAddress?.address ?? ""}>`, a: m.toRecipients?.map((t) => t.emailAddress?.address).join(", "), objet: m.subject, date: m.receivedDateTime, extrait: m.bodyPreview?.slice(0, 300), nonLu: !m.isRead, important: m.flag?.flagStatus === "flagged", piecesJointes: m.hasAttachments })),
  };
}

export async function outlookRead(integrationId: string, id: string) {
  const g = await msClient(integrationId);
  const m = await g.call<Msg>(`/me/messages/${enc(id)}?$select=id,subject,from,toRecipients,receivedDateTime,body,hasAttachments`);
  const atts = m.hasAttachments ? await g.call<{ value: { id: string; name: string; contentType: string; size: number }[] }>(`/me/messages/${enc(id)}/attachments?$select=id,name,contentType,size`) : { value: [] };
  const text = (m.body?.content ?? "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return { id, de: m.from?.emailAddress?.address, objet: m.subject, date: m.receivedDateTime, texte: text.slice(0, 12000), piecesJointes: atts.value.map((a) => ({ id: a.id, nom: a.name, type: a.contentType, taille: a.size })) };
}

/** Range : déplace dans un dossier (créé si besoin, ex. « La Fabrique Automobile / Factures »), marque lu, marque important. */
export async function outlookOrganize(integrationId: string, id: string, opts: { dossier?: string; marquerLu?: boolean; important?: boolean }) {
  const g = await msClient(integrationId);
  if (opts.marquerLu || opts.important) {
    await g.call(`/me/messages/${enc(id)}`, { method: "PATCH", body: { ...(opts.marquerLu ? { isRead: true } : {}), ...(opts.important ? { flag: { flagStatus: "flagged" } } : {}) } });
  }
  if (opts.dossier) {
    // Dossier (et sous-dossier « A / B ») sous la boîte de réception.
    let parent = "inbox";
    for (const name of opts.dossier.split("/").map((x) => x.trim()).filter(Boolean).slice(0, 3)) {
      const list = await g.call<{ value: { id: string; displayName: string }[] }>(`/me/mailFolders/${parent}/childFolders?$top=100&$select=id,displayName`);
      const found = list.value.find((f) => f.displayName.toLowerCase() === name.toLowerCase().slice(0, 100));
      parent = found ? found.id : (await g.call<{ id: string }>(`/me/mailFolders/${parent}/childFolders`, { method: "POST", body: { displayName: name.slice(0, 100) } })).id;
    }
    await g.call(`/me/messages/${enc(id)}/move`, { method: "POST", body: { destinationId: parent } });
  }
  return { ok: true };
}

export async function outlookAttachments(integrationId: string, id: string) {
  const g = await msClient(integrationId);
  const r = await g.call<{ value: { name: string; contentType: string; contentBytes?: string }[] }>(`/me/messages/${enc(id)}/attachments`);
  return r.value.filter((a) => a.contentBytes).map((a) => ({ name: a.name, mime: a.contentType, content: Buffer.from(a.contentBytes!, "base64") }));
}
