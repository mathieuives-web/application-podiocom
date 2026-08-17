import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Podiocom Fleet",
  description: "Gestion de parc - Podiocom",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-slate-50 text-slate-900">{children}</body>
    </html>
  );
}
