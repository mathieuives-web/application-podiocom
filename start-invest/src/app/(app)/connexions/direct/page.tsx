import Link from "next/link";
import { requireAdmin } from "@/lib/session";
import LiveBrowser from "./LiveBrowser";
import { cancelDirect, finishDirect } from "../actions";

export const dynamic = "force-dynamic";

export default async function DirectPage({ searchParams }: { searchParams: Promise<{ sid?: string; nom?: string }> }) {
  await requireAdmin();
  const { sid, nom } = await searchParams;
  if (!sid) return <p className="card">Lancez la connexion depuis <Link href="/connexions" className="underline">Connexions</Link>.</p>;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Connexion à {nom ?? "votre logiciel"}</h1>
        <p className="text-sm text-slate-500">
          Connectez-vous normalement : cliquez dans l&apos;écran, tapez votre identifiant, votre mot de passe et le code reçu par SMS si
          on vous le demande. Quand vous êtes sur votre tableau de bord, cliquez <strong>« Je suis connecté »</strong> : la session est
          gardée chiffrée et le robot s&apos;en servira chaque jour. Ce que vous tapez n&apos;est ni enregistré ni montré à l&apos;IA.
        </p>
      </div>
      <LiveBrowser sid={sid} />
      <div className="flex gap-2">
        <form action={finishDirect.bind(null, sid)}><button className="btn-primary" style={{ background: "#047857" }}>Je suis connecté</button></form>
        <form action={cancelDirect.bind(null, sid)}><button className="btn-secondary">Annuler</button></form>
      </div>
    </div>
  );
}
