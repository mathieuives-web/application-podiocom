import { prisma } from "@/lib/prisma";
import type { AgentDef } from "@/lib/agents";
import { employeeAgentSlug } from "@/lib/agents";
import { leaveYear, workingDays } from "@/lib/team";

// Atelier Auto Rac'Ives : rendez-vous, planning des mécaniciens et rentabilité (à partir des données réelles :
// rendez-vous notés, temps déclarés sur WhatsApp, congés et école ; jamais d'estimation).

const DAY = 86400000;
const parisDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(d);
const norm = (x: string) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Date « AAAA-MM-JJ » + « HH:MM » à l'heure de Paris -> Date (gère l'heure d'été). */
export function parisDateTime(day: string, time = "08:00") {
  const [h, m] = time.split(":").map(Number);
  const guess = new Date(`${day}T${String(h || 0).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}:00Z`);
  const off = new Date(guess.toLocaleString("en-US", { timeZone: "Europe/Paris" })).getTime() - new Date(guess.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  return new Date(guess.getTime() - off);
}

export async function atelierCompany() {
  const c = await prisma.company.findFirst({ where: { name: "Auto Rac Ives" } });
  if (!c) throw new Error("Société Auto Rac Ives introuvable.");
  return c;
}

async function mechanics(companyId: string) {
  return prisma.employee.findMany({ where: { companyId, active: true }, include: { leaves: true }, orderBy: { firstName: "asc" } });
}

function findMechanic(list: Awaited<ReturnType<typeof mechanics>>, name?: string | null) {
  if (!name) return null;
  const q = norm(name);
  const m = list.filter((e) => norm(e.firstName) === q || norm(`${e.firstName} ${e.lastName}`) === q);
  if (m.length !== 1) throw new Error(`Mécanicien « ${name} » inconnu. Équipe : ${list.map((e) => e.firstName).join(", ")}`);
  return m[0];
}

function range(input: Record<string, unknown>, defDays: number) {
  const from = input.du ? parisDateTime(String(input.du), "00:00") : parisDateTime(parisDate(new Date()), "00:00");
  const to = input.au ? new Date(parisDateTime(String(input.au), "00:00").getTime() + DAY) : new Date(from.getTime() + defDays * DAY);
  return { from, to };
}

export async function atelierTool(name: string, input: Record<string, unknown>, agent: AgentDef) {
  const c = await atelierCompany();
  const team = await mechanics(c.id);
  // Agent d'un mécanicien : il ne voit que lui.
  const self = agent.slug.startsWith("salarie-") ? team.find((e) => employeeAgentSlug(e) === agent.slug) : null;
  if (agent.slug.startsWith("salarie-") && !self) throw new Error("Réservé aux salariés de l'atelier.");
  const who = self ?? findMechanic(team, input.mecanicien as string | undefined);

  if (name === "lister_rdv") {
    const { from, to } = range(input, 7);
    const rdv = await prisma.appointment.findMany({ where: { companyId: c.id, start: { gte: from, lt: to }, ...(who ? { employeeId: who.id } : {}) }, orderBy: { start: "asc" } });
    const load: Record<string, Record<string, number>> = {};
    for (const r of rdv.filter((x) => !["ANNULE", "ABSENT"].includes(x.status))) {
      const d = parisDate(r.start);
      const m = team.find((e) => e.id === r.employeeId)?.firstName ?? "non affecté";
      load[d] ??= {};
      load[d][m] = (load[d][m] ?? 0) + r.minutes;
    }
    return {
      rendezVous: rdv.map((r) => ({
        id: r.id,
        debut: r.start.toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" }),
        dureeMin: r.minutes,
        client: self ? "(client)" : r.client,
        telephone: self ? undefined : r.phone,
        vehicule: r.vehicle,
        prestation: r.work,
        mecanicien: team.find((e) => e.id === r.employeeId)?.firstName ?? null,
        statut: r.status,
        source: r.source,
        notes: r.notes,
      })),
      chargeParJourEnMinutes: load,
    };
  }

  if (name === "noter_rdv" || name === "modifier_rdv") {
    if (self) throw new Error("Lecture seule pour l'agent d'un salarié.");
    if (name === "noter_rdv") {
      const start = parisDateTime(String(input.date), String(input.heure ?? "08:00"));
      if (Number.isNaN(start.getTime())) throw new Error("Date ou heure invalide.");
      const r = await prisma.appointment.create({
        data: {
          companyId: c.id,
          start,
          minutes: Math.max(10, Math.min(Number(input.duree_minutes) || 60, 12 * 60)),
          client: String(input.client).slice(0, 120),
          phone: (input.telephone as string | undefined)?.slice(0, 40) ?? null,
          vehicle: (input.vehicule as string | undefined)?.slice(0, 120) ?? null,
          work: String(input.prestation).slice(0, 300),
          employeeId: who?.id ?? null,
          source: (input.source as string | undefined)?.slice(0, 60) ?? agent.slug,
          notes: (input.notes as string | undefined)?.slice(0, 500) ?? null,
          createdBy: agent.slug,
        },
      });
      return { ok: true, id: r.id, mecanicien: who?.firstName ?? "non affecté" };
    }
    const r = await prisma.appointment.findFirst({ where: { id: String(input.id), companyId: c.id } });
    if (!r) throw new Error("Rendez-vous introuvable.");
    const start = input.date || input.heure ? parisDateTime(String(input.date ?? parisDate(r.start)), String(input.heure ?? r.start.toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }))) : undefined;
    await prisma.appointment.update({
      where: { id: r.id },
      data: {
        ...(input.statut ? { status: String(input.statut) } : {}),
        ...(input.mecanicien ? { employeeId: who?.id ?? null } : {}),
        ...(start ? { start } : {}),
        ...(input.duree_minutes ? { minutes: Number(input.duree_minutes) } : {}),
        ...(input.notes ? { notes: String(input.notes).slice(0, 500) } : {}),
      },
    });
    return { ok: true };
  }

  // rentabilite_atelier
  const { from, to } = range(input, -1);
  const realFrom = input.du ? from : new Date(Date.now() - 30 * DAY);
  const realTo = input.au ? to : new Date(parisDateTime(parisDate(new Date()), "00:00").getTime() + DAY); // jusqu'à la fin de la journée
  const [rdv, declared] = await Promise.all([
    prisma.appointment.findMany({ where: { companyId: c.id, start: { gte: realFrom, lt: realTo }, status: { notIn: ["ANNULE"] } } }),
    prisma.fieldRequest.findMany({ where: { companyId: c.id, createdAt: { gte: realFrom, lt: realTo }, employeeId: { not: null } } }),
  ]);
  const rows = (who ? [who] : team).map((e) => {
    const days = workingDays(realFrom, new Date(realTo.getTime() - 1));
    const off = e.leaves
      .filter((l) => l.end >= realFrom && l.start < realTo)
      .reduce((n, l) => n + workingDays(l.start < realFrom ? realFrom : l.start, l.end > realTo ? new Date(realTo.getTime() - 1) : l.end), 0);
    const presence = Math.max(0, ((days - off) * e.weeklyHours) / 5);
    const mine = rdv.filter((r) => r.employeeId === e.id);
    const planned = mine.filter((r) => r.status !== "ABSENT").reduce((n, r) => n + r.minutes, 0) / 60;
    const done = mine.filter((r) => r.status === "TERMINE");
    const decl = declared.filter((f) => f.employeeId === e.id);
    const declaredH = decl.reduce((n, f) => n + (f.minutes ?? 0), 0) / 60;
    const pct = (a: number) => (presence ? Math.round((a / presence) * 100) : null);
    return {
      mecanicien: e.firstName,
      poste: e.role,
      heuresPresencePrevues: Math.round(presence * 10) / 10,
      joursAbsence: off,
      heuresPlanifieesEnRdv: Math.round(planned * 10) / 10,
      tauxOccupationPct: pct(planned),
      rdvTermines: done.length,
      rdvAbsents: mine.filter((r) => r.status === "ABSENT").length,
      interventionsDeclareesWhatsApp: decl.filter((f) => f.kind === "INTERVENTION").length,
      heuresDeclarees: Math.round(declaredH * 10) / 10,
      tauxProductiviteDeclareePct: pct(declaredH),
      rythme: e.schedule,
    };
  });
  return {
    periode: { du: parisDate(realFrom), au: parisDate(new Date(realTo.getTime() - 1)) },
    annee_conges: leaveYear().label,
    mecaniciens: rows,
    aCompleter: [
      "Heures VENDUES (facturées) par mécanicien : à lire dans GTA Pro si le mécanicien est renseigné sur les OR ; sans elles, pas de vraie rentabilité en euros.",
      ...(declared.some((f) => f.minutes) ? [] : ["Aucun temps passé déclaré sur WhatsApp : demander aux gars d'envoyer « fini + véhicule + temps » à la fin de chaque intervention."]),
      ...(rdv.length ? [] : ["Aucun rendez-vous noté sur la période : les noter dans la page Atelier ou les faire noter par l'agent."]),
    ],
  };
}
