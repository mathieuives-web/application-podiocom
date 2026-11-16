import Link from "next/link";
import { cookies } from "next/headers";
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { LR_COOKIE, requestState } from "@/lib/phone-approval";
import WaitForPhone from "./WaitForPhone";

export const dynamic = "force-dynamic";

/** Ordinateur : en attente de la validation sur le téléphone. */
export default async function TelephonePage() {
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

  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ background: "#f7f2ea" }}>
      <div className="w-full max-w-sm card text-center space-y-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icons/icon-192.png" alt="" width={56} height={56} className="mx-auto rounded-xl" />
        <h1 className="text-lg font-bold">Validez sur votre téléphone</h1>
        <p className="text-sm text-slate-600">Ouvrez l&apos;appli Start Invest sur votre téléphone : un bandeau vous demande d&apos;approuver cette connexion avec Face ID. Vérifiez que le code est le même :</p>
        <p className="text-5xl font-bold tracking-widest">{state.code}</p>
        <WaitForPhone action={finish} />
        <Link href="/login" className="text-xs underline text-slate-500">Annuler</Link>
      </div>
    </div>
  );
}
