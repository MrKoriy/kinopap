import type { MetadataRoute } from "next";

// База сайта из env (может задать деплой). В проде NEXT_PUBLIC_API_URL пуст —
// приложение живёт на origin окна (см. lib/api.ts), абсолютного домена нет,
// поэтому без env отдаём относительный путь, как и остальной проект.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "";

/** robots.txt: плеер, профиль, подписки и логин — не для индексации. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/watch", "/profile", "/subscriptions", "/login", "/ops"],
    },
    sitemap: SITE_URL ? `${SITE_URL}/sitemap.xml` : "/sitemap.xml",
  };
}
