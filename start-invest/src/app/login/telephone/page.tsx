import Link from "next/link";
import { cookies, headers } from "next/headers";
import { approveRequestWithRecoveryCode } from "@/lib/recovery";
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { LR_COOKIE, requestState } from "@/lib/phone-approval";
import WaitForPhone from "./WaitForPhone";

export const dynamic = "force-dynamic";

/** Ordinateur : en attente de la validation sur le téléphone. */
export default async function TelephonePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code: codeError } = await searchParams;
  const raw = (await cookies()).get(LR_COOKIE)?.value ?? "";
  const [id, secret] = raw.split(".");
  const state = id && secret ? await requestState(id, secret) : null;
  if (!state) redirect("/login");

  async function finish() {
    "use server";
    try {
      await signIn("approval", { request: id, redirectTo: "/" });
    } catch (error) {
      if (error instanceof AuthError) redirect("/login?error=telephone");
      throw error;
    }
  }

  async function withRecovery(formData: FormData) {
    "use server";
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const ok = await approveRequestWithRecoveryCode(id, String(formData.get("recovery") ?? ""), ip);
    if (!ok) redirect("/login/telephone?code=faux");
    try {
      await signIn("approval", { request: id, redirectTo: "/" });
    } catch (error) {
      if (error instanceof AuthError) redirect("/login?error=telephone");
      throw error;
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ background: "#f7f2ea" }}>
      <div className="w-full max-w-sm card text-center space-y-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icons/icon-192.png" alt="" width={56} height={56} className="mx-auto rounded-xl" />
        <h1 className="text-lg font-bold">Validez sur un autre appareil</h1>
        <p className="text-sm text-slate-600">
          Ouvrez Start Invest sur un appareil où vous êtes <strong>déjà connecté</strong> (ordinateur ou téléphone) : un bandeau vous demande
          d&apos;approuver cette connexion (Face ID, empreinte ou Windows Hello). Vérifiez que le code est le même :
        </p>
        <p className="text-5xl font-bold tracking-widest">{state.code}</p>
        <WaitForPhone action={finish} />
        <details className="text-left text-sm border-t pt-3" open={Boolean(codeError)}>
          <summary className="cursor-pointer text-center underline">Pas d&apos;autre appareil ? Utilisez un code de secours</summary>
          <form action={withRecovery} className="space-y-2 mt-2">
            <input name="recovery" required placeholder="ABCDE-12345" autoComplete="off" autoCapitalize="characters" className="input tracking-widest uppercase w-full" />
            {codeError && <p className="text-xs text-red-600">Code incorrect ou déjà utilisé.</p>}
            <button className="btn-primary w-full" style={{ background: "#7f1d1d" }}>Valider avec le code de secours</button>
            <p className="text-xs text-slate-500">Chaque code ne sert qu&apos;une fois. Une fois connecté, activez Face ID sur cet appareil (Accès).</p>
          </form>
        </details>
        <Link href="/login" className="text-xs underline text-slate-500">Annuler</Link>
      </div>
    </div>
  );
}
