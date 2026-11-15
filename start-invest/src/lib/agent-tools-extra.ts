import type Anthropic from "@anthropic-ai/sdk";
import { lookup } from "dns/promises";
import net from "net";
import { prisma } from "@/lib/prisma";
import type { AgentDef } from "@/lib/agents";
import { driveCreateFolder, driveList, driveMove, gmailOrganize, gmailRead, gmailSearch } from "@/lib/connectors/google";

// Outils supplémentaires du board : présence en ligne (sites, réseaux sociaux, référencement),
// demandes du terrain (WhatsApp), et Gmail / Drive des sociétés.
// Règles : un agent ne touche qu'à SA société (sauf la direction du groupe) ; seuls les agents
// « Secrétariat » peuvent ranger (libellés, archivage, dossiers) ; personne ne peut envoyer ni supprimer.

const GROUP = ["ceo", "cfo", "cmo", "seo-geo", "contenu-reseaux", "publicite"];
const isSecretariat = (a: AgentDef) => a.slug.startsWith("secretariat-");
const canReadMail = (a: AgentDef) => isSecretariat(a) || a.slug.startsWith("dg-") || a.slug.startsWith("daf-") || a.slug === "ceo";

const societe = { type: "string", description: "Nom de la société (par défaut : la tienne)." } as const;

export function extraTools(agent: AgentDef): Anthropic.Beta.BetaTool[] {
  const tools: Anthropic.Beta.BetaTool[] = [
    {
      name: "presence_en_ligne",
      description: "Site internet et réseaux sociaux enregistrés pour une société (ou toutes) : adresses du site, Instagram, Facebook, TikTok, fiche Google, LinkedIn.",
      input_schema: { type: "object", properties: { societe }, additionalProperties: false },
    },
    {
      name: "analyser_site",
      description:
        "Audit SEO d'une page web publique : statut, temps de réponse, HTTPS, titre, meta description, balises h1/h2, nombre de mots, images sans texte alternatif, liens, balises Open Graph, données structurées (schema.org), robots, présence de sitemap.xml et robots.txt, numéro de téléphone et adresse visibles.",
      input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
    },
    {
      name: "lister_demandes_terrain",
      description: "Messages WhatsApp des salariés : frais (tickets, factures payées), besoins (pièces, matériel à commander), interventions faites, avec montant, fournisseur, véhicule / client, urgence et statut.",
      input_schema: {
        type: "object",
        properties: { societe, jours: { type: "integer", description: "Défaut 30." }, type: { type: "string", enum: ["FRAIS", "BESOIN", "INTERVENTION", "AUTRE", "TOUS"] }, statut: { type: "string", enum: ["NOUVEAU", "TRAITE", "TOUS"] } },
        additionalProperties: false,
      },
    },
  ];
  if (canReadMail(agent)) {
    tools.push(
      {
        name: "mails_rechercher",
        description: "Cherche des e-mails dans la boîte Gmail de la société (syntaxe de recherche Gmail : is:unread, in:inbox, from:, subject:, has:attachment, newer_than:2d, label:...). Renvoie expéditeur, objet, date, extrait, libellés.",
        input_schema: { type: "object", properties: { societe, recherche: { type: "string", description: "Défaut : in:inbox newer_than:3d" }, max: { type: "integer", description: "Défaut 30, max 100." }, boite: { type: "string", description: "Adresse e-mail si la société en a plusieurs." } }, additionalProperties: false },
      },
      {
        name: "mail_lire",
        description: "Lit le contenu complet d'un e-mail (texte, pièces jointes).",
        input_schema: { type: "object", properties: { societe, id: { type: "string" }, boite: { type: "string" } }, required: ["id"], additionalProperties: false },
      },
      {
        name: "drive_lister",
        description: "Liste les fichiers et dossiers du Google Drive de la société (racine, un dossier, ou une recherche par nom).",
        input_schema: { type: "object", properties: { societe, dossier: { type: "string", description: "Identifiant du dossier" }, recherche: { type: "string" }, boite: { type: "string" } }, additionalProperties: false },
      }
    );
  }
  if (isSecretariat(agent)) {
    tools.push(
      {
        name: "mail_ranger",
        description: "Range un e-mail : ajoute un libellé (créé s'il n'existe pas, ex. « Factures fournisseurs », « Clients », « Banque », « Administration »), l'archive (le sort de la boîte de réception), le marque lu, ou le marque important. Impossible d'envoyer ou de supprimer.",
        input_schema: {
          type: "object",
          properties: { societe, id: { type: "string" }, libelle: { type: "string" }, archiver: { type: "boolean" }, marquer_lu: { type: "boolean" }, important: { type: "boolean" }, boite: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "drive_creer_dossier",
        description: "Crée un dossier dans le Drive de la société (ex. « 2026 / Factures fournisseurs »).",
        input_schema: { type: "object", properties: { societe, nom: { type: "string" }, parent: { type: "string", description: "Identifiant du dossier parent (vide = racine)" }, boite: { type: "string" } }, required: ["nom"], additionalProperties: false },
      },
      {
        name: "drive_deplacer",
        description: "Déplace un fichier dans un dossier et/ou le renomme clairement (ex. « 2026-11-03 Facture Total 45,90 € »). Aucune suppression possible.",
        input_schema: { type: "object", properties: { societe, fichier: { type: "string" }, vers_dossier: { type: "string" }, nouveau_nom: { type: "string" }, boite: { type: "string" } }, required: ["fichier"], additionalProperties: false },
      }
    );
  }
  return tools;
}

export const EXTRA_TOOL_NAMES = new Set(["presence_en_ligne", "analyser_site", "lister_demandes_terrain", "mails_rechercher", "mail_lire", "drive_lister", "mail_ranger", "drive_creer_dossier", "drive_deplacer"]);

async function scopeCompany(agent: AgentDef, name?: string) {
  const all = await prisma.company.findMany({ where: { active: true } });
  const own = all.find((c) => c.name === agent.structure);
  const group = GROUP.includes(agent.slug) || !own;
  if (!name) return group ? null : own!;
  const q = name.toLowerCase();
  const c = all.find((x) => x.id === name) ?? all.find((x) => x.name.toLowerCase().includes(q));
  if (!c) throw new Error(`Société « ${name} » introuvable.`);
  if (!group && c.id !== own!.id) throw new Error(`Tu ne travailles que pour ${own!.name}.`);
  return c;
}

async function googleFor(agent: AgentDef, name?: string, boite?: string) {
  const c = await scopeCompany(agent, name);
  if (!c) throw new Error("Précise la société.");
  const list = await prisma.integration.findMany({ where: { provider: "GOOGLE", companyId: c.id } });
  if (!list.length) throw new Error(`Google (Gmail + Drive) n'est pas encore connecté pour ${c.name} : à faire dans Connexions.`);
  const i = boite ? list.find((x) => x.label?.toLowerCase() === boite.toLowerCase()) : list[0];
  if (!i) throw new Error(`Adresses connectées pour ${c.name} : ${list.map((x) => x.label).join(", ")}`);
  return i.id;
}

// ------------------------------------------------------------------ audit SEO (avec protection contre l'accès au réseau interne)

function privateIp(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const x = ip.toLowerCase();
  return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80") || x.startsWith("::ffff:127.") || x.startsWith("::ffff:10.") || x.startsWith("::ffff:192.168.");
}

async function safeFetch(raw: string, redirects = 4): Promise<{ res: Response; url: string; ms: number }> {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Adresse http(s) uniquement.");
  const ips = await lookup(u.hostname, { all: true });
  if (!ips.length || ips.some((i) => privateIp(i.address))) throw new Error("Adresse non publique refusée.");
  const t = Date.now();
  const res = await fetch(u, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (compatible; StartInvestSEO/1.0)", Accept: "text/html,*/*" }, signal: AbortSignal.timeout(15000), cache: "no-store" });
  if (res.status >= 300 && res.status < 400 && res.headers.get("location") && redirects > 0) return safeFetch(new URL(res.headers.get("location")!, u).toString(), redirects - 1);
  return { res, url: u.toString(), ms: Date.now() - t };
}

const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const all = (html: string, re: RegExp) => [...html.matchAll(re)].map((m) => strip(m[1])).filter(Boolean);
const meta = (html: string, name: string) =>
  html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i"))?.[1] ??
  html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, "i"))?.[1] ??
  null;

async function auditSite(url: string) {
  const { res, url: final, ms } = await safeFetch(/^https?:/i.test(url) ? url : `https://${url}`);
  const html = (await res.text()).slice(0, 2_000_000);
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ");
  const text = strip(body);
  const origin = new URL(final).origin;
  const links = [...html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)].map((m) => m[1]);
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const check = async (p: string) => safeFetch(origin + p).then((r) => r.res.status).catch(() => null);
  const [robots, sitemap] = await Promise.all([check("/robots.txt"), check("/sitemap.xml")]);
  return {
    url: final,
    statut: res.status,
    tempsReponseMs: ms,
    https: final.startsWith("https://"),
    titre: all(html, /<title[^>]*>([\s\S]*?)<\/title>/gi)[0] ?? null,
    longueurTitre: (all(html, /<title[^>]*>([\s\S]*?)<\/title>/gi)[0] ?? "").length,
    metaDescription: meta(html, "description"),
    h1: all(body, /<h1[^>]*>([\s\S]*?)<\/h1>/gi).slice(0, 5),
    h2: all(body, /<h2[^>]*>([\s\S]*?)<\/h2>/gi).slice(0, 15),
    nombreDeMots: text.split(" ").length,
    images: imgs.length,
    imagesSansAlt: imgs.filter((i) => !/\balt=["'][^"']+["']/i.test(i)).length,
    liensInternes: links.filter((l) => l.startsWith("/") || l.startsWith(origin)).length,
    liensExternes: links.filter((l) => /^https?:/.test(l) && !l.startsWith(origin)).length,
    canonical: html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1] ?? null,
    robotsMeta: meta(html, "robots"),
    openGraph: { titre: meta(html, "og:title"), description: meta(html, "og:description"), image: meta(html, "og:image") },
    donneesStructurees: [...html.matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map((m) => m[1]).slice(0, 10),
    langue: html.match(/<html[^>]+lang=["']([^"']+)["']/i)?.[1] ?? null,
    viewportMobile: /<meta[^>]+name=["']viewport["']/i.test(html),
    telephoneVisible: /(\+33|0)[1-9](?:[ .-]?\d{2}){4}/.test(text),
    robotsTxt: robots,
    sitemapXml: sitemap,
    debutDuTexte: text.slice(0, 1500),
  };
}

export async function runExtraTool(name: string, input: Record<string, unknown>, agent: AgentDef): Promise<unknown> {
  const soc = input.societe as string | undefined;
  const boite = input.boite as string | undefined;
  switch (name) {
    case "presence_en_ligne": {
      const c = await scopeCompany(agent, soc);
      const list = await prisma.company.findMany({ where: { active: true, ...(c ? { id: c.id } : {}) } });
      return list.map((x) => ({ societe: x.name, activite: x.activity, site: x.website, instagram: x.instagram, facebook: x.facebook, tiktok: x.tiktok, ficheGoogle: x.googleBusiness, linkedin: x.linkedin }));
    }
    case "analyser_site":
      return auditSite(String(input.url ?? ""));
    case "lister_demandes_terrain": {
      const c = await scopeCompany(agent, soc);
      const type = String(input.type ?? "TOUS");
      const statut = String(input.statut ?? "TOUS");
      const rows = await prisma.fieldRequest.findMany({
        where: {
          ...(c ? { companyId: c.id } : {}),
          createdAt: { gte: new Date(Date.now() - (Number(input.jours) || 30) * 86400000) },
          ...(type !== "TOUS" ? { kind: type } : {}),
          ...(statut !== "TOUS" ? { status: statut } : {}),
        },
        include: { company: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 300,
      });
      return rows.map((r) => ({ id: r.id, date: r.createdAt.toISOString().slice(0, 16), societe: r.company.name, de: r.fromName ?? r.fromPhone, type: r.kind, resume: r.summary, texte: r.text, montant: r.amount, fournisseur: r.merchant, dateDepense: r.spentAt?.toISOString().slice(0, 10) ?? null, vehiculeOuClient: r.vehicle, urgent: r.urgent, photo: Boolean(r.documentId), statut: r.status }));
    }
    case "mails_rechercher":
      return gmailSearch(await googleFor(agent, soc, boite), String(input.recherche || "in:inbox newer_than:3d"), Number(input.max) || 30);
    case "mail_lire":
      return gmailRead(await googleFor(agent, soc, boite), String(input.id));
    case "drive_lister":
      return driveList(await googleFor(agent, soc, boite), { dossier: input.dossier as string | undefined, recherche: input.recherche as string | undefined });
    case "mail_ranger":
      if (!isSecretariat(agent)) throw new Error("Réservé aux agents Secrétariat.");
      return gmailOrganize(await googleFor(agent, soc, boite), String(input.id), { libelle: input.libelle as string | undefined, archiver: Boolean(input.archiver), marquerLu: Boolean(input.marquer_lu), important: Boolean(input.important) });
    case "drive_creer_dossier":
      if (!isSecretariat(agent)) throw new Error("Réservé aux agents Secrétariat.");
      return driveCreateFolder(await googleFor(agent, soc, boite), String(input.nom), input.parent as string | undefined);
    case "drive_deplacer":
      if (!isSecretariat(agent)) throw new Error("Réservé aux agents Secrétariat.");
      return driveMove(await googleFor(agent, soc, boite), String(input.fichier), { versDossier: input.vers_dossier as string | undefined, nouveauNom: input.nouveau_nom as string | undefined });
  }
  throw new Error(`Outil inconnu : ${name}`);
}
