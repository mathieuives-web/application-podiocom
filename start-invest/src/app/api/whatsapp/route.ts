import { NextResponse, after } from "next/server";
import { handleWebhook, signatureValid, whatsappIntegrations, whatsappVerifyToken } from "@/lib/connectors/whatsapp";

// Adresse de rappel (webhook) WhatsApp à déclarer dans Meta. Publique, mais :
// - GET : Meta vérifie l'adresse avec le jeton de vérification affiché dans Connexions ;
// - POST : chaque notification doit être signée par Meta avec le secret de l'application (sinon refusée).

export async function GET(req: Request) {
  const u = new URL(req.url);
  if (u.searchParams.get("hub.mode") === "subscribe" && u.searchParams.get("hub.verify_token") === whatsappVerifyToken()) {
    return new NextResponse(u.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return new NextResponse("Refusé", { status: 403 });
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 1_000_000) return new NextResponse("Trop gros", { status: 413 });
  const secrets = (await whatsappIntegrations()).map((x) => x.creds.appSecret).filter(Boolean);
  if (!signatureValid(raw, req.headers.get("x-hub-signature-256"), secrets)) {
    console.log("[whatsapp] notification refusée : signature invalide");
    return new NextResponse("Signature invalide", { status: 401 });
  }
  const payload = JSON.parse(raw);
  // Meta attend une réponse rapide : la lecture des photos se fait ensuite.
  after(() => handleWebhook(payload).catch((e) => console.log(`[whatsapp] erreur : ${(e as Error).message.slice(0, 300)}`)));
  return NextResponse.json({ ok: true });
}
