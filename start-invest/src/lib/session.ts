import { redirect } from "next/navigation";
import { auth } from "@/auth";

export type SessionUser = { id: string; name?: string | null; email?: string | null; role: string };

export async function requireUser(): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return session.user as unknown as SessionUser;
}

/** Actions sensibles (connexions bancaires, accès, convocation des agents) : fondateur uniquement. */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") redirect("/agents");
  return user;
}

export const isAdmin = (role?: string | null) => role === "ADMIN";
