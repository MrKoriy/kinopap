import type { MetadataRoute } from "next";

/** PWA-манифест: установка на домашний экран, тема «Зал». */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Зал — кино для своих",
    short_name: "Зал",
    description: "Закрытый стриминг-клуб: кино, сериалы, концерты.",
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
