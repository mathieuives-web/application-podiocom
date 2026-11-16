import type { NextAuthConfig } from "next-auth";

export const authConfig = {
  pages: {
    signIn: "/login",
  },
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 }, // reconnexion obligatoire toutes les 8 heures
  callbacks: {
    authorized({ auth, request }) {
      const isLoggedIn = !!auth?.user;
      const isOnLogin = request.nextUrl.pathname.startsWith("/login");
      // La page de connexion décide elle-même (elle vérifie aussi que la session n'a pas été révoquée).
      if (isOnLogin) return true;
      return isLoggedIn;
    },
    jwt({ token, user }) {
      if (user) {
        token.role = (user as { role?: string }).role;
        token.id = (user as { id?: string }).id;
        token.sid = crypto.randomUUID(); // identifiant de CETTE session (révocable à la déconnexion)
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        (session.user as typeof session.user & { role?: string; id?: string }).role =
          token.role as string;
        (session.user as typeof session.user & { role?: string; id?: string }).id =
          token.id as string;
      }
      return session;
    },
  },
  providers: [],
} satisfies NextAuthConfig;
