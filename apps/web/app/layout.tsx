import type { Metadata } from "next";
import "./globals.css";
import { Header } from "@/components/header";
import { WebVitals } from "@/components/web-vitals";
import { AuthProvider } from "@/lib/auth";
import "@/lib/env";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  // OG/канонические URL должны быть абсолютными: без metadataBase Next
  // ругается warning'ом, а относительные поля остаются относительными.
  metadataBase: new URL(SITE_URL),
  title: "kino.pap — кино, за которое не надо платить",
  description: "Стриминг без подписок и карт: кино, сериалы, аниме.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "kino.pap",
  },
  icons: {
    // 32×32 под вкладку; 192×192 (app/icon.png) и 180×180 apple
    // (app/apple-icon.png) раздаёт конвенция файлов app/.
    icon: [{ url: "/favicon.png", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru">
      <body>
        <WebVitals />
        <AuthProvider>
          <Header />
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
