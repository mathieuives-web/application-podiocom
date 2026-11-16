import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { LR_COOKIE, requestState } from "@/lib/phone-approval";

// Ordinateur (pas encore connecté) : état de SA demande, identifiée par le secret de son cookie.
export async function GET() {
  const [id, secret] = ((await cookies()).get(LR_COOKIE)?.value ?? "").split(".");
  const s = id && secret ? await requestState(id, secret) : null;
  return NextResponse.json({ status: s?.status ?? "EXPIRED" }, { headers: { "Cache-Control": "no-store" } });
}
