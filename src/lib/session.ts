import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isStaff } from "@/lib/roles";

export type SessionUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  role: string;
};

export async function requireUser(): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return session.user as unknown as SessionUser;
}

export async function requireStaff(): Promise<SessionUser> {
  const user = await requireUser();
  if (!isStaff(user.role)) redirect("/mes-missions");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") redirect("/");
  return user;
}
