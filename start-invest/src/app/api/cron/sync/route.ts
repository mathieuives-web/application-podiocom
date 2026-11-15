import { NextResponse } from "next/server";
import { syncAll } from "@/lib/connectors";

// Synchronisation automatique de toutes les connexions (banques, facturation).
// Appelez cette URL depuis un planificateur (cron Railway, cron-job.org, crontab...) avec
// l'en-tête "Authorization: Bearer <CRON_SECRET>", par exemple toutes les heures.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }
  return NextResponse.json({ results: await syncAll() });
}
