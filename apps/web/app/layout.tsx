import type { Metadata } from "next";
import "./globals.css";
import { Header } from "@/components/header";
import { AuthProvider } from "@/lib/auth";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  // OG/канонические URL должны быть абсолютными: без metadataBase Next
  // ругается warning'ом, а относительные поля остаются относительными.
  metadataBase: new URL(SITE_URL),
  title: "Зал — кино для своих",
  description: "Закрытый стриминг-клуб: кино, сериалы, концерты.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Зал",
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
        <AuthProvider>
          <Header />
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
