import { signIn } from "@/auth";
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;

  async function login(formData: FormData) {
    "use server";
    try {
      await signIn("credentials", {
        email: formData.get("email"),
        password: formData.get("password"),
        code: formData.get("code"),
        redirectTo: "/",
      });
    } catch (error) {
      if (error instanceof AuthError) redirect("/login?error=1");
      throw error;
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ background: "#f7f2ea" }}>
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center flex flex-col items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" width={72} height={72} className="mb-3" />
          <h1 className="text-2xl font-bold text-slate-900">Start Invest</h1>
          <p className="text-sm text-slate-500 mt-1">Pilotage du groupe</p>
        </div>
        <form action={login} className="card space-y-4">
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input className="input" id="email" name="email" type="email" required autoFocus />
          </div>
          <div>
            <label className="label" htmlFor="password">Mot de passe</label>
            <input className="input" id="password" name="password" type="password" required />
          </div>
          <div>
            <label className="label" htmlFor="code">Code de sécurité (application d&apos;authentification)</label>
            <input className="input tracking-widest" id="code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" />
            <p className="text-xs text-slate-400 mt-1">Laissez vide tant que la double authentification n&apos;est pas activée.</p>
          </div>
          {params?.error && (
            <p className="text-sm text-red-600">
              Connexion refusée : identifiants ou code incorrects. Après 5 essais, l&apos;accès est bloqué 15 minutes.
            </p>
          )}
          <button type="submit" className="btn-primary w-full" style={{ background: "#7f1d1d" }}>Se connecter</button>
        </form>
      </div>
    </div>
  );
}
