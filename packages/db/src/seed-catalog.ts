import { eq } from "drizzle-orm";
import { createDb, createPool, type Db } from "./db";
import { genres, itemGenres, items, media } from "./schema/index";

interface MovieSeed {
  title: string;
  originalTitle: string;
  year: number;
  type: "movie" | "serial";
  plot: string;
  rating: number;
  views: number;
  poster: string;
  genre: string;
}

/** Живые метаданные из TMDb: постеры не гниют, описания и рейтинги точные. */
interface TmdbMeta {
  /** id хита: по нему дедупится fill и гидрируются сезоны сериалов. */
  tmdbId: number | null;
  /** Жанры хита в id TMDb; пустой, если ответ их не принёс. */
  genreIds: number[];
  title: string;
  originalTitle: string | null;
  year: number | null;
  plot: string | null;
  rating: number;
  runtimeSeconds: number | null;
  posterSmall: string | null;
  posterMedium: string | null;
  posterBig: string | null;
}

const TMDB_BASE = "https://api.themoviedb.org/3";

async function tmdbMeta(
  seed: MovieSeed,
  key: string | null,
  fetchFn: typeof fetch,
): Promise<TmdbMeta | null> {
  if (!key) return null;
  const url = new URL(
    `${TMDB_BASE}/search/${seed.type === "serial" ? "tv" : "movie"}`,
  );
  url.searchParams.set("api_key", key);
  url.searchParams.set("language", "ru-RU");
  // Оригинальное название ищется точнее локализованного.
  url.searchParams.set("query", seed.originalTitle || seed.title);
  if (seed.type !== "serial") {
    url.searchParams.set("year", String(seed.year));
  }
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const results = data.results ?? [];
    const withYear =
      seed.type === "serial"
        ? results.find((r) => {
            const d = String(r.first_air_date ?? "");
            return d.slice(0, 4) === String(seed.year);
          })
        : undefined;
    const hit = withYear ?? results[0];
    if (!hit) return null;

    const date = String(hit.release_date ?? hit.first_air_date ?? "");
    const year = date.length >= 4 ? parseInt(date.slice(0, 4), 10) : null;
    const runtimeRaw =
      seed.type === "movie"
        ? hit.runtime
        : Array.isArray(hit.episode_run_time)
          ? hit.episode_run_time[0]
          : null;
    const posterPath = hit.poster_path ? String(hit.poster_path) : null;

    return {
      tmdbId: typeof hit.id === "number" ? hit.id : null,
      genreIds: Array.isArray(hit.genre_ids)
        ? hit.genre_ids.filter((g): g is number => typeof g === "number")
        : [],
      title: seed.title,
      originalTitle: hit.original_title ?? hit.original_name
        ? String(hit.original_title ?? hit.original_name)
        : null,
      year: year && year > 1900 ? year : seed.year,
      plot: hit.overview ? String(hit.overview) : seed.plot,
      rating:
        typeof hit.vote_average === "number" && hit.vote_average > 0
          ? Math.round(hit.vote_average * 10) / 10
          : seed.rating,
      runtimeSeconds:
        typeof runtimeRaw === "number" && runtimeRaw > 0 ? runtimeRaw * 60 : null,
      posterSmall: posterPath ? `https://image.tmdb.org/t/p/w185${posterPath}` : seed.poster,
      posterMedium: posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : seed.poster,
      posterBig: posterPath ? `https://image.tmdb.org/t/p/original${posterPath}` : seed.poster,
    };
  } catch {
    return null;
  }
}

/**
 * Названия жанров TMDb (ru) → локальные названия. Копия GENRE_ALIASES из
 * packages/ingest/src/catalog-fill.ts: @zal/db не может импортировать
 * @zal/ingest (ingest сам зависит от db), а рассинхрон этих таблиц ломает
 * маппинг жанров у сида. Меняются — синхронизируются здесь.
 */
const GENRE_ALIASES: Record<string, string> = {
  Боевик: "Боевик",
  Приключения: "Приключения",
  Анимация: "Мультфильм",
  Комедия: "Комедия",
  Преступление: "Криминал",
  Документальный: "Документальный",
  Драма: "Драма",
  Семья: "Семейный",
  Фэнтези: "Фэнтези",
  История: "Исторический",
  Ужасы: "Ужасы",
  Музыка: "Мюзикл",
  Детектив: "Детектив",
  Романтика: "Мелодрама",
  Фантастика: "Фантастика",
  Триллер: "Триллер",
  Война: "Военный",
  Вестерн: "Вестерн",
  Аниме: "Аниме",
  Телешоу: "ТВ-шоу",
  "Научная фантастика": "Фантастика",
};

/**
 * Карта TMDb genre id → локальный id: /genre/{movie,tv}/list отдают названия
 * (ru), те прогоняются через GENRE_ALIASES против локальных жанров — тот же
 * механизм, что в fillCatalog (packages/ingest/src/catalog-fill.ts). Строится
 * один раз на прогон; пустая карта (нет ключа, сбой сети) → хардкод-жанр сида.
 */
async function tmdbGenreMap(
  localByTitle: Map<string, number>,
  key: string | null,
  fetchFn: typeof fetch,
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (!key) return map;
  for (const kind of ["movie", "tv"] as const) {
    const url = new URL(`${TMDB_BASE}/genre/${kind}/list`);
    url.searchParams.set("api_key", key);
    url.searchParams.set("language", "ru-RU");
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = (await res.json()) as { genres?: Array<{ id?: unknown; name?: unknown }> };
      for (const g of data.genres ?? []) {
        if (typeof g.id !== "number" || typeof g.name !== "string") continue;
        const local =
          localByTitle.get(GENRE_ALIASES[g.name] ?? g.name) ?? localByTitle.get(g.name);
        if (local != null) map.set(g.id, local);
      }
    } catch {
      // Нет карты жанров — у тайтлов останется хардкод-жанр сида.
    }
  }
  return map;
}

/**
 * Локальные жанры тайтла: TMDb genre_ids → локальные id (все найденные),
 * хардкод-жанр — фолбэк, если TMDb жанров не дал или они не смапились.
 */
function resolveGenres(
  seed: MovieSeed,
  meta: TmdbMeta | null,
  localByTitle: Map<string, number>,
  tmdbToLocal: Map<number, number>,
): number[] {
  const ids: number[] = [];
  if (meta) {
    for (const gid of meta.genreIds) {
      const local = tmdbToLocal.get(gid);
      if (local != null && !ids.includes(local)) ids.push(local);
    }
  }
  if (ids.length === 0) {
    const fallback = localByTitle.get(seed.genre);
    if (fallback != null) ids.push(fallback);
  }
  return ids;
}

const TOP_TITLES: MovieSeed[] = [
  // 2024-2026 Premieres & Blockbusters
  {
    title: "Дэдпул и Росомаха",
    originalTitle: "Deadpool & Wolverine",
    year: 2024,
    type: "movie",
    plot: "Уэйд Уилсон ведет тихий образ жизни, пока организация 'Управление временными изменениями' не втягивает его в новую миссию вместе с Росомахой.",
    rating: 8.1,
    views: 89000,
    poster: "https://image.tmdb.org/t/p/w500/4Li3gy8Ga6q0bAz2odg7ZFoRqLy.jpg",
    genre: "Боевик",
  },
  {
    title: "Головоломка 2",
    originalTitle: "Inside Out 2",
    year: 2024,
    type: "movie",
    plot: "Райли становится подростком, и в головном отделе появляются новые беспокойные эмоции: Тревожность, Зависть, Стыд и Хандра.",
    rating: 8.0,
    views: 78000,
    poster: "https://image.tmdb.org/t/p/w500/5fXrqBIvatwSuph7nTuSETBQYxm.jpg",
    genre: "Мультфильм",
  },
  {
    title: "Субстанция",
    originalTitle: "The Substance",
    year: 2024,
    type: "movie",
    plot: "Увядающая голливудская звезда соглашается принять экспериментальный препарат 'Субстанция', создающий ее идеальную молодую версию.",
    rating: 8.3,
    views: 82000,
    poster: "https://image.tmdb.org/t/p/w500/x3yhBGbTqlAjxM450BANUNCHpOO.jpg",
    genre: "Драма",
  },
  {
    title: "Чужой: Ромул",
    originalTitle: "Alien: Romulus",
    year: 2024,
    type: "movie",
    plot: "Группа молодых колонизаторов исследует заброшенную космическую станцию и сталкивается с самой смертоносной формой жизни во Вселенной.",
    rating: 7.9,
    views: 74000,
    poster: "https://image.tmdb.org/t/p/w500/b33nnKl1GSFbao4l3fZDDqsMx0F.jpg",
    genre: "Фантастика",
  },
  {
    title: "Дикий робот",
    originalTitle: "The Wild Robot",
    year: 2024,
    type: "movie",
    plot: "Робот Роз терпит кораблекрушение на необитаемом острове и учится выживать, заботясь об осиротевшем гусенке.",
    rating: 8.5,
    views: 69000,
    poster: "https://image.tmdb.org/t/p/w500/sDTumQBxhIyYbZ9acsTtoLfb5ZG.jpg",
    genre: "Мультфильм",
  },
  {
    title: "Гладиатор 2",
    originalTitle: "Gladiator II",
    year: 2024,
    type: "movie",
    plot: "Спустя годы после гибели Максимуса Луций вынужден выйти на арену Колизея, чтобы вернуть Риму былую славу.",
    rating: 7.7,
    views: 81000,
    poster: "https://image.tmdb.org/t/p/w500/2cxhvwyEwRlysAmRH4iodkvo0z5.jpg",
    genre: "Боевик",
  },
  {
    title: "Битлджус Битлджус",
    originalTitle: "Beetlejuice Beetlejuice",
    year: 2024,
    type: "movie",
    plot: "После трагедии в семье три поколения Дитцев возвращаются в Уинтер-Ривер. Дочь Лидии случайно открывает портал в загробный мир.",
    rating: 7.6,
    views: 62000,
    poster: "https://image.tmdb.org/t/p/w500/kKgQzkUCUmynoam0zgQ6vhIRpHw.jpg",
    genre: "Комедия",
  },
  {
    title: "Фуриоса: Хроники Безумного Макса",
    originalTitle: "Furiosa: A Mad Max Saga",
    year: 2024,
    type: "movie",
    plot: "Юная Фуриоса похищена из Зеленых Земель ордой Дементуса. Всю жизнь она борется за то, чтобы найти дорогу домой.",
    rating: 8.0,
    views: 71000,
    poster: "https://image.tmdb.org/t/p/w500/iADOJ8Zymht2JPMoy3R7xUMZqaC.jpg",
    genre: "Боевик",
  },
  {
    title: "Граф Монте-Кристо",
    originalTitle: "Le Comte de Monte-Cristo",
    year: 2024,
    type: "movie",
    plot: "Став жертвой коварного заговора, Эдмон Дантес провел четырнадцать лет в тюрьме замка Иф. Бежав, он решает отомстить врагам.",
    rating: 8.4,
    views: 75000,
    poster: "https://image.tmdb.org/t/p/w500/A30u5Z9hH17Ocmf1DqY4iM3E6vK.jpg",
    genre: "Драма",
  },
  {
    title: "Моана 2",
    originalTitle: "Moana 2",
    year: 2024,
    type: "movie",
    plot: "Моана и Мауи отправляются в новое захватывающее путешествие к далеким неизведанным водам Океании.",
    rating: 7.8,
    views: 59000,
    poster: "https://image.tmdb.org/t/p/w500/wrg0C7sw1T1ogXvS8P4kiawY9xv.jpg",
    genre: "Мультфильм",
  },
  {
    title: "Веном: Последний танец",
    originalTitle: "Venom: The Last Dance",
    year: 2024,
    type: "movie",
    plot: "Эдди Брок и Веном пускаются в бега: их преследуют оба их мира, вынуждая принять сокрушительное решение.",
    rating: 7.5,
    views: 85000,
    poster: "https://image.tmdb.org/t/p/w500/YFcQ65dRrLpUpMiMFrrRV6rkEs.jpg",
    genre: "Боевик",
  },
  {
    title: "Пингвин",
    originalTitle: "The Penguin",
    year: 2024,
    type: "serial",
    plot: "Оз Кобблпот стремится захватить власть в преступном мире Готэма после гибели Кармайна Фальконе.",
    rating: 8.8,
    views: 94000,
    poster: "https://image.tmdb.org/t/p/w500/aWc52fU2x9kS040aDk8h2bHjWwS.jpg",
    genre: "Криминал",
  },
  {
    title: "Сегун",
    originalTitle: "Shōgun",
    year: 2024,
    type: "serial",
    plot: "В феодальной Японии 1600 года английский штурман Джон Блэкторн оказывается втянут в борьбу за трон лорда Торанаги.",
    rating: 8.9,
    views: 92000,
    poster: "https://image.tmdb.org/t/p/w500/7O4iVfOMQmdCSxhOg1WnzG1AgYT.jpg",
    genre: "Драма",
  },
  {
    title: "Фоллаут",
    originalTitle: "Fallout",
    year: 2024,
    type: "serial",
    plot: "Спустя 200 лет после ядерного апокалипсиса наивная жительница Убежища выходит на поверхность безжалостной пустоши.",
    rating: 8.5,
    views: 96000,
    poster: "https://image.tmdb.org/t/p/w500/AnsZu440f3bwh2jY2Lz5kM6gB9d.jpg",
    genre: "Фантастика",
  },
  {
    title: "Дом Дракона",
    originalTitle: "House of the Dragon",
    year: 2024,
    type: "serial",
    plot: "Гражданская война за Железный трон, известная как Танец Драконов, разделяет дом Таргариенов на Черных и Зеленых.",
    rating: 8.5,
    views: 98000,
    poster: "https://image.tmdb.org/t/p/w500/1X4h40fcB4WWUmIBK0auT4zZZga.jpg",
    genre: "Фэнтези",
  },
  {
    title: "Поднятие уровня в одиночку",
    originalTitle: "Solo Leveling",
    year: 2024,
    type: "serial",
    plot: "Самый слабый охотник Сон Джин-у после смертельного подземелья получает уникальную способность непрерывно прокачивать уровень.",
    rating: 8.7,
    views: 89000,
    poster: "https://image.tmdb.org/t/p/w500/8u56LKz0An8xa9YaFtkxsDKc5N5.jpg",
    genre: "Аниме",
  },
  {
    title: "Дандадан",
    originalTitle: "Dandadan",
    year: 2024,
    type: "serial",
    plot: "Момо верит в призраков, а Окарун — в инопланетян. Спор приводит их к встрече с обеими потусторонними силами сразу.",
    rating: 8.6,
    views: 74000,
    poster: "https://image.tmdb.org/t/p/w500/6y18M8hQ401Wf8W8k3sH6aF5b4x.jpg",
    genre: "Аниме",
  },
  {
    title: "Кайдзю номер восемь",
    originalTitle: "Kaiju No. 8",
    year: 2024,
    type: "serial",
    plot: "Кафка Хибино мечтает вступить в Силы обороны от кайдзю, но случайно сам получает способность превращаться в гигантского монстра.",
    rating: 8.4,
    views: 65000,
    poster: "https://image.tmdb.org/t/p/w500/qDgaZ5M4d99q9Z8a8r9hT4M4G5P.jpg",
    genre: "Аниме",
  },

  // Sci-Fi / Blockbusters
  {
    title: "Интерстеллар",
    originalTitle: "Interstellar",
    year: 2014,
    type: "movie",
    plot: "Засуха и пыльные бури приводят человечество к продовольственному кризису. Коллектив ученых отправляется сквозь червоточину в поисках нового дома.",
    rating: 8.7,
    views: 45200,
    poster: "https://image.tmdb.org/t/p/w500/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg",
    genre: "Фантастика",
  },
  {
    title: "Начало",
    originalTitle: "Inception",
    year: 2010,
    type: "movie",
    plot: "Кобб — искусный вор, лучший в опасном искусстве извлечения: он крадет ценные секреты из глубин подсознания во время сна.",
    rating: 8.8,
    views: 52100,
    poster: "https://image.tmdb.org/t/p/w500/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg",
    genre: "Фантастика",
  },
  {
    title: "Дюна: Часть вторая",
    originalTitle: "Dune: Part Two",
    year: 2024,
    type: "movie",
    plot: "Пол Атрейдес объединяется с Чани и фрименами, чтобы отомстить заговорщикам, уничтожившим его семью.",
    rating: 8.6,
    views: 63000,
    poster: "https://image.tmdb.org/t/p/w500/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg",
    genre: "Фантастика",
  },
  {
    title: "Дюна",
    originalTitle: "Dune",
    year: 2021,
    type: "movie",
    plot: "Наследник знаменитого дома Атрейдесов Пол отправляется вместе с семьей на одну из самых опасных планет во Вселенной — Арракис.",
    rating: 8.0,
    views: 41200,
    poster: "https://image.tmdb.org/t/p/w500/d5NXSklXo0qyIYkgV94XAgMIckC.jpg",
    genre: "Фантастика",
  },
  {
    title: "Оппенгеймер",
    originalTitle: "Oppenheimer",
    year: 2023,
    type: "movie",
    plot: "История жизни американского физика Роберта Оппенгеймера, стоявшего во главе первых разработок ядерного оружия в рамках Манхэттенского проекта.",
    rating: 8.9,
    views: 58000,
    poster: "https://image.tmdb.org/t/p/w500/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg",
    genre: "Драма",
  },
  {
    title: "Матрица",
    originalTitle: "The Matrix",
    year: 1999,
    type: "movie",
    plot: "Хакер Нео узнает, что привычный мир — иллюзия, созданная машинами, поработившими человечество.",
    rating: 8.7,
    views: 72000,
    poster: "https://image.tmdb.org/t/p/w500/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg",
    genre: "Фантастика",
  },
  {
    title: "Бойцовский клуб",
    originalTitle: "Fight Club",
    year: 1999,
    type: "movie",
    plot: "Страдающий бессонницей клерк знакомится с харизматичным торговцем мылом Тайлером Дёрденом и открывает тайный клуб для мужчин.",
    rating: 8.8,
    views: 65400,
    poster: "https://image.tmdb.org/t/p/w500/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg",
    genre: "Триллер",
  },
  {
    title: "Бегущий по лезвию 2049",
    originalTitle: "Blade Runner 2049",
    year: 2017,
    type: "movie",
    plot: "Офицер полиции Кей находит тайну, способную повергнуть остатки общества в хаос. Это открытие ведет его к поискам Рика Декарда.",
    rating: 8.0,
    views: 38900,
    poster: "https://image.tmdb.org/t/p/w500/gajva2L0rPYkEWjzgFlBXCAVBE5.jpg",
    genre: "Фантастика",
  },
  {
    title: "Темный рыцарь",
    originalTitle: "The Dark Knight",
    year: 2008,
    type: "movie",
    plot: "Бэтмен поднимает ставки в войне с криминалом, но сталкивается с гением хаоса по прозвищу Джокер.",
    rating: 9.0,
    views: 89000,
    poster: "https://image.tmdb.org/t/p/w500/qJ2tW6WMUDux911r6m7haRef0WH.jpg",
    genre: "Боевик",
  },
  {
    title: "Криминальное чтиво",
    originalTitle: "Pulp Fiction",
    year: 1994,
    type: "movie",
    plot: "Двое бандитов ведут философские беседы в перерывах между разборками с должниками своего босса.",
    rating: 8.9,
    views: 74200,
    poster: "https://image.tmdb.org/t/p/w500/d5iIlFn5s0ImszYzBPb8JPIfbXD.jpg",
    genre: "Триллер",
  },
  {
    title: "Побег из Шоушенка",
    originalTitle: "The Shawshank Redemption",
    year: 1994,
    type: "movie",
    plot: "Бухгалтер Энди Дюфрейн несправедливо осужден на два пожизненных срока за убийство жены и попадает в жестокую тюрьму Шоушенк.",
    rating: 9.3,
    views: 95000,
    poster: "https://image.tmdb.org/t/p/w500/9cqNxx0GxF0bflZmeSMuL5tnGzr.jpg",
    genre: "Драма",
  },
  {
    title: "Зеленая миля",
    originalTitle: "The Green Mile",
    year: 1999,
    type: "movie",
    plot: "В блок смертников попадает гигант Джон Коффи, обвиненный в страшном преступлении, обладающий поразительным даром исцеления.",
    rating: 9.1,
    views: 88500,
    poster: "https://image.tmdb.org/t/p/w500/velWPhVMQeQKcxggNEU8YmIo52R.jpg",
    genre: "Драма",
  },
  {
    title: "Гладиатор",
    originalTitle: "Gladiator",
    year: 2000,
    type: "movie",
    plot: "Великий римский полководец Максимус предан завистливым наследником престола и превращается в гладиатора.",
    rating: 8.5,
    views: 54000,
    poster: "https://image.tmdb.org/t/p/w500/ty8TGRuvJLPUmAR1H1nRIsgwvim.jpg",
    genre: "Боевик",
  },
  {
    title: "Джентльмены",
    originalTitle: "The Gentlemen",
    year: 2019,
    type: "movie",
    plot: "Талантливый выпускник Оксфорда придумал нелегальную схему обогащения. Но когда он решает продать бизнес, на его пути встают другие бандиты.",
    rating: 8.5,
    views: 68000,
    poster: "https://image.tmdb.org/t/p/w500/jtrhTYB7xSrJxR1vusu99nvnZ1g.jpg",
    genre: "Боевик",
  },
  {
    title: "Брат",
    originalTitle: "Brat",
    year: 1997,
    type: "movie",
    plot: "Демобилизованный из армии Данила Багров приезжает в Санкт-Петербург к старшему брату, который работает наемным убийцей.",
    rating: 8.3,
    views: 91000,
    poster: "https://image.tmdb.org/t/p/w500/8d8H34Q1U719uRrq4K25Jp19f2t.jpg",
    genre: "Боевик",
  },
  {
    title: "Брат 2",
    originalTitle: "Brat 2",
    year: 2000,
    type: "movie",
    plot: "Данила Багров отправляется в Америку, чтобы восстановить справедливость и помочь брату погибшего армейского друга.",
    rating: 8.2,
    views: 89000,
    poster: "https://image.tmdb.org/t/p/w500/hPqgZfM34N63aYpLw9M2qRk190f.jpg",
    genre: "Боевик",
  },
  {
    title: "Аватар: Путь воды",
    originalTitle: "Avatar: The Way of Water",
    year: 2022,
    type: "movie",
    plot: "Джейк Салли и Нейтири создали семью на Пандоре. Но когда возвращается старая угроза, они вынуждены покинуть родной лес и искать убежище у морского клана.",
    rating: 7.9,
    views: 59000,
    poster: "https://image.tmdb.org/t/p/w500/t6HIqrRAclMCA60NsSmeqe9RmNV.jpg",
    genre: "Фантастика",
  },

  // Series
  {
    title: "Во все тяжкие",
    originalTitle: "Breaking Bad",
    year: 2008,
    type: "serial",
    plot: "Школьный учитель химии Уолтер Уайт узнает о смертельном диагнозе и начинает производить метамфетамин ради будущего своей семьи.",
    rating: 9.5,
    views: 110000,
    poster: "https://image.tmdb.org/t/p/w500/ggFHVNu6YYI5L9pCfOacjizRGt.jpg",
    genre: "Триллер",
  },
  {
    title: "Игра престолов",
    originalTitle: "Game of Thrones",
    year: 2011,
    type: "serial",
    plot: "К концу подходит время благоденствия, и лето, длившееся почти десятилетие, уступает место зиме. Несколько благородных домов борются за Железный трон.",
    rating: 9.3,
    views: 125000,
    poster: "https://image.tmdb.org/t/p/w500/1XS1oqL89opfnbLl8WnZY1O1uJx.jpg",
    genre: "Фантастика",
  },
  {
    title: "Чернобыль",
    originalTitle: "Chernobyl",
    year: 2019,
    type: "serial",
    plot: "Хроника ликвидации страшной аварии на Чернобыльской АЭС в апреле 1986 года и человеческих судеб, пострадавших от трагедии.",
    rating: 9.4,
    views: 78000,
    poster: "https://image.tmdb.org/t/p/w500/hlLXt2tOPT6RRnjiUmoxyG1LTFi.jpg",
    genre: "Драма",
  },
  {
    title: "Очень странные дела",
    originalTitle: "Stranger Things",
    year: 2016,
    type: "serial",
    plot: "В провинциальном городке таинственным образом исчезает мальчик, а его друзья встречают необычную девочку с телекинетическими способностями.",
    rating: 8.7,
    views: 92000,
    poster: "https://image.tmdb.org/t/p/w500/49WJfeN0moxb9IPfGn8AIqMGskD.jpg",
    genre: "Фантастика",
  },
  {
    title: "Слово пацана. Кровь на асфальте",
    originalTitle: "Slovo patsana",
    year: 2023,
    type: "serial",
    plot: "Конец 1980-х годов. Подростки в Казани объединяются в уличные группировки, чтобы контролировать районы и отстаивать свои понятия.",
    rating: 8.4,
    views: 99000,
    poster: "https://image.tmdb.org/t/p/w500/p9n207M2t8L1mKzY46FjWvYjLqV.jpg",
    genre: "Драма",
  },
  {
    title: "Острые козырьки",
    originalTitle: "Peaky Blinders",
    year: 2013,
    type: "serial",
    plot: "Бирмингем, 1920-е годы. Гангстерская семья Шелби во главе с безжалостным Томасом строит криминальную империю в послевоенной Англии.",
    rating: 8.8,
    views: 86000,
    poster: "https://image.tmdb.org/t/p/w500/vUUqzWa2LnHIVqkaKVlVGkVcTTW.jpg",
    genre: "Драма",
  },
  {
    title: "Рик и Морти",
    originalTitle: "Rick and Morty",
    year: 2013,
    type: "serial",
    plot: "Сумасшедший ученый Рик Санчез втягивает своего внука Морти в безумные приключения по параллельным мирам и галактикам.",
    rating: 9.1,
    views: 104000,
    poster: "https://image.tmdb.org/t/p/w500/cvhNj9eoRBe5SxjCbQTkh05UP5K.jpg",
    genre: "Мультфильм",
  },

  // Anime
  {
    title: "Атака титанов",
    originalTitle: "Shingeki no Kyojin",
    year: 2013,
    type: "serial",
    plot: "Человечество ведет отчаянную войну за выживание против гигантских титанов, разрушивших внешние стены их последнего убежища.",
    rating: 9.0,
    views: 87000,
    poster: "https://image.tmdb.org/t/p/w500/hTP1DtLGFamjfu8WqjnuQdP1n4i.jpg",
    genre: "Приключения",
  },
  {
    title: "Тетрадь смерти",
    originalTitle: "Death Note",
    year: 2006,
    type: "serial",
    plot: "Старшеклассник Лайт Ягами находит тетрадь бога смерти, способную убить любого, чье имя в нее записано, и начинает вершить правосудие.",
    rating: 9.0,
    views: 94000,
    poster: "https://image.tmdb.org/t/p/w500/iigTJJskR1PcjjPLi7Puvblhvqn.jpg",
    genre: "Триллер",
  },
  {
    title: "Унесённые призраками",
    originalTitle: "Sen to Chihiro no kamikakushi",
    year: 2001,
    type: "movie",
    plot: "Девочка Тихиро попадает в волшебный мир духов и ведьм, где должна спасти своих родителей, превращенных в свиней.",
    rating: 8.6,
    views: 67000,
    poster: "https://image.tmdb.org/t/p/w500/39wmItIWsg5sZMyRUHLkWBcuVCM.jpg",
    genre: "Мультфильм",
  },
  {
    title: "Клинок, рассекающий демонов",
    originalTitle: "Kimetsu no Yaiba",
    year: 2019,
    type: "serial",
    plot: "Тандзиро Камадо становится истребителем демонов, чтобы отомстить за гибель своей семьи и спасти сестру Нэдзуко.",
    rating: 8.7,
    views: 76000,
    poster: "https://image.tmdb.org/t/p/w500/xUfRZu2mi8jH6SzQEJGP6tjBuYj.jpg",
    genre: "Боевик",
  },
  {
    title: "Киберпанк: Бегущие по краю",
    originalTitle: "Cyberpunk: Edgerunners",
    year: 2022,
    type: "serial",
    plot: "В Найт-Сити, городе будущего, одержимом технологиями и модификациями тела, парень решает стать наемником-эджраннером.",
    rating: 8.4,
    views: 61000,
    poster: "https://image.tmdb.org/t/p/w500/7jswLzX6s5nr8FE9y6SScPOGjzg.jpg",
    genre: "Фантастика",
  }
];

/**
 * Строка подключения без пароля — для логов. Пароль в выводе деплоя не нужен
 * никому: лог остаётся на сервере, попадает в переписку и в отчёты.
 */
export function redactPassword(url: string): string {
  return url.replace(/\/\/[^:@/]*:[^@/]*@/, "//***:***@");
}

export interface SeedCatalogOptions {
  /** Готовое соединение (тесты на PGlite); без него — свой пул из DATABASE_URL. */
  db?: Db;
  /** Транспорт к TMDb (тесты подменяют); по умолчанию глобальный fetch. */
  fetch?: typeof fetch;
  /** Ключ TMDb; по умолчанию TMDB_API_KEY из окружения, null — обогащение выключено. */
  tmdbKey?: string | null;
}

export async function seedCatalog(opts: SeedCatalogOptions = {}) {
  const tmdbKey = opts.tmdbKey === undefined ? (process.env.TMDB_API_KEY ?? null) : opts.tmdbKey;
  const fetchFn = opts.fetch ?? fetch;

  let pool: ReturnType<typeof createPool> | null = null;
  let customDb: Db;
  if (opts.db) {
    customDb = opts.db;
  } else {
    // Дефолт только для локальной разработки; пароль намеренно не боевой.
    const databaseUrl = process.env.DATABASE_URL ?? "postgres://zal:dev@localhost:5432/zal";
    pool = createPool(databaseUrl);
    customDb = createDb(pool);
    // Пароль из строки не печатаем: этот вывод уходит в лог деплоя, а лог читают
    // и люди, и агенты. Раньше в него попадал DATABASE_URL целиком.
    console.log("Seeding extensive catalog into", redactPassword(databaseUrl));
  }
  if (!tmdbKey) {
    console.warn("TMDB_API_KEY не задан: постеры/описания берутся из сид-констант");
  }

  // Ensure genres exist
  const genreList = await customDb.select().from(genres);
  const genreMap = new Map(genreList.map((g) => [g.title, g.id]));
  // Карта TMDb genre id → локальный id: один запрос на прогон, не на тайтл.
  const tmdbToLocal = await tmdbGenreMap(genreMap, tmdbKey, fetchFn);

  let enriched = 0;
  for (const item of TOP_TITLES) {
    const meta = await tmdbMeta(item, tmdbKey, fetchFn);
    if (meta) enriched++;

    const title = item.title;
    const year = meta?.year ?? item.year;
    const plot = meta?.plot ?? item.plot;
    const rating = meta?.rating ?? item.rating;
    const posterSmall = meta?.posterSmall ?? item.poster;
    const posterMedium = meta?.posterMedium ?? item.poster;
    const posterBig = meta?.posterBig ?? item.poster;
    const originalTitle = meta?.originalTitle ?? item.originalTitle;
    const runtime = meta?.runtimeSeconds ?? 7200;

    const existing = await customDb
      .select({ id: items.id })
      .from(items)
      .where(eq(items.title, title))
      .limit(1);

    let itemId = existing[0]?.id;

    if (itemId) {
      // Обновляем метаданные существующих: битые хардкод-постеры сида
      // (около трети URL 404-ят) замещаются живыми TMDb-данными.
      await customDb
        .update(items)
        .set({
          originalTitle,
          year,
          plot,
          rating,
          posterSmall,
          posterMedium,
          posterBig,
          runtimeAvg: runtime,
          updatedAt: new Date(),
          // tmdbId дописываем, только когда мета нашлась: сбой TMDb не должен
          // затирать уже записанный id нуллом.
          ...(meta?.tmdbId != null ? { tmdbId: meta.tmdbId } : {}),
        })
        .where(eq(items.id, itemId));
      await customDb
        .update(media)
        .set({ runtime })
        .where(eq(media.itemId, itemId));
      // Жанры существующим тоже дописываем: у сид-тайтлов был один
      // хардкод-жанр, TMDb даёт полный набор. onConflictDoNothing держит
      // идемпотентность повторных прогонов.
      if (meta) {
        const gids = resolveGenres(item, meta, genreMap, tmdbToLocal);
        if (gids.length > 0) {
          await customDb
            .insert(itemGenres)
            .values(gids.map((gid) => ({ itemId, genreId: gid })))
            .onConflictDoNothing();
        }
      }
      continue;
    }

    const [inserted] = await customDb
      .insert(items)
      .values({
        type: item.type,
        title,
        originalTitle,
        year,
        plot,
        rating,
        views: item.views,
        posterSmall,
        posterMedium,
        posterBig,
        quality: 2160,
        runtimeAvg: runtime,
        // Связь с TMDb: по ней дедупится fill и работает on-demand гидрация
        // сезонов (apps/api/src/lib/tmdb.ts) — без id сериал остаётся без
        // эпизодов.
        tmdbId: meta?.tmdbId ?? null,
      })
      .returning({ id: items.id });
    itemId = inserted.id;

    // Link genres: все найденные в TMDb, хардкод — фолбэк.
    const gids = resolveGenres(item, meta, genreMap, tmdbToLocal);
    if (gids.length > 0) {
      await customDb
        .insert(itemGenres)
        .values(gids.map((gid) => ({ itemId, genreId: gid })))
        .onConflictDoNothing();
    }

    // Create media row
    await customDb.insert(media).values({
      itemId,
      title,
      runtime,
    });

    console.log(`+ Seeded: ${title} (${year})`);
  }

  console.log(
    `Extensive catalog seeded successfully. TMDb enrichment: ${enriched}/${TOP_TITLES.length}.`,
  );
  if (pool) await pool.end();
}

// Allow direct CLI execution
if (process.argv[1]?.endsWith("seed-catalog.ts")) {
  seedCatalog()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
