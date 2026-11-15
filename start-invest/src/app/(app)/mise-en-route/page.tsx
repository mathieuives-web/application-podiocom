import Link from "next/link";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { agentsConfigured } from "@/lib/agent-runtime";
import { shineConfigured } from "@/lib/connectors/shine";
import { smtpConfigured } from "@/lib/reminders";
import { loadAgents } from "@/lib/agents";

export const dynamic = "force-dynamic";

type Check = { ok: boolean | "warn"; label: string; help?: React.ReactNode };

function Row({ c }: { c: Check }) {
  const icon = c.ok === true ? "✅" : c.ok === "warn" ? "⚠️" : "❌";
  return (
    <li className="flex gap-3 py-2 border-b border-slate-100 last:border-0">
      <span className="shrink-0">{icon}</span>
      <div className="text-sm">
        <p className={c.ok === true ? "text-slate-700" : "font-medium text-slate-900"}>{c.label}</p>
        {c.ok !== true && c.help && <p className="text-xs text-slate-500 mt-0.5">{c.help}</p>}
      </div>
    </li>
  );
}

export default async function MiseEnRoutePage() {
  const me = await requireUser();
  const [user, companies, agents, lastControl] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: me.id } }),
    prisma.company.findMany({
      where: { active: true },
      include: { integrations: true, bankAccounts: true, statements: true, documents: true, _count: { select: { invoices: true } } },
      orderBy: { name: "asc" },
    }),
    loadAgents(),
    prisma.dailyControl.findFirst({ orderBy: { startedAt: "desc" } }),
  ]);
  const defaultPassword = await bcrypt.compare("startinvest2026", user.passwordHash);
  const secret = process.env.AUTH_SECRET ?? "";
  const url = process.env.NEXTAUTH_URL ?? "";
  const hour = Number(process.env.DAILY_CONTROL_HOUR ?? 7);

  const security: Check[] = [
    { ok: user.totpEnabled, label: "Double authentification activée sur votre compte", help: <Link href="/acces" className="underline">Activer dans Accès</Link> },
    { ok: !defaultPassword, label: "Mot de passe personnel (le mot de passe de départ a été changé)", help: <Link href="/acces" className="underline">Changer dans Accès</Link> },
    { ok: secret.length >= 32 && !/remplacer|placeholder|dev-/.test(secret), label: "Clé secrète du serveur (AUTH_SECRET) longue et unique", help: "Générez-la avec : openssl rand -base64 32 — puis ne la changez plus (elle chiffre les accès bancaires et les documents)." },
    { ok: url.startsWith("https://"), label: "Site servi en HTTPS (NEXTAUTH_URL en https://)", help: "Indispensable : sans HTTPS, mots de passe et données circulent en clair." },
    { ok: process.env.REQUIRE_2FA !== "off", label: "Double authentification obligatoire pour les actions sensibles", help: "Retirez REQUIRE_2FA=off des variables." },
    { ok: process.env.NODE_ENV === "production" ? (process.env.DATA_DIR ? true : "warn") : "warn", label: "Données sur un volume persistant et sauvegardé (DATA_DIR)", help: "Sur Railway : Volume monté sur /app/data. Sauvegardez ce dossier chaque jour (base + documents chiffrés)." },
  ];
  const services: Check[] = [
    { ok: agentsConfigured(), label: "Agents IA activés (ANTHROPIC_API_KEY)", help: "Clé à créer sur console.anthropic.com, avec une limite de dépense mensuelle." },
    { ok: shineConfigured(), label: "Accès Shine Connect configuré (SHINE_CLIENT_ID / SHINE_CLIENT_SECRET)", help: "Adresse de retour à déclarer chez Shine : " + (url ? `${url.replace(/\/$/, "")}/api/shine/callback` : "https://votre-domaine/api/shine/callback") },
    { ok: smtpConfigured() ? true : "warn", label: "Envoi des relances par e-mail (SMTP)", help: "Sans SMTP, les relances sont préparées en brouillon. Si Shine Facture relance déjà vos clients, ce n'est pas bloquant." },
    { ok: process.env.SCHEDULER !== "off", label: `Contrôle automatique chaque matin à ${hour} h (heure de Paris)`, help: "Retirez SCHEDULER=off, ou appelez /api/cron/daily depuis un planificateur." },
    {
      ok: lastControl?.status === "DONE" ? true : "warn",
      label: lastControl ? `Dernier contrôle quotidien : ${lastControl.startedAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })} (${lastControl.status === "DONE" ? "OK" : lastControl.status})` : "Aucun contrôle quotidien encore lancé",
      help: <Link href="/finances" className="underline">Lancer un premier contrôle maintenant (Finances)</Link>,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Mise en route</h1>
        <p className="text-sm text-slate-500">Tout ce qui doit être branché pour que les agents travaillent seuls dès demain matin.</p>
      </div>

      <section className="grid lg:grid-cols-2 gap-4">
        <div className="card"><h2 className="font-semibold mb-1">Sécurité</h2><ul>{security.map((c) => <Row key={c.label} c={c} />)}</ul></div>
        <div className="card"><h2 className="font-semibold mb-1">Services</h2><ul>{services.map((c) => <Row key={c.label} c={c} />)}</ul></div>
      </section>

      <section className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {companies.map((c) => {
          const daf = agents.find((a) => a.slug.startsWith("daf-") && a.structure === c.name);
          const bank = c.integrations.find((i) => ["SHINE", "QONTO"].includes(i.provider));
          const invoicing = c.integrations.find((i) => ["SHINE", "PENNYLANE"].includes(i.provider)) || c._count.invoices > 0;
          const years = c.statements.map((s) => s.year).sort();
          const releves = c.documents.filter((d) => d.type === "RELEVE" && d.status === "DONE").length;
          const holding = !daf;
          const checks: Check[] = [
            ...(daf ? [{ ok: true, label: `Directeur financier : ${daf.title}` } as Check] : []),
            {
              ok: bank ? (bank.status === "OK" ? true : "warn") : c.bankAccounts.length ? "warn" : false,
              label: bank ? `Banque connectée (${bank.provider === "SHINE" ? "Shine" : bank.provider})${bank.status !== "OK" ? " — " + (bank.lastError ?? "en attente") : ""}` : c.bankAccounts.length ? "Compte saisi à la main (pas de synchro automatique)" : "Banque non connectée",
              help: <Link href="/connexions" className="underline">Connexions → Se connecter avec Shine</Link>,
            },
            {
              ok: invoicing ? true : holding ? "warn" : false,
              label: invoicing ? "Factures reliées (Shine Facture, Pennylane ou import)" : "Factures non reliées",
              help: <Link href="/connexions" className="underline">Shine Facture via Connexions, ou export CSV dans Archives</Link>,
            },
            { ok: years.length >= 2 ? true : years.length === 1 ? "warn" : false, label: years.length ? `Bilans archivés : ${years.join(", ")}` : "Aucun bilan archivé", help: <Link href="/archives" className="underline">Déposer les bilans (3 dernières années idéalement)</Link> },
            { ok: releves > 0 ? true : "warn", label: releves ? `${releves} relevé(s) bancaire(s) d'historique importé(s)` : "Pas d'historique de relevés", help: <Link href="/archives" className="underline">Déposer les relevés des 12 derniers mois</Link> },
            { ok: c.autoReminders ? true : "warn", label: c.autoReminders ? "Relances automatiques activées" : "Relances automatiques désactivées", help: <Link href="/finances" className="underline">Activer dans Finances (inutile si Shine relance déjà)</Link> },
          ];
          const ready = checks.every((x) => x.ok !== false);
          return (
            <div key={c.id} className={`card ${ready ? "" : "border-amber-300"}`}>
              <h2 className="font-semibold"><span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: c.color }} />{c.name}</h2>
              <p className={`text-xs mb-1 ${ready ? "text-emerald-700" : "text-amber-700"}`}>{ready ? "Prête" : "À compléter"}</p>
              <ul>{checks.map((x) => <Row key={x.label} c={x} />)}</ul>
            </div>
          );
        })}
      </section>
    </div>
  );
}
