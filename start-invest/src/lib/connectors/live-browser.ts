import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { decryptJson, encryptJson } from "@/lib/crypto";
import { assertPublicHost } from "@/lib/agent-tools-extra";

// Connexion assistée : le fondateur pilote lui-même, depuis l'application, un navigateur ouvert sur
// le serveur (il voit l'écran, clique, tape son identifiant, son mot de passe, son code SMS...).
// À la fin, la session (cookies) est enregistrée chiffrée et le robot quotidien la réutilise pour se
// reconnecter sans rien demander. Rien de ce qui est tapé n'est journalisé ni envoyé à l'IA.

export const LIVE_VIEWPORT = { width: 1280, height: 800 };
const IDLE_MS = 15 * 60 * 1000;

type Live = {
  integrationId: string;
  userId: string;
  browser: import("playwright-core").Browser;
  context: import("playwright-core").BrowserContext;
  page: import("playwright-core").Page;
  lastUsed: number;
};

const g = globalThis as unknown as { __liveBrowsers?: Map<string, Live> };
const sessions = (g.__liveBrowsers ??= new Map());

async function closeLive(id: string) {
  const s = sessions.get(id);
  sessions.delete(id);
  await s?.browser.close().catch(() => undefined);
}

setInterval(() => {
  for (const [id, s] of sessions) if (Date.now() - s.lastUsed > IDLE_MS) void closeLive(id);
}, 60 * 1000).unref?.();

export type SiteCreds = { login?: string; password?: string; url?: string; storageState?: string };

export async function startLive(integrationId: string, userId: string, defaultUrl: string) {
  // Une seule fenêtre par connexion : on referme l'ancienne.
  for (const [id, s] of sessions) if (s.integrationId === integrationId) await closeLive(id);
  const integ = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  const creds = decryptJson<SiteCreds>(integ.credentials);
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({
    viewport: LIVE_VIEWPORT,
    locale: "fr-FR",
    acceptDownloads: false,
    ...(creds.storageState ? { storageState: JSON.parse(creds.storageState) } : {}),
  });
  const page = await context.newPage();
  context.on("page", (p) => {
    // Les nouveaux onglets deviennent la page affichée.
    const s = [...sessions.values()].find((x) => x.context === context);
    if (s) s.page = p;
  });
  await page.goto(creds.url || defaultUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => undefined);
  const id = randomBytes(24).toString("base64url");
  sessions.set(id, { integrationId, userId, browser, context, page, lastUsed: Date.now() });
  return id;
}

function get(id: string, userId: string) {
  const s = sessions.get(id);
  if (!s || s.userId !== userId) throw new Error("Fenêtre fermée ou expirée : relancez la connexion.");
  s.lastUsed = Date.now();
  return s;
}

export async function liveScreenshot(id: string, userId: string) {
  const s = get(id, userId);
  return { image: await s.page.screenshot({ type: "jpeg", quality: 70 }), url: s.page.url() };
}

export type LiveAction =
  | { type: "click"; x: number; y: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; dy: number }
  | { type: "goto"; url: string }
  | { type: "back" };

const KEYS = new Set(["Enter", "Tab", "Backspace", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Delete"]);

export async function liveAction(id: string, userId: string, a: LiveAction) {
  const s = get(id, userId);
  const p = s.page;
  if (a.type === "click") await p.mouse.click(Math.max(0, Math.min(LIVE_VIEWPORT.width, a.x)), Math.max(0, Math.min(LIVE_VIEWPORT.height, a.y)));
  else if (a.type === "text") await p.keyboard.type(String(a.text).slice(0, 500), { delay: 20 });
  else if (a.type === "key" && KEYS.has(a.key)) await p.keyboard.press(a.key);
  else if (a.type === "scroll") await p.mouse.wheel(0, Math.max(-3000, Math.min(3000, a.dy)));
  else if (a.type === "back") await p.goBack().catch(() => undefined);
  else if (a.type === "goto") {
    const u = new URL(a.url);
    if (!/^https?:$/.test(u.protocol)) throw new Error("Adresse invalide.");
    await assertPublicHost(u.hostname); // pas d'accès au réseau interne du serveur (métadonnées du cloud...)
    await p.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
  }
  await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
}

/** Enregistre la session (chiffrée) et l'adresse de départ, puis ferme la fenêtre. */
export async function finishLive(id: string, userId: string) {
  const s = get(id, userId);
  const state = await s.context.storageState();
  const integ = await prisma.integration.findUniqueOrThrow({ where: { id: s.integrationId } });
  const creds = decryptJson<SiteCreds>(integ.credentials);
  const startUrl = /^https?:/.test(s.page.url()) ? s.page.url() : creds.url; // page atteinte une fois connecté : le robot repartira de là
  await prisma.integration.update({
    where: { id: integ.id },
    data: { credentials: encryptJson({ ...creds, url: startUrl, storageState: JSON.stringify(state) }), status: "PENDING", lastError: null },
  });
  await closeLive(id);
  return integ.id;
}

export async function cancelLive(id: string, userId: string) {
  get(id, userId);
  await closeLive(id);
}
