import { auth, signIn } from "@/auth";
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import PasskeyLogin from "./PasskeyLogin";
import { createRequest, LR_COOKIE, needsPhoneApproval, passwordCheck } from "@/lib/phone-approval";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  if ((await auth())?.user) redirect("/"); // déjà connecté (session valide, non révoquée)

  async function login(formData: FormData) {
    "use server";
    // Face ID activé : mot de passe vérifié ici, puis validation sur le téléphone (le mot de passe seul ne suffit plus).
    const h = await headers();
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const user = await passwordCheck(String(formData.get("email") ?? ""), String(formData.get("password") ?? ""), ip);
    if (!user) redirect("/login?error=1");
    if (await needsPhoneApproval(user)) {
      const ua = h.get("user-agent") ?? "";
      const device = `${/Windows/.test(ua) ? "PC Windows" : /Macintosh/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone / iPad" : "Ordinateur"}${/Edg\//.test(ua) ? " · Edge" : /Chrome\//.test(ua) ? " · Chrome" : /Firefox\//.test(ua) ? " · Firefox" : /Safari\//.test(ua) ? " · Safari" : ""}`;
      const r = await createRequest(user.id, ip, device);
      (await cookies()).set(LR_COOKIE, `${r.id}.${r.secret}`, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", maxAge: 300, path: "/" });
      redirect("/login/telephone");
    }
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

  async function loginPasskey(formData: FormData) {
    "use server";
    try {
      await signIn("passkey", { response: formData.get("response"), redirectTo: "/" });
    } catch (error) {
      if (error instanceof AuthError) redirect("/login?error=cle");
      throw error;
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ background: "#f7f2ea" }}>
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center flex flex-col items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/icon-192.png" alt="" width={72} height={72} className="mb-3 rounded-2xl" />
          <h1 className="text-2xl font-bold text-slate-900">Start Invest</h1>
          <p className="text-sm text-slate-500 mt-1">Pilotage du groupe</p>
        </div>
        <div className="card space-y-3 mb-4">
          <PasskeyLogin action={loginPasskey} />
          {params?.error === "cle" && <p className="text-sm text-red-600">Face ID non reconnu ici : connectez-vous avec le mot de passe, puis activez Face ID dans Accès.</p>}
          <p className="text-xs text-slate-500 text-center">Un seul geste : visage, empreinte ou code du téléphone. À activer une fois dans Accès.</p>
        </div>
        <details className="card" open={Boolean(params?.error) && params?.error !== "cle"}>
        <summary className="cursor-pointer text-sm font-medium">Se connecter avec le mot de passe</summary>
        <form action={login} className="space-y-4 mt-3">
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input className="input" id="email" name="email" type="email" required autoCapitalize="none" autoCorrect="off" />
          </div>
          <div>
            <label className="label" htmlFor="password">Mot de passe</label>
            <input className="input" id="password" name="password" type="password" required />
          </div>
          <div>
            <label className="label" htmlFor="code">Code de sécurité (application d&apos;authentification)</label>
            <input className="input tracking-widest" id="code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" />
            <p className="text-xs text-slate-400 mt-1">Laissez vide si vous validez avec votre téléphone (Face ID activé).</p>
          </div>
          {params?.error === "telephone" && <p className="text-sm text-red-600">La validation par téléphone n&apos;a pas abouti : recommencez.</p>}
          {params?.error && !["cle", "telephone"].includes(params.error) && (
            <p className="text-sm text-red-600">
              Connexion refusée : identifiants ou code incorrects. Après 5 essais, l&apos;accès est bloqué 15 minutes.
            </p>
          )}
          <button type="submit" className="btn-primary w-full" style={{ background: "#7f1d1d" }}>Se connecter</button>
        </form>
        </details>
      </div>
    </div>
  );
}
