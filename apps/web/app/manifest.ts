import type { MetadataRoute } from "next";

/** PWA-манифест: установка на домашний экран, тема «kino.pap». */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "kino.pap — кино, за которое не надо платить",
    short_name: "kino.pap",
    description: "Стриминг без подписок и карт: кино, сериалы, аниме.",
    lang: "ru",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0b0f",
    theme_color: "#0b0b0f",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
