import { prisma } from "@/lib/prisma";
import { loadAgents } from "@/lib/agents";
import { agentsConfigured, executeAgent } from "@/lib/agent-runtime";
import { syncAll } from "@/lib/connectors";
import { autoReconcile } from "@/lib/finance";
import { runReminders } from "@/lib/reminders";

// Contrôle quotidien : synchronise banques et facturation, rapproche, envoie les relances,
// fait travailler le DAF de chaque société, puis le CFO contrôle tous les rapports.

export function parisDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(date); // AAAA-MM-JJ
}

export async function runDailyControl(opts: { force?: boolean } = {}) {
  const day = parisDay();
  const existing = await prisma.dailyControl.findUnique({ where: { day } });
  if (existing && !opts.force) return existing;
  if (existing?.status === "RUNNING") return existing;
  const control = existing
    ? await prisma.dailyControl.update({ where: { id: existing.id }, data: { status: "RUNNING", startedAt: new Date(), finishedAt: null, log: null } })
    : await prisma.dailyControl.create({ data: { day } });

  const log: string[] = [];
  try {
    await import("@/lib/projects").then((m) => m.ensureDefaultProjects()).catch(() => undefined);
    const sync = await syncAll();
    log.push(`Synchro : ${sync.filter((s) => s.ok).length}/${sync.length} connexion(s) OK`);
    for (const s of sync.filter((x) => !x.ok)) log.push(`  ⚠ ${s.error}`);
    log.push(`Rapprochement : ${await autoReconcile()} opération(s) reliée(s) à une facture`);
    if (agentsConfigured()) {
      const { aiCategorize } = await import("@/lib/categorization");
      const cat = await aiCategorize().catch((e) => ({ learned: 0, applied: 0, error: (e as Error).message }));
      log.push(`Classement comptable : ${cat.learned} nouveau(x) libellé(s), ${cat.applied} opération(s) classée(s)`);
    }
    const { computeCommissions, previousMonth } = await import("@/lib/team");
    const com = await computeCommissions();
    log.push(`Commissions : ${com.computed} calculée(s), ${com.changed} mise(s) à jour`);
    if (day.endsWith("-01") && agentsConfigured()) {
      const m = previousMonth();
      const agents = await loadAgents();
      const withStaff = await prisma.company.findMany({ where: { active: true, employees: { some: { active: true } } } });
      for (const c of withStaff) {
        const boss = agents.find((a) => a.slug.startsWith("directeur-ventes-") && a.structure === c.name) ?? agents.find((a) => a.slug.startsWith("dg-") && a.structure === c.name);
        if (!boss) continue;
        await executeAgent({
          slug: boss.slug,
          kind: "COMMISSIONS",
          companyId: c.id,
          task: `Relevé des commissions de ${m} pour ${c.name} (outil commissions_du_mois avec mois="${m}" et societe="${c.name}"). Le fondateur doit pouvoir payer sans recontrôler : suis exactement ta procédure du 1er du mois.`,
        }).then(() => log.push(`Relevé des commissions ${m} (${c.name}) : fait`)).catch((e) => log.push(`  ⚠ Relevé des commissions ${c.name} : ${(e as Error).message}`));
      }
    }
    const rem = await runReminders();
    log.push(`Relances : ${rem.created} créée(s), ${rem.sent} envoyée(s) par e-mail`);

    if (!agentsConfigured()) {
      log.push("Agents IA non activés (ANTHROPIC_API_KEY manquante) : pas de rapport des DAF.");
    } else {
      const agents = await loadAgents();
      const companies = await prisma.company.findMany({ where: { active: true } });
      const date = new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "full" });
      const reports: string[] = [];
      for (const c of companies) {
        const daf = agents.find((a) => a.slug.startsWith("daf-") && a.structure === c.name);
        if (!daf) continue;
        try {
          const r = await executeAgent({
            slug: daf.slug,
            kind: "DAILY",
            companyId: c.id,
            task: `Contrôle quotidien du ${date} pour ${c.name}. COMMENCE par resultats_societe (societe="${c.name}") et mets en tête de ton rapport, avec les chiffres exacts de l'outil : ce que la société a gagné cette année et en moyenne par mois, le solde des comptes, puis selon l'activité le nombre de véhicules vendus ce mois et cette année avec la marge, le nombre et le montant des factures clients du mois et de l'année, les loyers encaissés ; et la liste de ce qui manque (ne l'estime jamais). Ensuite rédige ton rapport du jour en suivant exactement ta procédure (verdict en première ligne). Ensuite, mets à jour ta mémoire avec ce que tu as appris aujourd'hui.`,
          });
          reports.push(`### ${daf.title} (${c.name})\n${r.output}`);
        } catch (e) {
          reports.push(`### ${daf.title} (${c.name})\n⚠ Rapport impossible : ${(e as Error).message}`);
        }
      }
      log.push(`Rapports DAF : ${reports.length}`);

      // Secrétariat : tri des e-mails, du Drive et des messages WhatsApp, pour chaque société connectée.
      const connected = await prisma.integration.findMany({ where: { provider: { in: ["GOOGLE", "OUTLOOK", "IMAP", "WHATSAPP"] }, status: { not: "ERROR" } }, select: { companyId: true } });
      for (const c of companies.filter((x) => connected.some((i) => i.companyId === x.id))) {
        // Courrier atelier (Auto Rac'Ives) en plus du secrétariat quand la société en a un.
        for (const courrier of agents.filter((a) => a.slug.startsWith("courrier-") && a.structure === c.name)) {
          await executeAgent({ slug: courrier.slug, kind: "DAILY", companyId: c.id, task: `Courrier du ${date} pour ${c.name} : suis exactement ta procédure du matin, puis fais ton rapport.` })
            .then((r) => reports.push(`### ${courrier.title} (${c.name})\n${r.output}`))
            .catch((e) => log.push(`  ⚠ ${courrier.title} ${c.name} : ${(e as Error).message}`));
        }
        const sec = agents.find((a) => a.slug.startsWith("secretariat-") && a.structure === c.name);
        if (!sec) continue;
        try {
          const r = await executeAgent({ slug: sec.slug, kind: "DAILY", companyId: c.id, task: `Tri du ${date} pour ${c.name} : suis exactement ta procédure du matin, puis fais ton rapport.` });
          reports.push(`### ${sec.title} (${c.name})\n${r.output}`);
        } catch (e) {
          log.push(`  ⚠ Secrétariat ${c.name} : ${(e as Error).message}`);
        }
      }
      // Projets : chaque jour, chaque chef de projet travaille pour le premier euro ; le lundi, point du Directeur des projets.
      {
        const { ensureDefaultProjects } = await import("@/lib/projects");
        await ensureDefaultProjects();
        const { projectAgentSlug } = await import("@/lib/agents");
        const projects = await prisma.project.findMany({ where: { active: true } });
        for (const p of projects) {
          await executeAgent({ slug: projectAgentSlug(p), kind: "DAILY", task: projectMission(p, date) })
            .then(() => log.push(`Projet ${p.name} : fait`))
            .catch((e) => log.push(`  ⚠ Projet ${p.name} : ${(e as Error).message}`));
        }
        if (new Date().toLocaleDateString("en-US", { timeZone: "Europe/Paris", weekday: "long" }) === "Monday") {
          await executeAgent({ slug: "directeur-projets", kind: "WEEKLY", task: `Point des projets du lundi ${date} : suis exactement ta procédure du lundi.` })
            .then(() => log.push("Point des projets : fait"))
            .catch((e) => log.push(`  ⚠ Point des projets : ${(e as Error).message}`));
        }
      }
      // Chef d'atelier : planning, suivi WhatsApp et rentabilité des mécaniciens, chaque matin.
      for (const c of companies) {
        const chef = agents.find((a) => a.slug.startsWith("planning-atelier-") && a.structure === c.name);
        if (!chef) continue;
        await executeAgent({ slug: chef.slug, kind: "DAILY", companyId: c.id, task: `Matin du ${date} à l'atelier ${c.name} : suis exactement ta procédure du matin${new Date().toLocaleDateString("en-US", { timeZone: "Europe/Paris", weekday: "long" }) === "Monday" ? ", plus le bilan du lundi" : ""}.` })
          .then((r) => reports.push(`### ${chef.title} (${c.name})\n${r.output}`))
          .catch((e) => log.push(`  ⚠ ${chef.title} ${c.name} : ${(e as Error).message}`));
      }
      // Site & réseaux : TOUS LES JOURS (référencement, avis, publication du jour) ; audit complet le lundi.
      const monday = new Date().toLocaleDateString("en-US", { timeZone: "Europe/Paris", weekday: "long" }) === "Monday";
      for (const c of companies.filter((x) => x.website || x.instagram || x.facebook || x.tiktok || x.googleBusiness || x.linkedin)) {
        const web = agents.find((a) => a.slug.startsWith("web-reseaux-") && a.structure === c.name);
        if (!web) continue;
        const task = monday
          ? `Revue hebdomadaire du ${date} pour ${c.name} : audit complet du site et de la présence en ligne, plan d'action classé par impact, et calendrier des publications de la semaine prêtes à copier-coller.`
          : `Routine du ${date} pour ${c.name} (objectif : être premier sur Google et Google Maps pour chaque recherche locale) : 1) vérifie avec web_search la position sur les 5 recherches clés de ta mémoire et note tout changement ; 2) nouveaux avis Google à répondre (propose la réponse) ; 3) UNE action de référencement du jour, prête à appliquer (texte exact et où le mettre) ; 4) la publication du jour (Instagram / Facebook / TikTok) prête à copier-coller. Mets à jour ta mémoire avec les positions et ce qui est fait.`;
        await executeAgent({ slug: web.slug, kind: monday ? "WEEKLY" : "DAILY", companyId: c.id, task })
          .then((r) => reports.push(`### ${web.title} (${c.name})\n${r.output}`))
          .catch((e) => log.push(`  ⚠ Site & réseaux ${c.name} : ${(e as Error).message}`));
      }

      if (reports.length) {
        const cfo = await executeAgent({
          slug: "cfo",
          kind: "DAILY",
          task: `Revue quotidienne du ${date}. Appelle d'abord resultats_societe sans société (tout le groupe) et commence ta revue par un tableau : société / gagné cette année / par mois / solde / indicateur clé (véhicules vendus, factures atelier, loyers). Voici les rapports de tes directeurs financiers. Contrôle-les (vérifie leurs chiffres avec tes outils), donne le verdict du groupe, dis ce que chaque DAF a raté ou doit corriger, et fais remonter au fondateur les 3 sujets qui demandent une décision.\n\n${reports.join("\n\n")}`,
        });
        log.push("Revue du CFO : faite");
        // Contre-contrôle : l'avocat du diable vérifie tous les rapports et corrige les agents qui se trompent.
        if (agents.some((a) => a.slug === "avocat-du-diable")) {
          await executeAgent({
            slug: "avocat-du-diable",
            kind: "DAILY",
            task: `Contre-contrôle du ${date}. Vérifie avec tes outils chaque chiffre et chaque conclusion des rapports ci-dessous, corrige les agents qui se trompent (corriger_agent) et fais ton rapport au fondateur.\n\n${reports.join("\n\n")}\n\n### Revue du CFO\n${cfo.output}`.slice(0, 150000),
          })
            .then(() => log.push("Contre-contrôle de l'avocat du diable : fait"))
            .catch((e) => log.push(`  ⚠ Avocat du diable : ${(e as Error).message}`));
        }
      }
    }
    return prisma.dailyControl.update({ where: { id: control.id }, data: { status: "DONE", log: log.join("\n"), finishedAt: new Date() } });
  } catch (e) {
    log.push(`Erreur : ${(e as Error).message}`);
    return prisma.dailyControl.update({ where: { id: control.id }, data: { status: "ERROR", log: log.join("\n"), finishedAt: new Date() } });
  }
}

/**
 * Analyse complète d'une société par son directeur financier : tout l'historique disponible
 * (bilans, relevés, factures), puis mémorisation de ce qu'il faut retenir. Lancée automatiquement
 * après un dépôt de documents, ou à la demande.
 */
export async function runFullAnalysis(companyId: string, userId?: string | null) {
  if (!agentsConfigured()) return null;
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  const agents = await loadAgents();
  const daf = agents.find((a) => a.slug.startsWith("daf-") && a.structure === company.name) ?? agents.find((a) => a.slug === "cfo");
  if (!daf) return null;
  const running = await prisma.agentRun.findFirst({
    where: { agent: daf.slug, kind: "ANALYSIS", status: "RUNNING", startedAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
  });
  if (running) return running;
  return executeAgent({
    slug: daf.slug,
    kind: "ANALYSIS",
    companyId,
    userId,
    task: `ANALYSE COMPLÈTE de ${company.name} (société=\"${company.name}\") à partir de tout l'historique disponible.
0. Commence par resultats_societe : ce sont les chiffres de référence (gagné, ventes de véhicules, factures, loyers, ce qui manque). Ne contredis pas ces chiffres sans le prouver par une opération ou un document précis.
1. Utilise lister_documents, lire_bilans, flux_mensuels (60 mois), lister_factures et lister_transactions pour tout lire.
2. Rédige un diagnostic complet : évolution du CA, des marges et du résultat année par année ; saisonnalité mois par mois ;
   structure des charges et postes qui dérivent ; trésorerie et endettement ; clients et délais de paiement ; risques ;
   ce que la société fait bien ; les 5 leviers les plus rentables pour gagner plus d'argent, chiffrés.
3. Indique précisément quelles données manquent (années de bilans, mois de relevés) pour une analyse parfaite.
4. Termine en mettant à jour ta mémoire avec l'essentiel à retenir pour tes contrôles quotidiens (repères chiffrés,
   saisonnalité, seuils d'alerte, points à surveiller).`,
  });
}

/**
 * Contre-contrôle à la demande : l'avocat du diable reprend tous les rapports des agents des dernières
 * 24 heures, vérifie chaque chiffre avec ses outils et corrige les agents qui se sont trompés.
 */
export async function runDevilsAdvocate(userId?: string | null) {
  if (!agentsConfigured()) throw new Error("Agents IA non activés (ANTHROPIC_API_KEY manquante).");
  const runs = await prisma.agentRun.findMany({
    where: { status: "DONE", parentId: null, agent: { not: "avocat-du-diable" }, startedAt: { gte: new Date(Date.now() - 36 * 3600 * 1000) }, output: { not: null } },
    orderBy: { startedAt: "asc" },
    take: 40,
  });
  const agents = await loadAgents();
  const title = (slug: string) => agents.find((a) => a.slug === slug)?.title ?? slug;
  const reports = runs.map((r) => `### ${title(r.agent)} (${r.agent}) — ${r.kind}, ${r.startedAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}\n${r.output}`);
  const date = new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "full" });
  return executeAgent({
    slug: "avocat-du-diable",
    kind: "MANUAL",
    userId,
    task: `Contre-contrôle complet demandé par le fondateur le ${date}.
${reports.length ? "Voici tous les rapports des agents des dernières 36 heures." : "Aucun rapport récent : contrôle directement les chiffres de chaque société avec tes outils."}
Vérifie chaque chiffre et chaque conclusion avec tes outils, contrôle aussi toi-même les points sensibles de chaque société
(trésorerie, séquestre dépôt-vente, découvert Auxiga, résultat de l'année, commissions à verser, factures en retard),
corrige les agents qui se trompent avec corriger_agent, puis fais ton rapport au fondateur.

${reports.join("\n\n")}`.slice(0, 150000),
  });
}

/**
 * Remise à plat complète d'une société : reclassement de toutes ses opérations avec son métier,
 * relecture des logiciels (Auto Cerfa, GTA Pro), puis analyse complète par son directeur financier.
 */
export async function redoCompany(companyId: string, userId?: string | null) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  console.log(`[remise à plat] ${company.name} : début`);
  const { reclassifyCompany } = await import("@/lib/categorization");
  const cls = await reclassifyCompany(companyId).catch((e) => ({ erreur: (e as Error).message }));
  const { syncIntegration } = await import("@/lib/connectors");
  const robots = await prisma.integration.findMany({ where: { companyId, provider: { in: ["AUTOCERFA", "GTAPRO"] } } });
  for (const r of robots) await syncIntegration(r.id, { force: true }).catch((e) => console.log(`[remise à plat] ${r.provider} : ${(e as Error).message}`));
  const { relinkStaff } = await import("@/lib/vehicles");
  await relinkStaff(companyId).catch(() => undefined);
  await prisma.appSetting.upsert({
    where: { key: `remise-a-plat:${companyId}` },
    update: { value: JSON.stringify({ at: new Date().toISOString(), classement: cls }) },
    create: { key: `remise-a-plat:${companyId}`, value: JSON.stringify({ at: new Date().toISOString(), classement: cls }) },
  });
  console.log(`[remise à plat] ${company.name} : classement ${JSON.stringify(cls)}, analyse complète lancée`);
  return runFullAnalysis(companyId, userId);
}

/** Mission du jour d'un chef de projet : rapprocher le projet de son premier euro, avec des actions réelles. */
export function projectMission(p: { name: string; website: string | null; status: string }, date: string) {
  const cibles: Record<string, string> = {
    "Vente Auto Sécurité":
      "garages, négociants VO, agents et petits concessionnaires automobiles, en commençant par l'Ille-et-Vilaine (Montreuil-sur-Ille, Rennes, Saint-Aubin-d'Aubigné, Betton, Saint-Malo, Fougères, Vitré), puis la Bretagne. Offre : les 10 premiers garages paient 49 € HT/mois à vie (PV de livraison avec preuves, dossier anti-litige, aide en cas de réclamation).",
    CLEAN: "professionnels du nettoyage indépendants et petites entreprises (prestataires) et gîtes / locations Airbnb (clients), en Ille-et-Vilaine d'abord.",
  };
  const cible = cibles[p.name];
  return `Travail du ${date} sur ${p.name} : ton seul objectif est le PREMIER EURO encaissé, puis le suivant.
1. Bloquant n°1 : lis l'état réel (lire_projet, analyser_site${p.website ? ` sur ${p.website}` : ""}). Si quelque chose empêche d'encaisser (paiement non branché, site hors ligne, faille), écris en tête de ton rapport, en 3 lignes maximum, l'action EXACTE que le fondateur doit faire (où cliquer, quoi copier) — une seule.
${cible && p.website ? `2. Prospection : lister_prospects pour éviter les doublons, puis trouve avec web_search 10 NOUVEAUX prospects réels : ${cible}
   Pour chacun : ajouter_prospect avec la page source, l'e-mail ou le téléphone SEULEMENT s'ils sont écrits sur une page, et un message personnalisé (objet + 6 lignes max, lien ${p.website}). Le fondateur les envoie en un clic.
3. Relances : pour les prospects « contacté » depuis plus de 5 jours, propose une relance courte dans ton rapport.` : "2. Ce projet n'est pas encore vendable : donne la liste ordonnée de ce qui manque pour encaisser, avec qui fait quoi."}
Termine par : prospects ajoutés aujourd'hui, total à contacter, et la prochaine étape vers le premier euro.`;
}
