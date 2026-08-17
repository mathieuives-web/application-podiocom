import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { isStaff, ROLE_LABELS } from "@/lib/roles";

const STAFF_LINKS = [
  { href: "/", label: "Tableau de bord" },
  { href: "/parc", label: "Parc" },
  { href: "/planning", label: "Planning" },
  { href: "/partenaires", label: "Partenaires" },
  { href: "/devis", label: "Devis" },
  { href: "/employes", label: "Employés" },
  { href: "/parametres", label: "Paramètres" },
];

const FIELD_LINKS = [{ href: "/mes-missions", label: "Mes missions" }];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const role = (session.user as { role?: string }).role;
  const staff = isStaff(role);
  const links = staff ? STAFF_LINKS : FIELD_LINKS;

  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 bg-slate-900 text-slate-100 flex flex-col">
        <div className="px-5 py-5 border-b border-slate-800 flex items-center gap-3">
          <Image
            src="/podiocom-logo.png"
            alt="Podiocom"
            width={40}
            height={40}
            className="rounded-md bg-white p-1"
          />
          <div>
            <p className="font-bold text-lg leading-tight">Podiocom</p>
            <p className="text-xs text-slate-400">Fleet Manager</p>
          </div>
        </div>
        <nav className="flex-1 py-4 space-y-1 px-3">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="block rounded-md px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 hover:text-white"
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="px-4 py-4 border-t border-slate-800 text-xs text-slate-400">
          <p className="text-slate-200 font-medium">{session.user.name}</p>
          <p>{ROLE_LABELS[(role as keyof typeof ROLE_LABELS) ?? "EMPLOYEE"]}</p>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <button className="mt-3 text-slate-400 hover:text-white underline" type="submit">
              Déconnexion
            </button>
          </form>
        </div>
      </aside>
      <main className="flex-1 min-w-0 bg-slate-50">
        <div className="max-w-6xl mx-auto p-6">{children}</div>
      </main>
    </div>
  );
}
