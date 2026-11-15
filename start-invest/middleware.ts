import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

export default NextAuth(authConfig).auth;

export const config = {
  matcher: [
    "/((?!api/auth|api/cron|api/health|_next/static|_next/image|logo.svg|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp)$).*)",
  ],
};
