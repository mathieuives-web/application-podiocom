import { NextResponse } from "next/server";
import { after } from "next/server";
import { runDailyControl } from "@/lib/daily-control";

// Lance le contrôle quotidien (si un planificateur externe est préféré au planificateur intégré).
// En-tête requis : "Authorization: Bearer <CRON_SECRET>". Ajoutez ?force=1 pour le relancer le même jour.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }
  const force = new URL(req.url).searchParams.get("force") === "1";
  after(() => runDailyControl({ force }).then(() => undefined));
  return NextResponse.json({ started: true });
}
