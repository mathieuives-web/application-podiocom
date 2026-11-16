import Anthropic from "@anthropic-ai/sdk";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { prisma } from "@/lib/prisma";
import { decryptJson } from "@/lib/crypto";
import { saveDocument } from "@/lib/documents";
import { parseDate } from "@/lib/statement-import";

// WhatsApp Business (API officielle de Meta, « Cloud API ») : un numéro par société.
// Les salariés envoient une photo (ticket, facture, pièce à commander, intervention) ou un message ;
// l'IA le lit, le classe (frais / besoin / intervention), l'archive chiffré et répond « bien reçu ».

const GRAPH = process.env.WHATSAPP_API_URL || "https://graph.facebook.com/v23.0";
export type WhatsAppCreds = { phoneNumberId: string; accessToken: string; appSecret: string };

/** Jeton de vérification à coller dans Meta (dérivé du secret de l'application, jamais stocké). */
export function whatsappVerifyToken() {
  return createHash("sha256").update(`start-invest-whatsapp:${process.env.AUTH_SECRET ?? ""}`).digest("hex").slice(0, 32);
}

export async function whatsappIntegrations() {
  const list = await prisma.integration.findMany({ where: { provider: "WHATSAPP" }, include: { company: true } });
  return list.flatMap((i) => {
    try {
      return [{ integ: i, creds: decryptJson<WhatsAppCreds>(i.credentials) }];
    } catch {
      return [];
    }
  });
}

/** Vérifie la signature Meta (X-Hub-Signature-256) avec le secret d'une des applications enregistrées. */
export function signatureValid(raw: string, header: string | null, secrets: string[]) {
  if (!header?.startsWith("sha256=")) return false;
  const got = Buffer.from(header.slice(7), "hex");
  return secrets.some((s) => {
    const exp = createHmac("sha256", s).update(raw).digest();
    return exp.length === got.length && timingSafeEqual(exp, got);
  });
}

async function graph<T>(path: string, token: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`WhatsApp ${r.status} : ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

async function downloadMedia(mediaId: string, token: string) {
  const meta = await graph<{ url: string; mime_type: string }>(`/${mediaId}`, token);
  const r = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!r.ok) throw new Error(`Téléchargement du média impossible (${r.status})`);
  return { content: Buffer.from(await r.arrayBuffer()), mime: meta.mime_type };
}

export async function sendWhatsApp(creds: WhatsAppCreds, to: string, body: string) {
  await graph(`/${creds.phoneNumberId}/messages`, creds.accessToken, {
    method: "POST",
    body: { messaging_product: "whatsapp", to, type: "text", text: { body: body.slice(0, 4000) } },
  }).catch((e) => console.log(`[whatsapp] réponse impossible : ${(e as Error).message.slice(0, 200)}`));
}

/** Vérifie les accès (bouton Synchroniser) et renvoie le numéro affiché. */
export async function checkWhatsApp(creds: WhatsAppCreds) {
  return graph<{ display_phone_number?: string; verified_name?: string }>(`/${creds.phoneNumberId}?fields=display_phone_number,verified_name`, creds.accessToken);
}

// ------------------------------------------------------------------ lecture par l'IA

const Reading = z.object({
  type: z.enum(["FRAIS", "BESOIN", "INTERVENTION", "AUTRE"]).describe(
    "FRAIS = dépense déjà payée (ticket, facture, plein, péage, achat) ; BESOIN = quelque chose à acheter / commander / réparer ; INTERVENTION = compte rendu d'un travail fait (photo avant/après, réparation, livraison) ; AUTRE"
  ),
  resume: z.string().describe("Résumé en une phrase, en français"),
  montant: z.number().nullable().describe("Montant TTC en euros si visible"),
  fournisseur: z.string().nullable(),
  date: z.string().nullable().describe("AAAA-MM-JJ si visible"),
  vehicule_ou_client: z.string().nullable().describe("Immatriculation, véhicule, client ou chantier concerné si mentionné"),
  duree_minutes: z.number().int().nullable().describe("Temps passé indiqué par le salarié pour l'intervention (ex. « 1h20 » = 80), sinon null"),
  intervention_terminee: z.boolean().describe("true si le salarié dit avoir fini / terminé le véhicule"),
  urgent: z.boolean(),
  reponse: z.string().describe("Réponse courte et chaleureuse au salarié (1 à 2 phrases) confirmant ce qui a été compris, en le tutoyant ; demande l'info manquante essentielle s'il en manque une (ex. pour quel véhicule, ou le temps passé pour une intervention terminée)"),
});

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

async function readMessage(company: string, who: string, text: string | null, media: { content: Buffer; mime: string } | null) {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (media && /^image\/(jpeg|png|gif|webp)$/.test(media.mime)) {
    content.push({ type: "image", source: { type: "base64", media_type: media.mime as "image/jpeg", data: media.content.toString("base64") } });
  } else if (media?.mime === "application/pdf") {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: media.content.toString("base64") } });
  }
  content.push({
    type: "text",
    text: `Message WhatsApp reçu par ${company} de la part de ${who}.${text ? `\nTexte : « ${text.slice(0, 2000)} »` : ""}${media && !content.length ? "\n(pièce jointe non lisible)" : ""}
Classe-le et extrais les informations utiles pour la comptabilité et la gestion. N'invente aucun chiffre.`,
  });
  const stream = anthropic().beta.messages.stream({
    model: "claude-opus-5-5",
    max_tokens: 3000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { format: betaZodOutputFormat(Reading) },
    messages: [{ role: "user", content }],
  });
  const msg = await stream.finalMessage();
  return Reading.parse(JSON.parse(msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("")));
}

type WaMessage = {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
};
type WaPayload = {
  entry?: { changes?: { value?: { metadata?: { phone_number_id?: string }; contacts?: { wa_id: string; profile?: { name?: string } }[]; messages?: WaMessage[] } }[] }[];
};

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").replace(/^00/, "").replace(/^0(\d{9})$/, "33$1");

/** Traite une notification Meta (appelé en arrière-plan après avoir répondu 200 à Meta). */
export async function handleWebhook(payload: WaPayload) {
  const integrations = await whatsappIntegrations();
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      const target = integrations.find((x) => x.creds.phoneNumberId === v?.metadata?.phone_number_id);
      if (!v?.messages?.length || !target) continue;
      const { integ, creds } = target;
      for (const m of v.messages) {
        const name = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? null;
        const emps = await prisma.employee.findMany({ where: { companyId: integ.companyId, phone: { not: null } } });
        const employee = emps.find((e) => digits(e.phone) === digits(m.from)) ?? null;
        // Meta renvoie parfois la même notification deux fois, parfois en même temps : on « réserve » le message d'abord.
        const row = await prisma.fieldRequest
          .create({ data: { companyId: integ.companyId, employeeId: employee?.id ?? null, fromPhone: m.from, fromName: employee ? `${employee.firstName} ${employee.lastName}`.trim() : name, messageId: m.id, summary: "Lecture en cours…" } })
          .catch(() => null);
        if (!row) continue;
        const who = employee ? `${employee.firstName} (${employee.role ?? "salarié"})` : name ? `${name} (numéro ${m.from}, salarié non enregistré)` : `le numéro ${m.from}`;
        const text = m.text?.body ?? m.image?.caption ?? m.document?.caption ?? null;
        let media: { content: Buffer; mime: string } | null = null;
        let documentId: string | null = null;
        try {
          const mediaRef = m.image ?? m.document;
          if (mediaRef) {
            media = await downloadMedia(mediaRef.id, creds.accessToken);
            const ext = media.mime === "application/pdf" ? "pdf" : media.mime.split("/")[1]?.replace("jpeg", "jpg") ?? "bin";
            const file = new File([new Uint8Array(media.content)], `whatsapp-${new Date().toISOString().slice(0, 10)}-${(employee?.firstName ?? m.from).replace(/\W+/g, "")}.${ext}`, { type: media.mime });
            const saved = await saveDocument(file, { companyId: integ.companyId, type: "TERRAIN", uploadedBy: `WhatsApp ${m.from}` });
            documentId = saved.doc.id;
          }
          if (!text && !media) {
            await prisma.fieldRequest.update({ where: { id: row.id }, data: { summary: "Message vocal ou non lisible", status: "TRAITE" } });
            await sendWhatsApp(creds, m.from, "Je lis les photos, les PDF et les messages écrits. Pour un message vocal, écris-moi en quelques mots s'il te plaît 🙏");
            continue;
          }
          const r = await readMessage(integ.company.name, who, text, media);
          await prisma.fieldRequest.update({
            where: { id: row.id },
            data: {
              kind: r.type,
              text,
              documentId,
              amount: r.montant,
              merchant: r.fournisseur,
              spentAt: r.date ? parseDate(r.date) : null,
              vehicle: r.vehicule_ou_client,
              minutes: r.duree_minutes,
              summary: r.resume,
              urgent: r.urgent,
            },
          });
          if (documentId) await prisma.document.update({ where: { id: documentId }, data: { status: "DONE", summary: `${r.type} — ${r.resume}` } });
          // Atelier : « fini + immatriculation » -> le rendez-vous du jour de ce mécanicien passe à TERMINÉ.
          if (employee && r.type === "INTERVENTION" && r.intervention_terminee && r.vehicule_ou_client) {
            const plate = r.vehicule_ou_client.toUpperCase().match(/[A-Z]{2}-?\d{3}-?[A-Z]{2}/)?.[0]?.replace(/-/g, "");
            if (plate) {
              const since = new Date(Date.now() - 2 * 86400000);
              const rdv = (await prisma.appointment.findMany({ where: { companyId: integ.companyId, employeeId: employee.id, start: { gte: since }, status: { in: ["PREVU", "CONFIRME", "EN_COURS"] } } })).find((a) => (a.vehicle ?? "").toUpperCase().replace(/[\s-]/g, "").includes(plate));
              if (rdv) await prisma.appointment.update({ where: { id: rdv.id }, data: { status: "TERMINE", notes: [rdv.notes, `Terminé (WhatsApp ${employee.firstName}${r.duree_minutes ? `, ${r.duree_minutes} min` : ""})`].filter(Boolean).join(" · ").slice(0, 500) } });
            }
          }
          await sendWhatsApp(creds, m.from, r.reponse);
          console.log(`[whatsapp] ${integ.company.name} : ${r.type}${r.montant ? ` ${r.montant} €` : ""} de ${employee?.firstName ?? m.from}`);
        } catch (e) {
          console.log(`[whatsapp] ${integ.company.name} ÉCHEC : ${(e as Error).message.slice(0, 300)}`);
          await prisma.fieldRequest
            .update({ where: { id: row.id }, data: { text, documentId, summary: `⚠ Lecture automatique impossible : ${(e as Error).message.slice(0, 200)}` } })
            .catch(() => undefined);
          await sendWhatsApp(creds, m.from, "Bien reçu 👍 Je n'ai pas réussi à tout lire automatiquement, ce sera vérifié à la main.");
        }
      }
    }
  }
}
