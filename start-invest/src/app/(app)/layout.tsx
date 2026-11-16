import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { isAdmin } from "@/lib/session";
import { LINKS } from "./nav";


export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const role = (session.user as { role?: string }).role;
  const links = LINKS.filter((l) => !l.admin || isAdmin(role));

  const tabs = [
    { href: "/aujourdhui", label: "Aujourd'hui", icon: "M3 12l9-8 9 8v8a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z" },
    { href: "/agents", label: "Agents", icon: "M12 12a4 4 0 100-8 4 4 0 000 8zm-8 9a8 8 0 0116 0" },
    { href: "/finances", label: "Finances", icon: "M4 19V9m6 10V5m6 14v-7m4 7H2" },
    isAdmin(role) ? { href: "/atelier", label: "Atelier", icon: "M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" } : { href: "/terrain", label: "Terrain", icon: "M4 6h16v10H8l-4 4z" },
    { href: "/menu", label: "Menu", icon: "M4 6h16M4 12h16M4 18h16" },
  ];

  return (
    <div className="flex flex-col md:flex-row min-h-screen">
      {/* Téléphone : bandeau en haut et onglets en bas, comme une application */}
      <header className="md:hidden sticky top-0 z-30 bg-stone-950 text-white flex items-center gap-2 px-4 pb-2" style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icons/icon-192.png" alt="" width={28} height={28} className="rounded-md" />
        <p className="font-bold">Start Invest</p>
      </header>
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-stone-950 border-t border-stone-800 grid grid-cols-5" style={{ paddingBottom: "env(safe-area-inset-bottom)" }} aria-label="Navigation principale">
        {tabs.map((t) => (
          <Link key={t.href} href={t.href} className="flex flex-col items-center gap-0.5 py-2 text-[11px] text-stone-300 hover:text-white">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={t.icon} /></svg>
            {t.label}
          </Link>
        ))}
      </nav>
      <aside className="hidden md:flex md:w-60 shrink-0 bg-stone-950 text-stone-100 flex-col">
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
      <main className="flex-1 min-w-0 bg-slate-50 pb-20 md:pb-0">
        <div className="max-w-6xl mx-auto p-4 md:p-6">{children}</div>
      </main>
    </div>
  );
}
