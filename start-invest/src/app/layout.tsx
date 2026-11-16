import type { Metadata, Viewport } from "next";
import "./globals.css";
import RegisterSW from "./RegisterSW";

export const metadata: Metadata = {
  title: "Start Invest",
  description: "Pilotage du groupe Start Invest : board d'agents IA, finances et connexions",
  icons: { icon: [{ url: "/icons/icon.svg", type: "image/svg+xml" }, { url: "/icons/icon-192.png", sizes: "192x192" }], apple: "/icons/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "Start Invest", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#0c0a09",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-slate-50 text-slate-900">
        {children}
        <RegisterSW />
      </body>
    </html>
  );
}
