import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { loadAgents, reachableFrom, type AgentDef } from "@/lib/agents";
import { financeSummary, invoiceStatus, escrowSummary } from "@/lib/finance";
import { shineMcpServersFor, SHINE_READ_TOOLS } from "@/lib/connectors";

// Moteur d'exécution du board : chaque agent tourne sur l'API Claude avec son fichier
// .claude/agents/<slug>.md comme prompt système, des outils en LECTURE SEULE sur les
// données de l'application, et un outil `consulter_agent` pour déléguer à son équipe.

const MODELS: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};
const MAX_DEPTH = 3; // CEO -> CFO -> Rapprochement -> (stop)
const MAX_TURNS = 20;
const DAY = 86400000;

let client: Anthropic | null = null;
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("Clé ANTHROPIC_API_KEY manquante : ajoutez-la dans les variables d'environnement pour convoquer les agents.");
  }
  return (client ??= new Anthropic());
}

export function agentsConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

// ---------------------------------------------------------------- outils de données

async function resolveCompany(societe?: string) {
  if (!societe) return undefined;
  const all = await prisma.company.findMany({ where: { active: true } });
  const q = societe.toLowerCase();
  const c = all.find((x) => x.id === societe) ?? all.find((x) => x.name.toLowerCase().includes(q));
  if (!c) throw new Error(`Société « ${societe} » introuvable. Sociétés : ${all.map((x) => x.name).join(", ") || "aucune"}`);
  return c.id;
}

const round = (n: number) => Math.round(n * 100) / 100;

const DATA_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "lister_societes",
    description: "Liste les sociétés (structures) du groupe avec leur activité et leurs comptes bancaires.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "lire_finances",
    description:
      "Tableau de bord financier réel : trésorerie (soldes bancaires), entrées et sorties d'argent sur la période, dépenses par catégorie, factures clients à encaisser / en retard, factures fournisseurs à payer. Par société ou consolidé groupe.",
    input_schema: {
      type: "object",
      properties: {
        societe: { type: "string", description: "Nom ou id de la société. Vide = tout le groupe." },
        jours: { type: "integer", description: "Période d'analyse en jours (défaut 30)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lister_transactions",
    description: "Opérations bancaires réelles (positif = entrée, négatif = sortie), les plus récentes d'abord.",
    input_schema: {
      type: "object",
      properties: {
        societe: { type: "string" },
        jours: { type: "integer", description: "Défaut 90." },
        sens: { type: "string", enum: ["entrees", "sorties", "toutes"] },
        categorie: { type: "string" },
        limite: { type: "integer", description: "Défaut 100, max 500." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lister_factures",
    description: "Factures clients (CLIENT) ou fournisseurs (SUPPLIER) avec montant, payé, échéance et statut.",
    input_schema: {
      type: "object",
      properties: {
        societe: { type: "string" },
        type: { type: "string", enum: ["CLIENT", "SUPPLIER"] },
        statut: { type: "string", enum: ["EN_RETARD", "A_PAYER", "PAYEE", "TOUTES"] },
        limite: { type: "integer", description: "Défaut 100." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lister_relances",
    description: "Relances clients (automatiques) : facture, client, niveau (1 = J+3, 2 = J+15, 3 = J+30), statut (SENT envoyée, DRAFT à envoyer à la main, ERROR).",
    input_schema: {
      type: "object",
      properties: { societe: { type: "string" }, jours: { type: "integer", description: "Défaut 60." } },
      additionalProperties: false,
    },
  },
  {
    name: "lire_bilans",
    description:
      "Historique financier issu des bilans déposés dans les Archives : par société et par exercice, CA, marge, salaires, EBE, résultat, capitaux propres, trésorerie, dettes, créances, stocks, et les points d'attention relevés. À utiliser pour comparer la situation actuelle au passé.",
    input_schema: { type: "object", properties: { societe: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "lister_documents",
    description: "Documents archivés d'une société (bilans, relevés, exports de factures) avec ce qui en a été extrait. Permet de savoir quel historique est disponible.",
    input_schema: { type: "object", properties: { societe: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "flux_mensuels",
    description:
      "Historique bancaire mois par mois (jusqu'à 60 mois) : entrées, sorties, résultat et principales catégories de dépenses de chaque mois. Idéal pour la saisonnalité, les tendances et comparer avec les années précédentes. Hors virements internes.",
    input_schema: {
      type: "object",
      properties: { societe: { type: "string" }, mois: { type: "integer", description: "Nombre de mois (défaut 36, max 60)." } },
      additionalProperties: false,
    },
  },
  {
    name: "compte_sequestre",
    description:
      "Comptes séquestres (fonds de tiers, ex. dépôt-vente de La Fabrique Automobile) : solde, fonds reçus des acheteurs, reversements, derniers mouvements. Cet argent n'appartient PAS à la société : ne jamais le compter comme trésorerie ou chiffre d'affaires.",
    input_schema: { type: "object", properties: { societe: { type: "string" } }, additionalProperties: false },
  },
];

async function runDataTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "lister_societes":
      return prisma.company.findMany({
        where: { active: true },
        select: { id: true, name: true, activity: true, bankAccounts: { select: { name: true, bank: true, balance: true, provider: true, lastSyncAt: true } } },
      });
    case "lire_finances": {
      const companyId = await resolveCompany(input.societe as string | undefined);
      return financeSummary({ companyId, days: Number(input.jours) || 30 });
    }
    case "lister_transactions": {
      const companyId = await resolveCompany(input.societe as string | undefined);
      const days = Number(input.jours) || 90;
      const sens = input.sens as string | undefined;
      const txs = await prisma.bankTransaction.findMany({
        where: {
          date: { gte: new Date(Date.now() - days * DAY) },
          ...(companyId ? { companyId } : {}),
          ...(sens === "entrees" ? { amount: { gt: 0 } } : sens === "sorties" ? { amount: { lt: 0 } } : {}),
          ...(input.categorie ? { category: String(input.categorie) } : {}),
        },
        include: { company: { select: { name: true } }, account: { select: { name: true, kind: true } }, invoice: { select: { number: true, counterparty: true } } },
        orderBy: { date: "desc" },
        take: Math.min(Number(input.limite) || 100, 500),
      });
      return txs.map((t) => ({
        date: t.date.toISOString().slice(0, 10),
        societe: t.company.name,
        compte: t.account.name,
        type_compte: t.account.kind === "SEQUESTRE" ? "séquestre (fonds de tiers)" : t.account.kind === "PRET" ? "prêt" : "courant",
        libelle: t.label,
        montant: round(t.amount),
        categorie: t.category,
        facture: t.invoice ? `${t.invoice.number ?? ""} ${t.invoice.counterparty}`.trim() : null,
      }));
    }
    case "lister_factures": {
      const companyId = await resolveCompany(input.societe as string | undefined);
      const invs = await prisma.invoice.findMany({
        where: { ...(companyId ? { companyId } : {}), ...(input.type ? { kind: input.type as "CLIENT" | "SUPPLIER" } : {}) },
        include: { company: { select: { name: true } } },
        orderBy: { dueDate: "asc" },
      });
      const statut = (input.statut as string) || "TOUTES";
      return invs
        .map((i) => ({
          societe: i.company.name,
          type: i.kind,
          numero: i.number,
          tiers: i.counterparty,
          emission: i.issueDate.toISOString().slice(0, 10),
          echeance: i.dueDate?.toISOString().slice(0, 10) ?? null,
          montant: round(i.amount),
          reste_du: round(i.amount - i.paidAmount),
          statut: invoiceStatus(i),
          jours_de_retard:
            invoiceStatus(i) === "EN_RETARD" && i.dueDate ? Math.floor((Date.now() - i.dueDate.getTime()) / DAY) : 0,
        }))
        .filter((i) => statut === "TOUTES" || i.statut === statut)
        .slice(0, Math.min(Number(input.limite) || 100, 500));
    }
    case "lire_bilans": {
      const companyId = await resolveCompany(input.societe as string | undefined);
      const rows = await prisma.financialStatement.findMany({
        where: companyId ? { companyId } : {},
        include: { company: { select: { name: true } } },
        orderBy: [{ companyId: "asc" }, { year: "desc" }],
      });
      return rows.map((r) => ({
        societe: r.company.name,
        exercice: r.year,
        chiffre_affaires: r.revenue,
        marge_brute: r.grossMargin,
        salaires_charges: r.payroll,
        ebe: r.ebitda,
        resultat_exploitation: r.operatingIncome,
        resultat_net: r.netIncome,
        capitaux_propres: r.equity,
        total_bilan: r.totalAssets,
        tresorerie: r.cash,
        dettes_financieres: r.debt,
        creances_clients: r.receivables,
        dettes_fournisseurs: r.payables,
        stocks: r.stock,
        points_attention: r.notes,
      }));
    }
    case "lister_documents": {
      const companyId = await resolveCompany(input.societe as string | undefined);
      const docs = await prisma.document.findMany({
        where: companyId ? { companyId } : {},
        include: { company: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      return docs.map((d) => ({ societe: d.company.name, type: d.type, exercice: d.year, fichier: d.fileName, etat: d.status, extrait: d.summary ?? d.error }));
    }
    case "flux_mensuels": {
      const companyId = await resolveCompany(input.societe as string | undefined);
      const months = Math.min(Number(input.mois) || 36, 60);
      const start = new Date();
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      start.setMonth(start.getMonth() - (months - 1));
      const txs = await prisma.bankTransaction.findMany({
        where: { date: { gte: start }, NOT: { category: "Virements internes" }, account: { kind: "COURANT", excluded: false }, ...(companyId ? { companyId } : {}) },
        select: { date: true, amount: true, category: true },
      });
      const byMonth = new Map<string, { entrees: number; sorties: number; cats: Record<string, number> }>();
      for (const t of txs) {
        const k = t.date.toISOString().slice(0, 7);
        const m = byMonth.get(k) ?? { entrees: 0, sorties: 0, cats: {} };
        if (t.amount >= 0) m.entrees += t.amount;
        else {
          m.sorties -= t.amount;
          const c = t.category ?? "Autres dépenses";
          m.cats[c] = (m.cats[c] ?? 0) - t.amount;
        }
        byMonth.set(k, m);
      }
      return [...byMonth.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([mois, m]) => ({
          mois,
          entrees: round(m.entrees),
          sorties: round(m.sorties),
          resultat: round(m.entrees - m.sorties),
          principales_depenses: Object.entries(m.cats)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([c, v]) => `${c} ${round(v)}`),
        }));
    }
    case "compte_sequestre": {
      const companyId = await resolveCompany(input.societe as string | undefined);
      return (await escrowSummary(companyId)).map((e) => ({
        ...e,
        recent: e.recent.map((r) => ({ ...r, date: r.date.toISOString().slice(0, 10), amount: round(r.amount) })),
        largestIn: e.largestIn.map((r) => ({ ...r, date: r.date.toISOString().slice(0, 10), amount: round(r.amount) })),
      }));
    }
    case "lister_relances": {
      const companyId = await resolveCompany(input.societe as string | undefined);
      const rems = await prisma.reminder.findMany({
        where: {
          createdAt: { gte: new Date(Date.now() - (Number(input.jours) || 60) * DAY) },
          ...(companyId ? { invoice: { companyId } } : {}),
        },
        include: { invoice: { include: { company: { select: { name: true } } } } },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      return rems.map((r) => ({
        date: r.createdAt.toISOString().slice(0, 10),
        societe: r.invoice.company.name,
        client: r.invoice.counterparty,
        facture: r.invoice.number,
        reste_du: round(r.invoice.amount - r.invoice.paidAmount),
        niveau: r.level,
        statut: r.status,
        probleme: r.error,
      }));
    }
  }
  throw new Error(`Outil inconnu : ${name}`);
}

// ---------------------------------------------------------------- exécution

function systemPrompt(agent: AgentDef, all: AgentDef[], memory: string | null) {
  const reachable = reachableFrom(agent, all)
    .map((s) => all.find((a) => a.slug === s)!)
    .map((a) => `- \`${a.slug}\` (${a.title}) : ${a.description}`)
    .join("\n");
  const parent = all.find((a) => a.slug === agent.parent);
  return `${agent.prompt}

---
Contexte du board d'agents :
- Tu es « ${agent.title} » (${agent.slug}), structure : ${agent.structure}.${parent ? ` Tu rends compte à ${parent.title}.` : " Tu rends compte directement au fondateur."}
- Les outils lister_societes, lire_finances, lister_transactions, lister_factures, lister_relances, lire_bilans, lister_documents, flux_mensuels et compte_sequestre donnent les données RÉELLES de l'application (lecture seule). Utilise-les avant d'affirmer un chiffre. Si une donnée est absente (banque non connectée, pas de factures), dis-le clairement et indique quoi connecter ou importer.
${reachable ? `- Tu peux déléguer une sous-question précise avec consulter_agent à :\n${reachable}\n- Ne délègue que ce qui apporte vraiment quelque chose : fais toi-même ce qui est simple.` : "- Tu n'as pas d'équipe à consulter : fais le travail toi-même."}
- Réponds en français, de façon concise et actionnable, au format Markdown. Termine par « À faire par le fondateur » si une action humaine est nécessaire.
- Tu as une MÉMOIRE personnelle qui persiste entre tes passages. Quand tu apprends quelque chose de durable et utile
  (tendance, saisonnalité, client qui paie en retard, dépense récurrente, décision du fondateur, anomalie à surveiller),
  mets-la à jour avec l'outil mettre_a_jour_memoire en réécrivant la mémoire complète (synthèse, 6 000 caractères max).

## Ta mémoire actuelle
${memory?.trim() || "(vide : tu n'as encore rien mémorisé)"}`;
}

export async function executeAgent(opts: {
  slug: string;
  task: string;
  userId?: string | null;
  parentRunId?: string | null;
  depth?: number;
  runId?: string;
  kind?: string;
  companyId?: string | null;
}): Promise<{ runId: string; output: string }> {
  const all = await loadAgents();
  const agent = all.find((a) => a.slug === opts.slug);
  if (!agent) throw new Error(`Agent inconnu : ${opts.slug}`);
  const depth = opts.depth ?? 0;

  const run =
    opts.runId
      ? await prisma.agentRun.findUniqueOrThrow({ where: { id: opts.runId } })
      : await prisma.agentRun.create({
          data: {
            agent: agent.slug,
            task: opts.task,
            userId: opts.userId ?? null,
            parentId: opts.parentRunId ?? null,
            kind: opts.kind ?? "MANUAL",
            companyId: opts.companyId ?? null,
          },
        });

  try {
    const reachable = depth < MAX_DEPTH - 1 ? reachableFrom(agent, all) : [];
    const tools: Anthropic.Beta.BetaToolUnion[] = [
      ...DATA_TOOLS,
      {
        name: "mettre_a_jour_memoire",
        description:
          "Réécrit ta mémoire personnelle (ce que tu sais de ta société / de ton périmètre). Donne la version COMPLÈTE et à jour, en puces courtes, 6 000 caractères maximum. Ne mémorise que des faits vérifiés.",
        input_schema: {
          type: "object",
          properties: { contenu: { type: "string" } },
          required: ["contenu"],
          additionalProperties: false,
        },
      },
    ];
    const memory = (await prisma.agentMemory.findUnique({ where: { agent: agent.slug } }))?.content ?? null;

    // Accès direct à Shine (lecture seule) : la société de l'agent, ou tout le groupe pour la direction.
    const companies = await prisma.company.findMany({ where: { active: true }, select: { id: true, name: true } });
    const groupWide = ["ceo", "cfo", "flux-holding"].includes(agent.slug);
    const scope = groupWide ? companies : companies.filter((c) => c.name === agent.structure);
    const shine = scope.length ? await shineMcpServersFor(scope.map((c) => c.id)) : [];
    for (const srv of shine) {
      tools.push({
        type: "mcp_toolset",
        mcp_server_name: srv.name,
        default_config: { enabled: false },
        configs: Object.fromEntries(SHINE_READ_TOOLS.map((t) => [t, { enabled: true }])),
      });
    }
    const shineNote = shine.length
      ? `\n- Tu as un accès DIRECT à Shine (lecture seule) : ${shine.map((x) => `serveur ${x.name} = ${x.company}`).join(" ; ")}. Utilise-le pour les factures clients et fournisseurs, les lignes bancaires et le grand livre à jour.`
      : "";
    if (reachable.length) {
      tools.push({
        name: "consulter_agent",
        description: "Confie une sous-question précise à un agent de ton équipe (ou avec qui tu travailles) et récupère sa réponse.",
        input_schema: {
          type: "object",
          properties: {
            agent: { type: "string", enum: reachable, description: "Slug de l'agent à consulter." },
            demande: { type: "string", description: "Ce que tu attends de lui, avec le contexte nécessaire." },
          },
          required: ["agent", "demande"],
          additionalProperties: false,
        },
      });
    }
    if (agent.tools.some((t) => /websearch|webfetch/i.test(t))) {
      tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
    }

    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: "user", content: `Date du jour : ${new Date().toLocaleDateString("fr-FR")}.\n\n${opts.task}` },
    ];
    let output = "";

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await anthropic().beta.messages.create({
        model: MODELS[agent.model] ?? MODELS.opus,
        max_tokens: 16000,
        system: systemPrompt(agent, all, memory) + shineNote,
        tools,
        messages,
        output_config: { effort: depth === 0 ? "high" : "medium" },
        betas: ["server-side-fallback-2026-07-01", ...(shine.length ? ["mcp-client-2025-11-20" as const] : [])],
        fallbacks: "default",
        ...(shine.length ? { mcp_servers: shine.map((x) => ({ type: "url" as const, name: x.name, url: x.url, authorization_token: x.token })) } : {}),
      });

      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) output = text;

      if (response.stop_reason === "refusal") {
        throw new Error("La demande a été refusée par le modèle. Reformulez-la.");
      }
      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }
      if (response.stop_reason !== "tool_use") break;

      messages.push({ role: "assistant", content: response.content });
      const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      const results = await Promise.all(
        toolUses.map(async (tu): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          const input = (tu.input ?? {}) as Record<string, unknown>;
          try {
            if (tu.name === "mettre_a_jour_memoire") {
              const content = String(input.contenu ?? "").slice(0, 6000);
              if (!content.trim()) throw new Error("Mémoire vide refusée.");
              await prisma.agentMemory.upsert({ where: { agent: agent.slug }, update: { content }, create: { agent: agent.slug, content } });
              return { type: "tool_result", tool_use_id: tu.id, content: "Mémoire mise à jour." };
            }
            if (tu.name === "consulter_agent") {
              const target = String(input.agent);
              if (!reachable.includes(target)) throw new Error(`Tu ne peux pas consulter « ${target} ».`);
              const sub = await executeAgent({
                slug: target,
                task: String(input.demande ?? ""),
                userId: opts.userId,
                parentRunId: run.id,
                depth: depth + 1,
              });
              return { type: "tool_result", tool_use_id: tu.id, content: sub.output || "(pas de réponse)" };
            }
            const data = await runDataTool(tu.name, input);
            return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(data).slice(0, 60000) };
          } catch (e) {
            return { type: "tool_result", tool_use_id: tu.id, content: `Erreur : ${(e as Error).message}`, is_error: true };
          }
        })
      );
      messages.push({ role: "user", content: results });
    }

    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "DONE", output: output || "(aucune réponse)", finishedAt: new Date() },
    });
    console.log(`[agent] ${agent.slug} terminé (${opts.kind ?? "MANUAL"})`);
    return { runId: run.id, output };
  } catch (e) {
    const message = e instanceof Anthropic.APIError ? `Erreur API Claude (${e.status}) : ${e.message}` : (e as Error).message;
    console.log(`[agent] ${agent.slug} ÉCHEC : ${message.slice(0, 400)}`);
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "ERROR", error: message, finishedAt: new Date() } });
    if (depth > 0) return { runId: run.id, output: `L'agent ${agent.title} n'a pas pu répondre : ${message}` };
    throw e;
  }
}
