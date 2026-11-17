import { prisma } from "@/lib/prisma";

// Dépense IA : chaque appel est chiffré en euros et compté ; le travail AUTOMATIQUE s'arrête au budget
// (AI_MONTHLY_BUDGET_EUR, 200 € par mois par défaut, réparti par jour). Le fondateur garde toujours la main.

const USD_EUR = 0.93;
// $ par million de jetons : entrée, sortie, lecture du cache, écriture du cache.
const PRICES: Record<string, { in: number; out: number; read: number; write: number }> = {
  "claude-opus-5-5": { in: 4, out: 20, read: 0.2, write: 5 },
  "claude-sonnet-5-5": { in: 2, out: 10, read: 0.1, write: 2.5 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, read: 0.01, write: 0.125 },
};
const WEB_SEARCH_USD = 10 / 1000;

type Usage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
};

export function costEur(model: string, u: Usage | null | undefined) {
  if (!u) return 0;
  const p = PRICES[model] ?? PRICES["claude-opus-5-5"];
  const usd =
    ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out + (u.cache_read_input_tokens ?? 0) * p.read + (u.cache_creation_input_tokens ?? 0) * p.write) / 1e6 +
    (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
  return usd * USD_EUR;
}

const parisDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());

/** Enregistre la dépense d'un appel IA et la renvoie (en euros). */
export async function trackAiSpend(source: string, model: string, usage: Usage | null | undefined) {
  const eur = costEur(model, usage);
  if (eur > 0) await prisma.aiSpend.create({ data: { day: parisDay(), source: source.slice(0, 80), model, costEur: eur } }).catch(() => undefined);
  return eur;
}

export function monthlyBudget() {
  return Number(process.env.AI_MONTHLY_BUDGET_EUR ?? 200);
}

export async function aiSpendStatus() {
  const day = parisDay();
  const month = day.slice(0, 7);
  const [today, thisMonth] = await Promise.all([
    prisma.aiSpend.aggregate({ _sum: { costEur: true }, where: { day } }),
    prisma.aiSpend.aggregate({ _sum: { costEur: true }, where: { day: { startsWith: month } } }),
  ]);
  const budget = monthlyBudget();
  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  return { today: today._sum.costEur ?? 0, month: thisMonth._sum.costEur ?? 0, budget, dailyBudget: budget / daysInMonth };
}

/** Le travail automatique peut-il encore dépenser ? (part du budget du jour réservée : `share`, 1 = tout). */
export async function canSpendAutomatic(share = 1) {
  const s = await aiSpendStatus();
  return s.month < s.budget && s.today < s.dailyBudget * share;
}

const CREDIT_KEY = "ia-credit-epuise";

/** Note qu'une erreur « crédit épuisé » vient d'arriver (n'importe quel appel IA). */
export async function noteCreditError(message: string) {
  if (!/credit balance is too low|purchase credits/i.test(message)) return false;
  await prisma.appSetting.upsert({ where: { key: CREDIT_KEY }, update: { value: String(Date.now()) }, create: { key: CREDIT_KEY, value: String(Date.now()) } });
  return true;
}

/** Crédit IA épuisé il y a moins de `minutes` : inutile de lancer un travail IA automatique. */
export async function creditRecentlyExhausted(minutes = 15) {
  const s = await prisma.appSetting.findUnique({ where: { key: CREDIT_KEY } });
  return Boolean(s && Date.now() - Number(s.value) < minutes * 60 * 1000);
}

export async function clearCreditError() {
  await prisma.appSetting.deleteMany({ where: { key: CREDIT_KEY } });
}
