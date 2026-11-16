import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { prisma } from "@/lib/prisma";
import { clickables, inFrames, textInFrames, launch, loginIfNeeded, loopWarning, pageText, screenFor, visible } from "./web-robot";

// Opérateur web : pour les logiciels sans API qui n'ont pas d'export (ex. GTA Pro), le robot
// 1) LIT des listes à l'écran (factures, devis, ordres de réparation) — lecture seule ;
// 2) SAISIT un document préparé par un agent et VALIDÉ par le fondateur (devis, OR).
// Jamais : facturer, encaisser, saisir un règlement, supprimer, annuler, envoyer, signer, clôturer.
// Les identifiants ne sont jamais montrés à l'IA ; l'IA voit seulement les boutons, les champs et le texte de la page.

type Page = import("playwright-core").Page;

/** Interdit en saisie comme en lecture (en plus, la lecture refuse tout ce qui modifie). */
const NEVER = /supprim|effac|delete|remove|annul|encaiss|r[èe]glement|paiement|payer|factur(er|ation|e d[ée]finitive)|transformer en facture|avoir|envoyer|envoi|send|mail|sign|cl[ôo]tur|archiv|d[ée]sactiv|r[ée]silier|vider/i;
const WRITE = /cr[ée]er|ajout|nouveau|nouvel|enregistr|valid|modifier|sauvegard|ok\b/i;
const MAX_STEPS = 40;

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

export type SiteAccess = { site: string; startUrl: string; username: string; password: string; storageState?: string };

/** Ouvre une session connectée, exécute `fn`, garde les cookies à jour, ferme. */
export async function withSite<T>(acc: SiteAccess, fn: (page: Page) => Promise<T>): Promise<{ value: T; storageState: string | null }> {
  const browser = await launch();
  try {
    const context = await browser.newContext({ locale: "fr-FR", viewport: { width: 1280, height: 800 }, ...(acc.storageState ? { storageState: JSON.parse(acc.storageState) } : {}) });
    const page = await context.newPage();
    await page.goto(acc.startUrl, { waitUntil: "networkidle", timeout: 45000 }).catch(() => undefined);
    await loginIfNeeded(page, acc.username, acc.password);
    const value = await fn(page);
    return { value, storageState: JSON.stringify(await context.storageState()) };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function fields(page: Page) {
  const out: { i: number; type: string; label: string; value: string; options?: string[]; shown: boolean }[] = [];
  let offset = 0;
  for (const frame of page.frames()) {
    const list = await frame
      .evaluate((start) => {
        const els = Array.from(document.querySelectorAll("input, textarea, select")) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];
        return els.map((el, k) => {
          const i = start + k;
          const r = el.getBoundingClientRect();
          const type = (el as HTMLInputElement).type ?? el.tagName.toLowerCase();
          const id = el.id;
          const label =
            (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) ||
            el.closest("label")?.textContent ||
            el.getAttribute("aria-label") ||
            el.getAttribute("placeholder") ||
            el.getAttribute("title") ||
            el.getAttribute("name") ||
            "";
          el.setAttribute("data-champ", String(i));
          const options = el.tagName === "SELECT" ? Array.from((el as HTMLSelectElement).options).slice(0, 40).map((o) => o.text.trim()) : undefined;
          return { i, type, label: label.replace(/\s+/g, " ").trim().slice(0, 60), value: type === "password" ? "(masqué)" : String(el.value ?? "").slice(0, 60), options, shown: r.width > 0 && r.height > 0 && type !== "hidden" };
        });
      }, offset)
      .catch(() => []);
    offset += list.length + 1;
    out.push(...list.filter((f) => f.shown && !["submit", "button", "image", "file", "password"].includes(f.type)));
  }
  return out.slice(0, 120);
}

const Action = z.object({
  action: z.enum(["cliquer", "aller", "remplir", "choisir", "lire", "termine", "impossible"]),
  index: z.number().int().nullable().describe("Numéro du bouton (cliquer) ou du champ (remplir / choisir)"),
  valeur: z.string().nullable().describe("Texte à taper (remplir) ou option à choisir (choisir)"),
  url: z.string().nullable().describe("Adresse à ouvrir (aller), même site uniquement"),
  raison: z.string().describe("Pour « termine » : le compte rendu (numéro du document créé, ou ce qui a été lu)"),
});

/** Achats interdits en consultation (on cherche une info, on ne commande jamais). */
const COMMERCE = /panier|commander|commande\b|acheter|achat|valider|confirmer|enregistr|r[ée]server|devis en ligne|payer/i;

async function decide(mode: "lecture" | "saisie" | "consultation", goal: string, page: Page, history: string[], extra = "") {
  const [btns, flds] = await Promise.all([clickables(page), mode !== "lecture" ? fields(page) : Promise.resolve([])]);
  const text = await pageText(page, 4000);
  const rules =
    mode === "consultation"
      ? `MODE CONSULTATION : tu cherches une INFORMATION dans ce portail (base technique constructeur, catalogue fournisseur...). Tu peux taper dans les champs de recherche (immatriculation, VIN, référence, modèle) et cliquer sur rechercher / les résultats / les onglets. Quand l'information est à l'écran, « lire » (le texte est enregistré), puis « termine » avec la réponse exacte trouvée (valeurs, unités, références, prix, disponibilité) et où tu l'as lue. INTERDIT : ajouter au panier, commander, acheter, valider, réserver, payer. Si l'info n'existe pas dans le portail, « impossible » : n'invente jamais une valeur.`
      : mode === "lecture"
      ? `MODE LECTURE SEULE : tu navigues pour AFFICHER l'information, tu ne modifies rien. Quand la liste voulue est à l'écran, réponds « lire » (le texte de la page est enregistré), puis va à la page suivante de la liste s'il y en a une et « lire » encore. Quand tout est lu, « termine ».`
      : `MODE SAISIE : tu saisis UN document dans le logiciel, exactement avec les données fournies, ni plus ni moins. Remplis les champs (« remplir » / « choisir »), ajoute les lignes, puis enregistre le document comme DEVIS ou ORDRE DE RÉPARATION. INTERDIT : facturer, transformer en facture, encaisser, saisir un règlement, supprimer, annuler, envoyer par e-mail, signer, clôturer. Si une donnée obligatoire manque ou si l'écran est ambigu, réponds « impossible » avec la raison. À la fin, « termine » avec le numéro du document créé.`;
  const stream = anthropic().beta.messages.stream({
    model: "claude-opus-5-5",
    max_tokens: 3000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { format: betaZodOutputFormat(Action) },
    messages: [
      {
        role: "user",
        content: [...(await screenFor(page)), { type: "text" as const, text: `Tu pilotes un navigateur connecté au logiciel de gestion d'un garage. La capture d'écran ci-dessus montre la page actuelle.
${rules}
Objectif : ${goal}${extra}

Page : ${page.url()} — « ${await page.title()} »
Déjà fait : ${history.slice(-25).join(" → ") || "rien"}${loopWarning(history)}
Texte de la page : ${text}

Boutons et liens (numéro : texte [lien]) :
${btns.map((e) => `${e.i} : ${e.text}${e.href ? ` [${e.href}]` : ""}`).join("\n")}${
          flds.length
            ? `\n\nChamps (numéro : type « libellé » = valeur actuelle [options]) :\n${flds.map((f) => `${f.i} : ${f.type} « ${f.label} » = ${f.value}${f.options ? ` [${f.options.join(" | ")}]` : ""}`).join("\n")}`
            : ""
        }` }],
      },
    ],
  });
  const msg = await stream.finalMessage();
  return { a: Action.parse(JSON.parse(msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join(""))), btns };
}

function sameSite(start: string, url: string) {
  const a = new URL(start);
  const b = new URL(url, start);
  return b.hostname === a.hostname || b.hostname.endsWith("." + a.hostname.replace(/^www\./, ""));
}

/** Lit une liste à l'écran (toutes les pages) et renvoie le texte brut capturé. */
export async function readScreens(page: Page, acc: SiteAccess, key: string, goal: string) {
  const pathKey = `operator-path:${acc.site}:${key}`;
  const saved = await prisma.appSetting.findUnique({ where: { key: pathKey } });
  const captures: string[] = [];
  const capture = async () => captures.push(await pageText(page, 60000));
  // 1) chemin connu (sans IA)
  if (saved) {
    try {
      for (const s of JSON.parse(saved.value) as { text?: string; url?: string; read?: boolean }[]) {
        await loginIfNeeded(page, acc.username, acc.password);
        if (s.read) await capture();
        else if (s.url) await page.goto(s.url, { waitUntil: "networkidle", timeout: 30000 });
        else if (s.text) {
          const loc = await textInFrames(page, s.text);
          if (!(await visible(loc))) throw new Error("chemin périmé");
          await loc.click({ timeout: 10000 });
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
        }
      }
      if (captures.some((c) => c.trim().length > 200)) return captures.join("\n\n=== page suivante ===\n\n");
    } catch {
      /* chemin périmé : on le retrouve avec l'IA */
    }
    captures.length = 0;
    await page.goto(acc.startUrl, { waitUntil: "networkidle", timeout: 45000 }).catch(() => undefined);
  }
  // 2) navigation guidée par l'IA
  const steps: { text?: string; url?: string; read?: boolean }[] = [];
  const history: string[] = [];
  for (let n = 0; n < 28; n++) {
    await loginIfNeeded(page, acc.username, acc.password);
    const { a, btns } = await decide("lecture", goal, page, history);
    if (a.action === "termine" || a.action === "impossible") {
      if (a.action === "impossible" && !captures.length) throw new Error(`Lecture impossible : ${a.raison}`);
      break;
    }
    if (a.action === "lire") {
      await capture();
      steps.push({ read: true });
      history.push("lire");
      continue;
    }
    if (a.action === "aller" && a.url) {
      if (!sameSite(acc.startUrl, a.url)) throw new Error("Le robot a voulu quitter le site : arrêt.");
      if (NEVER.test(a.url) || WRITE.test(new URL(a.url, page.url()).pathname)) {
        history.push(`refusé ${a.url}`);
        continue;
      }
      await page.goto(new URL(a.url, page.url()).toString(), { waitUntil: "networkidle", timeout: 30000 }).catch(() => undefined);
      steps.push({ url: page.url() });
      history.push(`ouvrir ${new URL(page.url()).pathname}`);
      continue;
    }
    const el = btns.find((b) => b.i === a.index);
    if (a.action !== "cliquer" || !el) {
      history.push("(action invalide en lecture)");
      continue;
    }
    if (NEVER.test(`${el.text} ${el.href ?? ""}`) || WRITE.test(el.text)) {
      history.push(`refusé « ${el.text} » (lecture seule)`);
      continue;
    }
    await (await inFrames(page, `[data-robot="${el.i}"]`)).click({ timeout: 10000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
    steps.push({ text: el.text });
    history.push(`cliquer « ${el.text} »`);
  }
  if (!captures.length) throw new Error(`Liste introuvable après 28 étapes (${history.slice(-4).join(" → ")})`);
  await prisma.appSetting.upsert({ where: { key: pathKey }, update: { value: JSON.stringify(steps) }, create: { key: pathKey, value: JSON.stringify(steps) } });
  return captures.join("\n\n=== page suivante ===\n\n");
}

/** Saisit un document validé. Renvoie le compte rendu (numéro créé) et une capture d'écran finale. */
export async function fillDocument(page: Page, acc: SiteAccess, goal: string, data: unknown) {
  const history: string[] = [];
  const extra = `\n\nDONNÉES À SAISIR (validées par le fondateur) :\n${JSON.stringify(data, null, 2).slice(0, 6000)}`;
  for (let n = 0; n < MAX_STEPS; n++) {
    await loginIfNeeded(page, acc.username, acc.password);
    const { a, btns } = await decide("saisie", goal, page, history, extra);
    if (a.action === "termine") return { result: a.raison, screenshot: await page.screenshot({ type: "jpeg", quality: 70, fullPage: true }) };
    if (a.action === "impossible") throw new Error(`Saisie impossible : ${a.raison}`);
    if (a.action === "lire") {
      history.push("(lire ignoré)");
      continue;
    }
    if (a.action === "aller" && a.url) {
      if (!sameSite(acc.startUrl, a.url) || NEVER.test(a.url)) {
        history.push(`refusé ${a.url}`);
        continue;
      }
      await page.goto(new URL(a.url, page.url()).toString(), { waitUntil: "networkidle", timeout: 30000 }).catch(() => undefined);
      history.push(`ouvrir ${new URL(page.url()).pathname}`);
      continue;
    }
    if (a.action === "remplir" || a.action === "choisir") {
      const loc = await inFrames(page, `[data-champ="${a.index}"]`);
      if (!(await visible(loc))) {
        history.push(`champ ${a.index} introuvable`);
        continue;
      }
      const v = String(a.valeur ?? "").slice(0, 500);
      if (a.action === "choisir") await loc.selectOption({ label: v }).catch(() => loc.selectOption(v)).catch(() => undefined);
      else {
        await loc.fill(v).catch(() => undefined);
        await loc.press("Tab").catch(() => undefined);
      }
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
      history.push(`${a.action} ${a.index} = « ${v.slice(0, 40)} »`);
      continue;
    }
    const el = btns.find((b) => b.i === a.index);
    if (!el) {
      history.push("(numéro invalide)");
      continue;
    }
    if (NEVER.test(`${el.text} ${el.href ?? ""}`)) {
      history.push(`REFUSÉ « ${el.text} » (interdit : facturer, encaisser, supprimer, envoyer...)`);
      continue;
    }
    // Boîte de confirmation : acceptée seulement si elle ne parle pas de facturer, supprimer, encaisser...
    page.once("dialog", (d) => void (NEVER.test(d.message()) ? d.dismiss() : d.accept()).catch(() => undefined));
    await (await inFrames(page, `[data-robot="${el.i}"]`)).click({ timeout: 10000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
    history.push(`cliquer « ${el.text} »`);
  }
  throw new Error(`Saisie non terminée après ${MAX_STEPS} étapes (${history.slice(-5).join(" → ")})`);
}

/** Cherche une information dans un portail (WebDataBays, catalogue fournisseur...) et renvoie la réponse + le texte lu. */
export async function consultSite(page: Page, acc: SiteAccess, question: string) {
  const history: string[] = [];
  const captures: string[] = [];
  for (let n = 0; n < 30; n++) {
    await loginIfNeeded(page, acc.username, acc.password);
    const { a, btns } = await decide("consultation", question, page, history);
    if (a.action === "termine") return { reponse: a.raison, texteLu: captures.join("\n\n---\n\n").slice(0, 40000), page: page.url() };
    if (a.action === "impossible") return { reponse: `Introuvable dans ce portail : ${a.raison}`, texteLu: captures.join("\n\n---\n\n").slice(0, 20000), page: page.url() };
    if (a.action === "lire") {
      captures.push(await pageText(page, 30000));
      history.push("lire");
      continue;
    }
    if (a.action === "aller" && a.url) {
      if (!sameSite(acc.startUrl, a.url) || NEVER.test(a.url) || COMMERCE.test(a.url)) {
        history.push(`refusé ${a.url}`);
        continue;
      }
      await page.goto(new URL(a.url, page.url()).toString(), { waitUntil: "networkidle", timeout: 30000 }).catch(() => undefined);
      history.push(`ouvrir ${new URL(page.url()).pathname}`);
      continue;
    }
    if (a.action === "remplir" || a.action === "choisir") {
      const loc = await inFrames(page, `[data-champ="${a.index}"]`);
      const v = String(a.valeur ?? "").slice(0, 200);
      if (a.action === "choisir") await loc.selectOption({ label: v }).catch(() => loc.selectOption(v)).catch(() => undefined);
      else {
        await loc.fill(v).catch(() => undefined);
        await loc.press("Enter").catch(() => undefined);
      }
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
      history.push(`${a.action} ${a.index} = « ${v.slice(0, 40)} »`);
      continue;
    }
    const el = btns.find((b) => b.i === a.index);
    if (!el) {
      history.push("(numéro invalide)");
      continue;
    }
    if (NEVER.test(`${el.text} ${el.href ?? ""}`) || COMMERCE.test(`${el.text} ${el.href ?? ""}`)) {
      history.push(`REFUSÉ « ${el.text} » (consultation seulement : ni panier, ni commande)`);
      continue;
    }
    page.once("dialog", (d) => void d.dismiss().catch(() => undefined));
    await (await inFrames(page, `[data-robot="${el.i}"]`)).click({ timeout: 10000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
    history.push(`cliquer « ${el.text} »`);
  }
  return { reponse: "Recherche non aboutie après 30 étapes.", texteLu: captures.join("\n\n---\n\n").slice(0, 20000), page: page.url() };
}
