import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { isAdmin } from "@/lib/session";

const LINKS = [
  { href: "/mise-en-route", label: "Mise en route" },
  { href: "/agents", label: "Board d'agents IA" },
  { href: "/finances", label: "Finances" },
  { href: "/comptabilite", label: "Comptabilité" },
  { href: "/vehicules", label: "Véhicules" },
  { href: "/equipe", label: "Équipe & commissions", admin: true },
  { href: "/terrain", label: "Terrain (WhatsApp)" },
  { href: "/projets", label: "Projets", admin: true },
  { href: "/archives", label: "Archives" },
  { href: "/connexions", label: "Connexions", admin: true },
  { href: "/acces", label: "Accès" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const role = (session.user as { role?: string }).role;
  const links = LINKS.filter((l) => !l.admin || isAdmin(role));

  return (
    <div className="flex flex-col md:flex-row min-h-screen">
      <aside className="md:w-60 shrink-0 bg-stone-950 text-stone-100 flex flex-col">
        <div className="px-5 py-3 md:py-5 border-b border-stone-800 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" width={40} height={40} />
          <div>
            <p className="font-bold text-lg leading-tight">Start Invest</p>
            <p className="text-xs text-stone-400">Pilotage du groupe</p>
          </div>
        </div>
        <nav className="flex-1 flex md:block overflow-x-auto whitespace-nowrap py-2 md:py-4 md:space-y-1 px-3">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="block rounded-md px-3 py-2 text-sm text-stone-200 hover:bg-stone-800 hover:text-white">
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="px-4 py-2 md:py-4 border-t border-stone-800 text-xs text-stone-400 flex md:block items-center justify-between gap-3">
          <p className="text-stone-200 font-medium">{session.user.name}</p>
          <p>{isAdmin(role) ? "Fondateur" : "Membre"}</p>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <button className="md:mt-3 text-stone-400 hover:text-white underline" type="submit">Déconnexion</button>
          </form>
        </div>
      </aside>
      <main className="flex-1 min-w-0 bg-slate-50">
        <div className="max-w-6xl mx-auto p-4 md:p-6">{children}</div>
      </main>
    </div>
  );
}
