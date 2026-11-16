import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resetWithRecoveryCode } from "@/lib/recovery";

export const dynamic = "force-dynamic";

export default async function OubliPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  async function check(formData: FormData) {
    "use server";
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const token = await resetWithRecoveryCode(String(formData.get("email") ?? ""), String(formData.get("code") ?? ""), ip);
    if (!token) redirect("/login/oubli?error=1");
    redirect(`/login/nouveau?token=${token}`);
  }
  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ background: "#f7f2ea" }}>
      <div className="w-full max-w-sm space-y-4">
        <form action={check} className="card space-y-4">
          <h1 className="text-lg font-bold">Mot de passe oublié</h1>
          <p className="text-sm text-slate-600">Entrez votre adresse et l&apos;un de vos <strong>codes de secours</strong> (liste gardée en photo ou sur papier). Chaque code ne sert qu&apos;une fois.</p>
          <div><label className="label" htmlFor="email">Adresse</label><input className="input" id="email" name="email" type="email" required autoCapitalize="none" autoCorrect="off" /></div>
          <div><label className="label" htmlFor="code">Code de secours</label><input className="input tracking-widest uppercase" id="code" name="code" required placeholder="ABCDE-12345" autoCapitalize="characters" autoComplete="off" /></div>
          {error && <p className="text-sm text-red-600">Adresse ou code de secours incorrect (après 5 essais : 15 minutes d&apos;attente).</p>}
          <button className="btn-primary w-full" style={{ background: "#7f1d1d" }}>Choisir un nouveau mot de passe</button>
        </form>
        <div className="card text-xs text-slate-600 space-y-1">
          <p><strong>Pas de code de secours ?</strong> Le responsable technique de l&apos;application peut créer depuis le serveur un lien de réinitialisation à usage unique (valable 30 minutes) : vous choisissez alors vous-même le nouveau mot de passe.</p>
          <p>Une fois reconnecté, créez vos codes de secours dans <strong>Accès</strong> et activez Face ID.</p>
        </div>
        <Link href="/login" className="block text-center text-xs underline text-slate-500">Retour à la connexion</Link>
      </div>
    </div>
  );
}
