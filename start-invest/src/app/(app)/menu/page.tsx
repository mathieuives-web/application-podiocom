import Link from "next/link";
import { signOut } from "@/auth";
import { isAdmin, requireUser } from "@/lib/session";
import { LINKS } from "../nav";

export const dynamic = "force-dynamic";

/** Menu complet sur téléphone. */
export default async function MenuPage() {
  const me = await requireUser();
  const links = LINKS.filter((l) => !l.admin || isAdmin(me.role));
  return (
    <div className="space-y-4 max-w-xl">
      <h1 className="text-xl font-bold">Menu</h1>
      <ul className="rounded-xl bg-white border divide-y">
        {links.map((l) => (
          <li key={l.href}><Link href={l.href} className="flex justify-between px-4 py-3 text-sm">{l.label}<span className="text-slate-400">›</span></Link></li>
        ))}
      </ul>
      <p className="text-xs text-slate-500">Connecté : {me.name ?? me.email} · {isAdmin(me.role) ? "Fondateur" : "Membre"}</p>
      <form action={async () => { "use server"; await signOut({ redirectTo: "/login" }); }}>
        <button className="btn-secondary w-full">Déconnexion</button>
      </form>
    </div>
  );
}
