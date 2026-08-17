
import { signIn } from "@/auth";
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;

  async function login(formData: FormData) {
    "use server";
    try {
      await signIn("credentials", {
        email: formData.get("email"),
        password: formData.get("password"),
        redirectTo: "/",
      });
    } catch (error) {
      if (error instanceof AuthError) {
        redirect("/login?error=1");
      }
      throw error;
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center flex flex-col items-center">
          <Image
            src="/podiocom-logo.png"
            alt="Podiocom"
            width={96}
            height={96}
            className="mb-3"
            priority
          />
          <h1 className="text-2xl font-bold text-slate-900">Podiocom Fleet</h1>
          <p className="text-sm text-slate-500 mt-1">Gestion de parc &amp; planning</p>
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
          {params?.error && (
            <p className="text-sm text-red-600">Identifiants incorrects. Réessayez.</p>
          )}
          <button type="submit" className="btn-primary w-full">Se connecter</button>
        </form>
        <p className="text-xs text-slate-400 text-center mt-6">
          Accès réservé au personnel Podiocom, chauffeurs et locataires autorisés.
        </p>
      </div>
    </div>
  );
}
