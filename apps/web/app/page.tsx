import { ApiStatus } from "./api-status";

const FEATURES = [
  {
    title: "Каталог как в kino.pub — только чище",
    text: "Фильтры по типу, жанрам, странам, году, актёрам и режиссёрам. Cursor-пагинация, мгновенный поиск.",
  },
  {
    title: "Плеер — главная фича",
    text: "HLS-лестница качеств, переключение аудиодорожек, субтитры со сдвигом, резюме с любого устройства.",
  },
  {
    title: "Сериалы и подписки",
    text: "Сезоны и эпизоды, подписка на новые серии, отметки просмотренного, продолжение просмотра.",
  },
  {
    title: "Закрытый клуб",
    text: "Регистрация по инвайтам, JWT-сессии с ротацией, профили внутри аккаунта.",
  },
];

export default function HomePage() {
  return (
    <main className="container">
      <section className="hero">
        <h1>
          Зал<span>.</span>
        </h1>
        <p>
          Кино для своих: каталог, плеер и всё остальное — быстрее, красивее и
          удобнее, чем где-либо. Фаза 1 готова: API, схема данных и авторизация
          уже работают.
        </p>
        <p style={{ marginTop: "1.5rem" }}>
          <ApiStatus />
        </p>
      </section>

      <section className="grid">
        {FEATURES.map((f) => (
          <article key={f.title} className="card">
            <h3>{f.title}</h3>
            <p>{f.text}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
