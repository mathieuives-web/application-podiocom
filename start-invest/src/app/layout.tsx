import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Start Invest",
  description: "Pilotage du groupe Start Invest : board d'agents IA, finances et connexions",
  icons: { icon: "/logo.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-slate-50 text-slate-900">{children}</body>
    </html>
  );
}
