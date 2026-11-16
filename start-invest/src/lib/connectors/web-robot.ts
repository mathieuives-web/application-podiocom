import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { prisma } from "@/lib/prisma";

// Robot de connexion : pour les logiciels sans API (Auto Cerfa, GTA Pro...), un navigateur invisible
// sur le serveur se connecte avec les identifiants du fondateur et télécharge les exports.
// Sécurité :
// - les identifiants sont déchiffrés uniquement en mémoire, tapés par le code dans les champs de connexion,
//   jamais envoyés à l'IA ni écrits dans les journaux ;
// - l'IA ne voit que la liste des liens / boutons de la page et choisit où cliquer pour atteindre l'export ;
// - lecture seule : le robot refuse tout bouton qui modifie des données (supprimer, valider, payer, envoyer...).
// Le chemin trouvé est mémorisé et rejoué les jours suivants (l'IA n'intervient plus tant qu'il marche).

export type RobotGoal = { key: string; description: string };
type Step = { text: string; href: string | null; url?: string };

const DANGER = /supprim|effac|delete|remove|annul|valid|payer|paiement|envoyer|send|sign|transf|cession|d[ée]clar|immatricul|commander|acheter|cr[ée]er|ajouter|modifier|enregistr|publi|diffus|d[ée]sactiv|r[ée]silier/i;
const SAFE = /export|t[ée]l[ée]charg|excel|csv/i;
const MAX_STEPS = 20;

const ActionSchema = z.object({
  action: z.enum(["cliquer", "aller", "termine", "impossible"]),
  index: z.number().int().nullable().describe("Numéro de l'élément à cliquer (action cliquer)"),
  url: z.string().nullable().describe("Adresse à ouvrir (action aller), sur le même site uniquement"),
  raison: z.string(),
});

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

type Page = import("playwright-core").Page;
type Loc = import("playwright-core").Locator;

export async function launch() {
  const { chromium } = await import("playwright-core");
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  return chromium.launch({ headless: true, executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}

export async function visible(l: Loc) {
  return l.isVisible().catch(() => false);
}

/** Remplit le formulaire de connexion s'il est affiché. Renvoie true si une connexion a été tentée. */
export async function loginIfNeeded(page: Page, username: string, password: string) {
  const pwd = page.locator('input[type="password"]').first();
  if (!(await visible(pwd))) return false;
  if (!password) throw new Error("Session expirée : le site redemande une connexion. Cliquez « se connecter moi-même » dans Connexions et reconnectez-vous.");
  const candidates = page.locator('input[type="email"], input[type="text"], input[name*="user" i], input[name*="login" i], input[name*="mail" i], input:not([type])');
  let user: Loc | null = null;
  for (let i = 0; i < (await candidates.count()); i++) {
    const c = candidates.nth(i);
    if (await visible(c)) {
      user = c;
      break;
    }
  }
  if (user) await user.fill(username);
  await pwd.fill(password);
  const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Connexion"), button:has-text("Se connecter"), button:has-text("Login")').first();
  if (await visible(submit)) await submit.click().catch(() => pwd.press("Enter"));
  else await pwd.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
  if (await visible(page.locator('input[type="password"]').first())) {
    const txt = (await page.locator("body").innerText().catch(() => "")).slice(0, 2000);
    if (/code|sms|v[ée]rification|double|2fa|captcha/i.test(txt)) throw new Error("Le site demande un code de vérification (SMS / e-mail) ou un captcha : la connexion automatique est bloquée. Désactivez la double vérification pour ce compte ou créez un utilisateur dédié en lecture.");
    throw new Error("Identifiant ou mot de passe refusé par le site.");
  }
  return true;
}

/**
 * Boutons et liens de la page, Y COMPRIS dans les cadres (iframes) : beaucoup de logiciels pros (WebDev, GTA Pro...)
 * affichent leurs menus dans des cadres. Chaque élément reçoit un numéro unique (attribut data-robot).
 */
export async function clickables(page: Page) {
  const out: { i: number; text: string; href: string | null; shown: boolean; frame: number }[] = [];
  let start = 0;
  const frames = page.frames();
  for (let f = 0; f < frames.length && out.length < 250; f++) {
    const list = await frames[f]
      .evaluate((offset) => {
        const els = Array.from(document.querySelectorAll('a, button, [role="button"], [role="menuitem"], [role="tab"], [role="link"], input[type="button"], input[type="submit"], [onclick], li[class*="menu" i], td[onclick], div[class*="btn" i], span[class*="btn" i]')) as HTMLElement[];
        return els.map((el, k) => {
          const r = el.getBoundingClientRect();
          const text = (el.innerText || (el as HTMLInputElement).value || el.getAttribute("title") || el.getAttribute("aria-label") || el.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 80);
          const href = el.getAttribute("href");
          el.setAttribute("data-robot", String(offset + k));
          return { i: offset + k, text, href: href && !href.startsWith("javascript") ? href.slice(0, 200) : null, shown: r.width > 0 && r.height > 0 };
        });
      }, start)
      .catch(() => []);
    start += list.length + 1;
    for (const e of list) if ((e.text || e.href) && e.shown) out.push({ ...e, frame: f });
  }
  // Doublons (même texte et même lien) retirés pour une liste lisible.
  const seen = new Set<string>();
  return out.filter((e) => {
    const k = `${e.text}|${e.href ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 220);
}

/** Élément numéroté (data-robot / data-champ), cherché dans tous les cadres de la page. */
export async function inFrames(page: Page, selector: string): Promise<Loc> {
  for (const f of page.frames()) {
    const l = f.locator(selector);
    if (await l.count().catch(() => 0)) return l.first();
  }
  return page.locator(selector).first();
}

/** Élément par son texte exact, dans la page ou ses cadres (rejeu d'un chemin mémorisé). */
export async function textInFrames(page: Page, text: string): Promise<Loc> {
  for (const f of page.frames()) {
    const l = f.getByText(text, { exact: true });
    if (await l.count().catch(() => 0)) return l.first();
  }
  return page.getByText(text, { exact: true }).first();
}

/** Texte visible de la page et de ses cadres. */
export async function pageText(page: Page, max = 4000) {
  const parts: string[] = [];
  for (const f of page.frames()) {
    const t = await f.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (t.trim()) parts.push(t);
  }
  return parts.join("\n").replace(/\s+/g, " ").slice(0, max);
}

/** Capture de l'écran pour que l'IA VOIE la page (menus, icônes sans texte). */
export async function screenFor(page: Page) {
  const shot = await page.screenshot({ type: "jpeg", quality: 55 }).catch(() => null);
  return shot ? [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: shot.toString("base64") } }] : [];
}

/** Détecte un aller-retour sans fin (ex. « Liste » → « JOURNÉE » → « Liste » → « JOURNÉE ») et le signale à l'IA. */
export function loopWarning(history: string[]) {
  const h = history.slice(-6);
  if (h.length >= 4 && h[h.length - 1] === h[h.length - 3] && h[h.length - 2] === h[h.length - 4]) {
    return `\n⚠ BOUCLE : tu alternes « ${h[h.length - 2]} » et « ${h[h.length - 1]} » sans avancer. Choisis un AUTRE élément (regarde la capture d'écran : menu, onglet, icône, bouton « Rechercher » / « Afficher », sous-menu) ou réponds « impossible ».`;
  }
  return "";
}

/** Clique sur un élément et récupère le fichier s'il déclenche un téléchargement. */
async function clickAndMaybeDownload(page: Page, target: Loc) {
  const download = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
  await target.click({ timeout: 10000 });
  const d = await Promise.race([download, page.waitForLoadState("networkidle", { timeout: 15000 }).then(() => new Promise((r) => setTimeout(() => r(null), 2500)))]);
  const dl = (d as import("playwright-core").Download | null) ?? (await Promise.race([download, new Promise((r) => setTimeout(() => r(null), 1500))]) as import("playwright-core").Download | null);
  if (!dl) return null;
  const stream = await dl.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return { name: dl.suggestedFilename(), content: Buffer.concat(chunks) };
}

async function decide(goal: RobotGoal, page: Page, list: Awaited<ReturnType<typeof clickables>>, history: string[]) {
  const text = await pageText(page, 2500);
  const stream = anthropic().beta.messages.stream({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { format: betaZodOutputFormat(ActionSchema) },
    messages: [
      {
        role: "user",
        content: [...(await screenFor(page)), { type: "text" as const, text: `Tu pilotes un navigateur connecté au logiciel professionnel d'un garage, en LECTURE SEULE. La capture d'écran ci-dessus montre la page.
Objectif : ${goal.description}
Le téléchargement du fichier est détecté automatiquement après un clic. Ne clique JAMAIS sur un bouton qui crée, modifie,
supprime, valide, envoie ou paie quelque chose. Si l'objectif est inatteignable, réponds « impossible ».

Page actuelle : ${page.url()} — « ${await page.title()} »
Déjà fait : ${history.join(" → ") || "rien"}${loopWarning(history)}
Texte de la page (début) : ${text}

Éléments cliquables (numéro : texte [lien]) :
${list.map((e) => `${e.i} : ${e.text}${e.href ? ` [${e.href}]` : ""}`).join("\n")}` }],
      },
    ],
  });
  const msg = await stream.finalMessage();
  const out = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
  return ActionSchema.parse(JSON.parse(out));
}

async function replay(page: Page, steps: Step[], username: string, password: string) {
  for (const s of steps) {
    await loginIfNeeded(page, username, password);
    if (s.url) {
      await page.goto(s.url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => undefined);
      continue;
    }
    const loc = s.text ? await textInFrames(page, s.text) : await inFrames(page, `a[href="${s.href}"]`);
    if (!(await visible(loc))) return null;
    const file = await clickAndMaybeDownload(page, loc);
    if (file) return file;
  }
  return null;
}

/**
 * Se connecte au site et télécharge un fichier par objectif. Les objectifs non atteints sont signalés
 * sans bloquer les autres.
 */
export async function robotDownload(opts: { site: string; startUrl: string; username: string; password: string; goals: RobotGoal[]; storageState?: string }) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new Error("Robot de connexion : ANTHROPIC_API_KEY manquante.");
  const start = new URL(opts.startUrl);
  const browser = await launch();
  const files: { goal: string; name: string; content: Buffer }[] = [];
  const problems: string[] = [];
  let storageState: string | null = null;
  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      locale: "fr-FR",
      viewport: { width: 1280, height: 800 },
      // Session enregistrée lors de la « connexion assistée » : le robot est déjà connecté.
      ...(opts.storageState ? { storageState: JSON.parse(opts.storageState) } : {}),
    });
    const page = await context.newPage();
    await page.goto(opts.startUrl, { waitUntil: "networkidle", timeout: 45000 }).catch(() => undefined);
    for (const goal of opts.goals) {
      const pathKey = `robot-path:${opts.site}:${goal.key}`;
      const saved = await prisma.appSetting.findUnique({ where: { key: pathKey } });
      await page.goto(opts.startUrl, { waitUntil: "networkidle", timeout: 45000 }).catch(() => undefined);
      await loginIfNeeded(page, opts.username, opts.password);
      // 1) chemin connu : rejoué sans IA
      if (saved) {
        const f = await replay(page, JSON.parse(saved.value) as Step[], opts.username, opts.password).catch(() => null);
        if (f) {
          files.push({ goal: goal.key, ...f });
          continue;
        }
        await page.goto(opts.startUrl, { waitUntil: "networkidle", timeout: 45000 }).catch(() => undefined);
        await loginIfNeeded(page, opts.username, opts.password);
      }
      // 2) chemin à (re)trouver avec l'IA
      const steps: Step[] = [];
      const history: string[] = [];
      let got: { name: string; content: Buffer } | null = null;
      for (let n = 0; n < MAX_STEPS && !got; n++) {
        await loginIfNeeded(page, opts.username, opts.password);
        const list = await clickables(page);
        const a = await decide(goal, page, list, history);
        if (a.action === "impossible" || a.action === "termine") {
          problems.push(`${goal.description} : ${a.raison}`);
          break;
        }
        if (a.action === "aller" && a.url) {
          const u = new URL(a.url, page.url());
          if (u.hostname !== start.hostname && !u.hostname.endsWith("." + start.hostname.replace(/^www\./, ""))) throw new Error(`Le robot a voulu quitter le site (${u.hostname}) : arrêt.`);
          // Lecture seule : une adresse qui modifie quelque chose (…/supprimer, …/valider) est refusée comme un bouton.
          if (DANGER.test(u.pathname + u.search) && !SAFE.test(u.pathname + u.search)) {
            history.push(`refusé ${u.pathname} (action risquée)`);
            continue;
          }
          await page.goto(u.toString(), { waitUntil: "networkidle", timeout: 30000 }).catch(() => undefined);
          history.push(`ouvrir ${u.pathname}`);
          steps.push({ text: "", href: null, url: u.toString() }); // rejoué tel quel les jours suivants
          continue;
        }
        const el = list.find((e) => e.i === a.index);
        if (!el) {
          history.push("(numéro invalide)");
          continue;
        }
        // Le lien compte autant que le texte : une icône « poubelle » sans texte vers /supprimer est refusée.
        if (DANGER.test(`${el.text} ${el.href ?? ""}`) && !SAFE.test(el.text)) {
          history.push(`refusé « ${el.text} » (action risquée)`);
          continue;
        }
        history.push(`cliquer « ${el.text || el.href} »`);
        steps.push({ text: el.text, href: el.href });
        got = await clickAndMaybeDownload(page, await inFrames(page, `[data-robot="${el.i}"]`)).catch(() => null);
      }
      if (got) {
        files.push({ goal: goal.key, ...got });
        await prisma.appSetting.upsert({ where: { key: pathKey }, update: { value: JSON.stringify(steps) }, create: { key: pathKey, value: JSON.stringify(steps) } });
        console.log(`[robot] ${opts.site} ${goal.key} : chemin trouvé (${steps.map((s) => s.text).join(" → ")})`);
      } else if (!problems.some((p) => p.startsWith(goal.description))) {
        problems.push(`${goal.description} : export introuvable après ${MAX_STEPS} étapes (${history.slice(-4).join(" → ")})`);
      }
    }
    // Session prolongée par le site : on garde les cookies à jour pour le lendemain.
    storageState = JSON.stringify(await context.storageState());
  } finally {
    await browser.close().catch(() => undefined);
  }
  return { files, problems, storageState };
}
