import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resetTokenValid, setPasswordWithToken } from "@/lib/recovery";

export const dynamic = "force-dynamic";

export default async function NouveauPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const { token = "", error } = await searchParams;
  const valid = token ? await resetTokenValid(token) : false;
  async function save(formData: FormData) {
    "use server";
    const p1 = String(formData.get("password") ?? "");
    const p2 = String(formData.get("confirm") ?? "");
    if (p1 !== p2) redirect(`/login/nouveau?token=${encodeURIComponent(token)}&error=${encodeURIComponent("Les deux mots de passe sont différents.")}`);
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const r = await setPasswordWithToken(token, p1, ip);
    if (!r.ok) redirect(`/login/nouveau?token=${encodeURIComponent(token)}&error=${encodeURIComponent(r.error ?? "Erreur")}`);
    redirect("/login?reset=1");
  }
  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ background: "#f7f2ea" }}>
      <div className="w-full max-w-sm space-y-4">
        {valid ? (
          <form action={save} className="card space-y-4">
            <h1 className="text-lg font-bold">Nouveau mot de passe</h1>
            <p className="text-sm text-slate-600">12 caractères minimum. Astuce : une phrase facile à retenir (ex. « Pizza-Mustang-2026-Montreuil »).</p>
            <div><label className="label" htmlFor="password">Nouveau mot de passe</label><input className="input" id="password" name="password" type="password" minLength={12} required autoComplete="new-password" /></div>
            <div><label className="label" htmlFor="confirm">Encore une fois</label><input className="input" id="confirm" name="confirm" type="password" minLength={12} required autoComplete="new-password" /></div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button className="btn-primary w-full" style={{ background: "#7f1d1d" }}>Enregistrer</button>
          </form>
        ) : (
          <div className="card space-y-2 text-sm">
            <h1 className="text-lg font-bold">Lien expiré ou déjà utilisé</h1>
            <p className="text-slate-600">Un lien de réinitialisation ne sert qu&apos;une fois et dure 30 minutes.</p>
            <Link href="/login/oubli" className="underline">Recommencer</Link>
          </div>
        )}
      </div>
    </div>
  );
}
