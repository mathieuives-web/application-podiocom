import { NextResponse } from "next/server";
import { authenticationOptions } from "@/lib/passkeys";

// Défi de connexion par clé d'accès (public : la sécurité est dans la signature de l'appareil).
export async function POST() {
  return NextResponse.json(await authenticationOptions());
}
