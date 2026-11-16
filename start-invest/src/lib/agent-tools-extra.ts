import type Anthropic from "@anthropic-ai/sdk";
import { lookup } from "dns/promises";
import net from "net";
import { prisma } from "@/lib/prisma";
import type { AgentDef } from "@/lib/agents";
import { repoFile, repoStatus } from "@/lib/connectors/github";
import { outlookAttachments, outlookOrganize, outlookRead, outlookSearch } from "@/lib/connectors/microsoft";
import { gmailAttachments } from "@/lib/connectors/google";
import { imapAttachments, imapOrganize, imapRead, imapSearch } from "@/lib/connectors/imap";
import { driveCreateFolder, driveList, driveMove, gmailOrganize, gmailRead, gmailSearch } from "@/lib/connectors/google";

// Outils supplémentaires du board : présence en ligne (sites, réseaux sociaux, référencement),
// demandes du terrain (WhatsApp), et Gmail / Drive des sociétés.
// Règles : un agent ne touche qu'à SA société (sauf la direction du groupe) ; seuls les agents
// « Secrétariat » peuvent ranger (libellés, archivage, dossiers) ; personne ne peut envoyer ni supprimer.

const GROUP = ["ceo", "cfo", "cmo", "seo-geo", "contenu-reseaux", "publicite"];
// Secrétariats et agents « Courrier » : seuls à pouvoir ranger les e-mails et le Drive.
const isSecretariat = (a: AgentDef) => a.slug.startsWith("secretariat-") || a.slug.startsWith("courrier-");
const ATELIER_WRITERS = ["courrier-auto-rac-ives", "clients-devis-auto-rac-ives", "dg-auto-rac-ives", "planning-atelier-auto-rac-ives", "pieces-auto-rac-ives", "secretariat-auto-rac-ives"];
const canSeeAtelier = (a: AgentDef) => a.structure === "Auto Rac Ives" || ["ceo", "cfo", "avocat-du-diable"].includes(a.slug);
const canSeeProjects = (a: AgentDef) => a.slug === "directeur-projets" || a.slug.startsWith("projet-") || ["ceo", "cto", "cmo", "avocat-du-diable", "moneymaker"].includes(a.slug);
const canReadMail = (a: AgentDef) => isSecretariat(a) || ATELIER_WRITERS.includes(a.slug) || a.slug.startsWith("dg-") || a.slug.startsWith("daf-") || a.slug === "ceo";

const portalBusy = new Set<string>();
const societe = { type: "string", description: "Nom de la société (par défaut : la tienne)." } as const;

export function extraTools(agent: AgentDef): Anthropic.Beta.BetaTool[] {
  const tools: Anthropic.Beta.BetaTool[] = [
    {
      name: "presence_en_ligne",
      description: "Site internet et réseaux sociaux enregistrés pour une société (ou toutes) : adresses du site, Instagram, Facebook, TikTok, fiche Google, LinkedIn.",
      input_schema: { type: "object", properties: { societe }, additionalProperties: false },
    },
    {
      name: "resultats_societe",
      description:
        "CHIFFRES RÉELS d'une société (ou de toutes si tu es au niveau groupe) pour l'année : ce qu'elle gagne (banque, hors prêts et virements internes), entrées/sorties mois par mois, principales dépenses, solde et découvert, véhicules vendus (mois/année, marge, stock Auto Cerfa), nombre et montant des factures clients (GTA Pro...), loyers perçus/payés, bilans, et la liste de ce qui MANQUE. À utiliser AVANT toute réponse chiffrée.",
      input_schema: { type: "object", properties: { societe, annee: { type: "integer" } }, additionalProperties: false },
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
        name: "boites_mail",
        description: "Liste les boîtes mail connectées de la société (Gmail et Outlook), avec leur adresse. Quand il y en a plusieurs, traite-les une par une avec le paramètre « boite ».",
        input_schema: { type: "object", properties: { societe }, additionalProperties: false },
      },
      {
        name: "mails_rechercher",
        description: "Cherche des e-mails dans une boîte de la société. Gmail : syntaxe Gmail (is:unread, in:inbox, from:, subject:, has:attachment, newer_than:2d). Outlook : syntaxe Outlook (from:, subject:, received>=2026-11-14, hasattachments:true) ; vide = boîte de réception récente. Renvoie expéditeur, objet, date, extrait.",
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
  tools.push(
    {
      name: "lister_portails",
      description: "Portails pros connectés pour ta société (WebDataBays, fournisseurs de pièces, cote...) et à quoi ils servent.",
      input_schema: { type: "object", properties: { societe }, additionalProperties: false },
    },
    {
      name: "consulter_portail",
      description:
        "Cherche une information RÉELLE dans un portail pro connecté (ex. catalogue fournisseur : prix et disponibilité d'une pièce ; PAS WebDataBays, qui bloque les robots : ses temps barème sont saisis par le fondateur ; périodicité d'entretien ; fournisseur : prix et disponibilité d'une référence pour un véhicule). Donne une question précise avec le véhicule (immatriculation ou marque / modèle / motorisation / année). Prend 1 à 3 minutes. Consultation seulement : jamais de commande.",
      input_schema: { type: "object", properties: { portail: { type: "string", description: "Nom du portail (voir lister_portails)" }, question: { type: "string" }, societe }, required: ["portail", "question"], additionalProperties: false },
    }
  );
  if (canSeeAtelier(agent) || agent.slug.startsWith("salarie-")) {
    tools.push(
      {
        name: "lister_rdv",
        description: "Rendez-vous de l'atelier Auto Rac'Ives sur une période : date et heure, durée prévue, client, véhicule, prestation, mécanicien affecté, statut, source. Plus la charge prévue par mécanicien et par jour.",
        input_schema: { type: "object", properties: { du: { type: "string", description: "AAAA-MM-JJ, défaut aujourd'hui" }, au: { type: "string", description: "AAAA-MM-JJ, défaut +7 jours" }, mecanicien: { type: "string" } }, additionalProperties: false },
      },
      {
        name: "rentabilite_atelier",
        description:
          "Rentabilité et occupation de chaque mécanicien sur une période : heures de présence prévues (contrat moins congés et école), heures planifiées en rendez-vous, temps passés déclarés sur WhatsApp, nombre d'interventions, taux d'occupation et de productivité. Indique ce qui manque pour un calcul complet (heures vendues GTA Pro).",
        input_schema: { type: "object", properties: { du: { type: "string" }, au: { type: "string" }, mecanicien: { type: "string" } }, additionalProperties: false },
      }
    );
  }
  if (["planning-atelier-auto-rac-ives", "clients-devis-auto-rac-ives", "courrier-auto-rac-ives", "dg-auto-rac-ives", "secretariat-auto-rac-ives"].includes(agent.slug)) {
    tools.push(
      {
        name: "noter_rdv",
        description: "Note un rendez-vous d'atelier (demandé par téléphone, mail, WhatsApp, site). Durée prévue = temps barème WebDataBays quand il est connu, sinon la durée annoncée. Vérifie d'abord la charge avec lister_rdv pour affecter le bon mécanicien.",
        input_schema: {
          type: "object",
          properties: {
            date: { type: "string", description: "AAAA-MM-JJ" },
            heure: { type: "string", description: "HH:MM" },
            duree_minutes: { type: "integer" },
            client: { type: "string" },
            telephone: { type: "string" },
            vehicule: { type: "string", description: "Marque modèle immatriculation" },
            prestation: { type: "string" },
            mecanicien: { type: "string", description: "Prénom (Grégory, Gérard, Mathéo...)" },
            source: { type: "string" },
            notes: { type: "string" },
          },
          required: ["date", "heure", "client", "prestation"],
          additionalProperties: false,
        },
      },
      {
        name: "modifier_rdv",
        description: "Modifie un rendez-vous : statut (CONFIRME, EN_COURS, TERMINE, ANNULE, ABSENT), mécanicien, date / heure, durée, notes.",
        input_schema: { type: "object", properties: { id: { type: "string" }, statut: { type: "string", enum: ["PREVU", "CONFIRME", "EN_COURS", "TERMINE", "ANNULE", "ABSENT"] }, mecanicien: { type: "string" }, date: { type: "string" }, heure: { type: "string" }, duree_minutes: { type: "integer" }, notes: { type: "string" } }, required: ["id"], additionalProperties: false },
      }
    );
  }
  if (canSeeAtelier(agent)) {
    tools.push({
      name: "lister_atelier",
      description: "Atelier Auto Rac'Ives (GTA Pro) : devis et ordres de réparation en cours lus dans GTA Pro, factures impayées, et documents préparés par les agents (brouillons à valider, saisis, en erreur).",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    });
  }
  if (ATELIER_WRITERS.includes(agent.slug)) {
    tools.push({
      name: "preparer_document_atelier",
      description:
        "Prépare un DEVIS ou un ORDRE DE RÉPARATION (OR) à saisir dans GTA Pro. Il part en BROUILLON : le fondateur le vérifie et le valide dans la page Atelier, puis le robot le saisit. AUCUNE valeur inventée : temps de main-d'œuvre lus dans WebDataBays (consulter_portail), prix des pièces lus chez le fournisseur ou dans GTA Pro, taux horaire de l'atelier tel qu'il est dans GTA Pro ; chaque ligne a sa source, sinon « à compléter » avec prix 0.",
      input_schema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["DEVIS", "OR"] },
          client: { type: "object", properties: { nom: { type: "string" }, telephone: { type: "string" }, email: { type: "string" }, adresse: { type: "string" } }, required: ["nom"], additionalProperties: false },
          vehicule: { type: "object", properties: { immatriculation: { type: "string" }, marque: { type: "string" }, modele: { type: "string" }, kilometrage: { type: "integer" }, vin: { type: "string" } }, required: ["immatriculation"], additionalProperties: false },
          lignes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["MAIN_OEUVRE", "PIECE", "FORFAIT"] },
                designation: { type: "string" },
                reference: { type: "string" },
                quantite: { type: "number", description: "Heures pour la main-d'œuvre" },
                prix_unitaire_ht: { type: "number", description: "0 si la valeur n'a pas pu être obtenue (source « à compléter »)" },
                source: { type: "string", description: "D'où vient la valeur : « WebDataBays », le nom du portail fournisseur, « tarif GTA Pro », « facture fournisseur du ... », ou « à compléter » si introuvable. JAMAIS une estimation." },
              },
              required: ["type", "designation", "quantite", "prix_unitaire_ht", "source"],
              additionalProperties: false,
            },
          },
          remarques: { type: "string" },
        },
        required: ["type", "client", "vehicule", "lignes"],
        additionalProperties: false,
      },
    });
  }
  if (canSeeProjects(agent)) {
    tools.push(
      {
        name: "lister_projets",
        description: "Projets du fondateur (hors sociétés du groupe) : nom, description, objectif, statut, site, dépôt GitHub, consignes.",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "lire_projet",
        description: "État réel d'un projet sur GitHub (lecture seule) : README, 15 derniers changements, tâches et demandes de fusion ouvertes, derniers builds, liste des documents. Avec « fichier » : lit ce document du dépôt (ex. docs/13-launch-timeline.md).",
        input_schema: { type: "object", properties: { projet: { type: "string" }, fichier: { type: "string" } }, required: ["projet"], additionalProperties: false },
      }
    );
  }
  if (agent.slug === "avocat-du-diable") {
    tools.push({
      name: "corriger_agent",
      description: "Inscrit une correction dans la mémoire d'un agent qui s'est trompé (bon chiffre, bonne règle), pour qu'il ne refasse pas l'erreur. Une correction courte et précise par appel.",
      input_schema: { type: "object", properties: { agent: { type: "string", description: "Slug de l'agent (ex. daf-bar-lusine)" }, correction: { type: "string" } }, required: ["agent", "correction"], additionalProperties: false },
    });
  }
  if (isSecretariat(agent)) {
    tools.push(
      {
        name: "mail_enregistrer_facture",
        description: "Enregistre la ou les factures en pièce jointe d'un e-mail (PDF ou photo) : archivées chiffrées, lues par l'IA (fournisseur, numéro, montant, échéance) et ajoutées aux factures fournisseurs à payer de la société, puis rapprochées de la banque. « pour_societe » : la société concernée si la boîte sert à plusieurs sociétés (boîte du fondateur).",
        input_schema: { type: "object", properties: { societe, id: { type: "string" }, boite: { type: "string" }, pour_societe: { type: "string" } }, required: ["id"], additionalProperties: false },
      },
      {
        name: "mail_ranger",
        description: "Range un e-mail : Gmail = ajoute un libellé (créé s'il n'existe pas) et/ou l'archive ; Outlook = le déplace dans un dossier (créé s'il n'existe pas, ex. « La Fabrique Automobile/Factures »). Peut aussi le marquer lu ou important. Impossible d'envoyer ou de supprimer.",
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

export const EXTRA_TOOL_NAMES = new Set(["resultats_societe", "lister_rdv", "rentabilite_atelier", "noter_rdv", "modifier_rdv", "lister_portails", "consulter_portail", "boites_mail", "mail_enregistrer_facture", "lister_atelier", "preparer_document_atelier", "lister_projets", "lire_projet", "corriger_agent", "presence_en_ligne", "analyser_site", "lister_demandes_terrain", "mails_rechercher", "mail_lire", "drive_lister", "mail_ranger", "drive_creer_dossier", "drive_deplacer"]);

async function scopeCompany(agent: AgentDef, name?: string) {
  const all = await prisma.company.findMany({ where: { active: true } });
  const own = all.find((c) => c.name === agent.structure);
  const group = GROUP.includes(agent.slug);
  // Société de l'agent introuvable (renommée, désactivée) : on refuse plutôt que d'ouvrir tout le groupe.
  if (!group && !own) throw new Error(`Société « ${agent.structure} » introuvable ou inactive : accès refusé.`);
  if (!name) return group ? null : own!;
  const q = name.toLowerCase();
  const partial = all.filter((x) => x.name.toLowerCase().includes(q));
  const c = all.find((x) => x.id === name) ?? all.find((x) => x.name.toLowerCase() === q) ?? (partial.length === 1 ? partial[0] : undefined);
  if (!c && partial.length > 1) throw new Error(`Plusieurs sociétés correspondent à « ${name} » : ${partial.map((x) => x.name).join(", ")}.`);
  if (!c) throw new Error(`Société « ${name} » introuvable.`);
  if (!group && c.id !== own!.id) throw new Error(`Tu ne travailles que pour ${own!.name}.`);
  return c;
}

/** Boîte mail (Gmail ou Outlook) de la société de l'agent. S'il y en a plusieurs, « boite » est obligatoire. */
async function mailFor(agent: AgentDef, name?: string, boite?: string) {
  const c = await scopeCompany(agent, name);
  if (!c) throw new Error("Précise la société.");
  const list = await prisma.integration.findMany({ where: { provider: { in: ["GOOGLE", "OUTLOOK", "IMAP"] }, companyId: c.id } });
  if (!list.length) throw new Error(`Aucune boîte mail connectée pour ${c.name} : à faire dans Connexions (boîte mail).`);
  const i = boite ? list.find((x) => x.label?.toLowerCase() === boite.toLowerCase()) : list.length === 1 ? list[0] : null;
  if (!i) throw new Error(`Précise la boîte (paramètre « boite ») parmi : ${list.map((x) => x.label).join(", ")}`);
  return { id: i.id, provider: i.provider as "GOOGLE" | "OUTLOOK" | "IMAP", label: i.label, company: c };
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

export function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  const x = ip.toLowerCase();
  // Adresse IPv4 encapsulée (::ffff:a.b.c.d ou ::ffff:XXXX:XXXX) : on vérifie l'IPv4 qu'elle contient.
  const mapped = x.match(/^::ffff:(?:0:)?(.+)$/);
  if (mapped) {
    const tail = mapped[1];
    if (net.isIPv4(tail)) return privateIp(tail);
    const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return privateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return true;
  }
  return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb") || x.startsWith("ff") || x.startsWith("64:ff9b:");
}

/** Refuse une adresse dont le nom résout vers le réseau interne (serveur, métadonnées du cloud...). */
export async function assertPublicHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "");
  const ips = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!ips.length || ips.some((i) => privateIp(i.address))) throw new Error("Adresse non publique refusée.");
}

async function safeFetch(raw: string, redirects = 4): Promise<{ res: Response; url: string; ms: number }> {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Adresse http(s) uniquement.");
  await assertPublicHost(u.hostname);
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
    case "resultats_societe": {
      const { companyResults, groupResults } = await import("@/lib/results");
      const annee = Number(input.annee) || new Date().getFullYear();
      // L'avocat du diable contre-vérifie tout le groupe : il lit toutes les sociétés.
      if (agent.slug === "avocat-du-diable") {
        const all = await prisma.company.findMany({ where: { active: true } });
        const c = soc ? all.find((x) => x.name.toLowerCase().includes(soc.toLowerCase())) : null;
        return c ? companyResults(c.id, annee) : groupResults(annee);
      }
      const c = await scopeCompany(agent, soc);
      return c ? companyResults(c.id, annee) : groupResults(annee);
    }
    case "lister_atelier": {
      if (!canSeeAtelier(agent)) throw new Error("Réservé à l'atelier Auto Rac'Ives et à la direction.");
      const c = await prisma.company.findFirst({ where: { name: "Auto Rac Ives" } });
      if (!c) throw new Error("Société Auto Rac Ives introuvable.");
      const { atelierSnapshot } = await import("@/lib/connectors/gtapro");
      const [snap, tasks, unpaid] = await Promise.all([
        atelierSnapshot(c.id),
        prisma.robotTask.findMany({ where: { companyId: c.id }, orderBy: { createdAt: "desc" }, take: 40 }),
        prisma.invoice.findMany({ where: { companyId: c.id, kind: "CLIENT", provider: "GTAPRO" }, orderBy: { issueDate: "desc" }, take: 300 }),
      ]);
      return {
        gtaPro: snap ?? "GTA Pro pas encore lu (Connexions → GTA Pro).",
        facturesImpayees: unpaid.filter((i) => i.amount - i.paidAmount > 0.01).map((i) => ({ numero: i.number, client: i.counterparty, date: i.issueDate.toISOString().slice(0, 10), echeance: i.dueDate?.toISOString().slice(0, 10) ?? null, reste: Math.round((i.amount - i.paidAmount) * 100) / 100 })),
        documentsPrepares: tasks.map((t) => ({ type: t.kind, titre: t.title, statut: t.status, resultat: t.result, erreur: t.error, cree: t.createdAt.toISOString().slice(0, 10) })),
      };
    }
    case "preparer_document_atelier": {
      if (!ATELIER_WRITERS.includes(agent.slug)) throw new Error("Réservé aux agents de l'atelier.");
      const c = await prisma.company.findFirst({ where: { name: "Auto Rac Ives" } });
      if (!c) throw new Error("Société Auto Rac Ives introuvable.");
      const lignes = (input.lignes as { type: string; designation: string; quantite: number; prix_unitaire_ht: number }[]) ?? [];
      if (!lignes.length) throw new Error("Au moins une ligne.");
      const totalHt = Math.round(lignes.reduce((t, l) => t + l.quantite * l.prix_unitaire_ht, 0) * 100) / 100;
      const v = input.vehicule as { immatriculation: string; marque?: string; modele?: string };
      const kind = input.type === "OR" ? "OR" : "DEVIS";
      const title = `${kind === "OR" ? "OR" : "Devis"} ${(input.client as { nom: string }).nom} — ${[v.marque, v.modele].filter(Boolean).join(" ")} ${v.immatriculation} — ${totalHt.toFixed(2)} € HT`.slice(0, 200);
      const t = await prisma.robotTask.create({ data: { companyId: c.id, provider: "GTAPRO", kind, title, payload: JSON.stringify({ ...input, total_ht: totalHt }), createdBy: agent.slug } });
      return { ok: true, id: t.id, statut: "BROUILLON — à valider par le fondateur dans la page Atelier", titre: title };
    }
    case "lister_projets": {
      if (!canSeeProjects(agent)) throw new Error("Réservé à la direction des projets.");
      const { ensureDefaultProjects } = await import("@/lib/projects");
      await ensureDefaultProjects();
      return (await prisma.project.findMany({ where: { active: true }, orderBy: { name: "asc" } })).map((p) => ({ nom: p.name, description: p.description, objectif: p.goal, statut: p.status, site: p.website, depot: p.repo, consignes: p.notes }));
    }
    case "lire_projet": {
      if (!canSeeProjects(agent)) throw new Error("Réservé à la direction des projets.");
      const q = String(input.projet ?? "").toLowerCase();
      const list = await prisma.project.findMany({ where: { active: true } });
      const p = list.find((x) => x.name.toLowerCase() === q) ?? (list.filter((x) => x.name.toLowerCase().includes(q)).length === 1 ? list.find((x) => x.name.toLowerCase().includes(q)) : undefined);
      if (!p) throw new Error(`Projet « ${input.projet} » introuvable. Projets : ${list.map((x) => x.name).join(", ")}`);
      // Un chef de projet ne lit que SON projet.
      if (agent.slug.startsWith("projet-")) {
        const { projectAgentSlug } = await import("@/lib/agents");
        if (projectAgentSlug(p) !== agent.slug) throw new Error("Tu ne suis que ton propre projet.");
      }
      if (!p.repo) throw new Error(`Pas de dépôt GitHub renseigné pour ${p.name} (page Projets).`);
      return input.fichier ? repoFile(p.repo, String(input.fichier)) : repoStatus(p.repo);
    }
    case "corriger_agent": {
      if (agent.slug !== "avocat-du-diable") throw new Error("Réservé à l'avocat du diable.");
      const { loadAgents } = await import("@/lib/agents");
      const target = String(input.agent ?? "");
      if (!(await loadAgents()).some((a) => a.slug === target) || target === agent.slug) throw new Error(`Agent « ${target} » inconnu.`);
      const correction = String(input.correction ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
      if (!correction) throw new Error("Correction vide.");
      const day = new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });
      const mem = (await prisma.agentMemory.findUnique({ where: { agent: target } }))?.content ?? "";
      const HEAD = "## Corrections de l'avocat du diable (à respecter)";
      const [before, after = ""] = mem.split(HEAD);
      const lines = [`- ${day} : ${correction}`, ...after.split("\n").filter((l) => l.startsWith("- "))].slice(0, 10);
      const content = `${HEAD}\n${lines.join("\n")}\n\n${before.trim()}`.slice(0, 6000);
      await prisma.agentMemory.upsert({ where: { agent: target }, update: { content }, create: { agent: target, content } });
      return { ok: true, agent: target };
    }
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
    case "lister_rdv":
    case "rentabilite_atelier":
    case "noter_rdv":
    case "modifier_rdv": {
      const { atelierTool } = await import("@/lib/atelier");
      return atelierTool(name, input, agent);
    }
    case "lister_portails": {
      const c = await scopeCompany(agent, soc);
      const list = await prisma.integration.findMany({ where: { provider: "PORTAIL", ...(c ? { companyId: c.id } : {}) }, include: { company: { select: { name: true } } } });
      const { decryptJson } = await import("@/lib/crypto");
      return list.map((x) => {
        const cr = decryptJson<{ url?: string; purpose?: string }>(x.credentials);
        return { portail: x.label, societe: x.company.name, sert_a: cr.purpose ?? null, connecte: Boolean((cr as { storageState?: string; password?: string }).storageState || (cr as { password?: string }).password), etat: x.status, erreur: x.lastError };
      });
    }
    case "consulter_portail": {
      const c = await scopeCompany(agent, soc);
      const q = String(input.portail ?? "").toLowerCase();
      const list = await prisma.integration.findMany({ where: { provider: "PORTAIL", ...(c ? { companyId: c.id } : {}) } });
      const integ = list.find((x) => x.label?.toLowerCase() === q) ?? (list.filter((x) => x.label?.toLowerCase().includes(q)).length === 1 ? list.find((x) => x.label?.toLowerCase().includes(q)) : undefined);
      if (!integ) throw new Error(`Portail « ${input.portail} » non connecté${c ? ` pour ${c.name}` : ""}. Portails : ${list.map((x) => x.label).join(", ") || "aucun (à ajouter dans Connexions → Portail pro)"}`);
      if (portalBusy.has(integ.id)) throw new Error("Ce portail est déjà en cours de consultation : réessaie dans une minute.");
      const { decryptJson, encryptJson } = await import("@/lib/crypto");
      const cr = decryptJson<{ url?: string; login?: string; password?: string; storageState?: string }>(integ.credentials);
      if (!cr.url || (!cr.storageState && !cr.password)) throw new Error(`${integ.label} : pas encore connecté (Connexions → « se connecter moi-même »).`);
      const { withSite, consultSite } = await import("@/lib/connectors/web-operator");
      const acc = { site: `portail-${integ.id}`, startUrl: cr.url, username: cr.login ?? "", password: cr.password ?? "", storageState: cr.storageState };
      portalBusy.add(integ.id);
      try {
        const { value, storageState } = await withSite(acc, (page) => consultSite(page, acc, String(input.question).slice(0, 1500)));
        if (storageState) await prisma.integration.update({ where: { id: integ.id }, data: { credentials: encryptJson({ ...cr, storageState }), status: "OK", lastError: null, lastSyncAt: new Date() } });
        return { portail: integ.label, ...value };
      } catch (e) {
        await prisma.integration.update({ where: { id: integ.id }, data: { status: "ERROR", lastError: (e as Error).message.slice(0, 400) } });
        throw e;
      } finally {
        portalBusy.delete(integ.id);
      }
    }
    case "boites_mail": {
      const c = await scopeCompany(agent, soc);
      const list = await prisma.integration.findMany({ where: { provider: { in: ["GOOGLE", "OUTLOOK", "IMAP"] }, ...(c ? { companyId: c.id } : {}) }, include: { company: { select: { name: true } } } });
      return list.map((x) => ({ boite: x.label, type: x.provider === "GOOGLE" ? "Gmail (API)" : x.provider === "OUTLOOK" ? "Outlook" : "IMAP (recherche : from:, subject:, depuis:N, non-lus, texte)", societe: x.company.name, etat: x.status }));
    }
    case "mails_rechercher": {
      const m = await mailFor(agent, soc, boite);
      if (m.provider === "IMAP") return imapSearch(m.id, String(input.recherche ?? "").replace(/in:inbox|newer_than:(\d+)d/g, (x, n) => (n ? `depuis:${n}` : "")), Number(input.max) || 30);
      return m.provider === "OUTLOOK" ? outlookSearch(m.id, String(input.recherche ?? ""), Number(input.max) || 30) : gmailSearch(m.id, String(input.recherche || "in:inbox newer_than:3d"), Number(input.max) || 30);
    }
    case "mail_lire": {
      const m = await mailFor(agent, soc, boite);
      if (m.provider === "IMAP") return imapRead(m.id, String(input.id));
      return m.provider === "OUTLOOK" ? outlookRead(m.id, String(input.id)) : gmailRead(m.id, String(input.id));
    }
    case "mail_enregistrer_facture": {
      if (!isSecretariat(agent) && !ATELIER_WRITERS.includes(agent.slug)) throw new Error("Réservé aux secrétariats et au courrier.");
      const m = await mailFor(agent, soc, boite);
      // Boîte du fondateur (Start Invest) : la facture peut être pour une autre société du groupe.
      let target = m.company;
      if (input.pour_societe) {
        const all = await prisma.company.findMany({ where: { active: true } });
        const q = String(input.pour_societe).toLowerCase();
        const found = all.find((x) => x.name.toLowerCase() === q) ?? (all.filter((x) => x.name.toLowerCase().includes(q)).length === 1 ? all.find((x) => x.name.toLowerCase().includes(q)) : undefined);
        if (!found) throw new Error(`Société « ${input.pour_societe} » introuvable ou ambiguë.`);
        if (found.id !== m.company.id && m.company.name !== "Start Invest") throw new Error(`Cette boîte appartient à ${m.company.name} : pas de facture pour une autre société.`);
        target = found;
      }
      const files = (m.provider === "IMAP" ? await imapAttachments(m.id, String(input.id)) : m.provider === "OUTLOOK" ? await outlookAttachments(m.id, String(input.id)) : await gmailAttachments(m.id, String(input.id))).filter((f) => /pdf|image\/(jpe?g|png|webp)/i.test(f.mime) || /\.(pdf|jpe?g|png|webp)$/i.test(f.name));
      if (!files.length) throw new Error("Aucune pièce jointe PDF ou photo dans cet e-mail.");
      const { saveDocument, processDocument } = await import("@/lib/documents");
      const out = [];
      for (const f of files.slice(0, 5)) {
        const name = /\.(pdf|jpe?g|png|webp)$/i.test(f.name) ? f.name : `${f.name}.pdf`;
        const { doc, duplicate } = await saveDocument(new File([new Uint8Array(f.content)], name.slice(0, 150), { type: f.mime }), { companyId: target.id, type: "FACTURE_FOURNISSEUR", uploadedBy: `${agent.slug} (${m.label})` });
        if (duplicate) {
          out.push({ fichier: f.name, resultat: "déjà enregistrée" });
          continue;
        }
        await processDocument(doc.id);
        const d = await prisma.document.findUnique({ where: { id: doc.id } });
        out.push({ fichier: f.name, resultat: d?.status === "ERROR" ? `erreur : ${d.error}` : d?.summary });
      }
      return { societe: target.name, factures: out };
    }
    case "drive_lister":
      return driveList(await googleFor(agent, soc, boite), { dossier: input.dossier as string | undefined, recherche: input.recherche as string | undefined });
    case "mail_ranger": {
      if (!isSecretariat(agent)) throw new Error("Réservé aux agents Secrétariat.");
      const m = await mailFor(agent, soc, boite);
      if (m.provider === "IMAP") return imapOrganize(m.id, String(input.id), { dossier: (input.libelle as string | undefined) ?? (input.archiver ? "Traité" : undefined), marquerLu: Boolean(input.marquer_lu), important: Boolean(input.important) });
      if (m.provider === "OUTLOOK") return outlookOrganize(m.id, String(input.id), { dossier: (input.libelle as string | undefined) ?? (input.archiver ? "Traité" : undefined), marquerLu: Boolean(input.marquer_lu), important: Boolean(input.important) });
      return gmailOrganize(m.id, String(input.id), { libelle: input.libelle as string | undefined, archiver: Boolean(input.archiver), marquerLu: Boolean(input.marquer_lu), important: Boolean(input.important) });
    }
    case "drive_creer_dossier":
      if (!isSecretariat(agent)) throw new Error("Réservé aux agents Secrétariat.");
      return driveCreateFolder(await googleFor(agent, soc, boite), String(input.nom), input.parent as string | undefined);
    case "drive_deplacer":
      if (!isSecretariat(agent)) throw new Error("Réservé aux agents Secrétariat.");
      return driveMove(await googleFor(agent, soc, boite), String(input.fichier), { versDossier: input.vers_dossier as string | undefined, nouveauNom: input.nouveau_nom as string | undefined });
  }
  throw new Error(`Outil inconnu : ${name}`);
}
