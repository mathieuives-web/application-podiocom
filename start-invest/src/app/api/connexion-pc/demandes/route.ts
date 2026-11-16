import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { pendingFor } from "@/lib/phone-approval";

// Téléphone (connecté) : demandes de connexion en attente pour ce compte.
export async function GET() {
  const uid = ((await auth())?.user as { id?: string } | undefined)?.id;
  if (!uid) return NextResponse.json([], { status: 401 });
  return NextResponse.json(await pendingFor(uid), { headers: { "Cache-Control": "no-store" } });
}
