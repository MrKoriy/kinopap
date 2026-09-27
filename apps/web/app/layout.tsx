import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { Header } from "@/components/header";

export const metadata: Metadata = {
  title: "Зал — кино для своих",
  description: "Закрытый стриминг-клуб: кино, сериалы, концерты.",
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
