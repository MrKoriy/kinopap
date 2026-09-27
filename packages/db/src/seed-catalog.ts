import { createPool, createDb } from "./db";
import { items, media, itemGenres, genres } from "./schema/index";
import { eq } from "drizzle-orm";

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

const TOP_TITLES: MovieSeed[] = [
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

export async function seedCatalog() {
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://zal:zal@localhost:5432/zal";
  const pool = createPool(databaseUrl);
  const customDb = createDb(pool);
  console.log("Seeding extensive catalog into", databaseUrl);
  
  // Ensure genres exist
  const genreList = await customDb.select().from(genres);
  const genreMap = new Map(genreList.map((g) => [g.title, g.id]));

  for (const item of TOP_TITLES) {
    const existing = await customDb
      .select({ id: items.id })
      .from(items)
      .where(eq(items.title, item.title))
      .limit(1);

    let itemId = existing[0]?.id;

    if (!itemId) {
      const [inserted] = await customDb
        .insert(items)
        .values({
          type: item.type,
          title: item.title,
          originalTitle: item.originalTitle,
          year: item.year,
          plot: item.plot,
          rating: item.rating,
          views: item.views,
          posterSmall: item.poster,
          posterMedium: item.poster,
          posterBig: item.poster,
          quality: 2160,
        })
        .returning({ id: items.id });
      itemId = inserted.id;

      // Link genre
      const gid = genreMap.get(item.genre);
      if (gid) {
        await customDb
          .insert(itemGenres)
          .values({ itemId, genreId: gid })
          .onConflictDoNothing();
      }

      // Create media row
      await customDb.insert(media).values({
        itemId,
        title: item.title,
        runtimeSeconds: 7200,
      });

      console.log(`+ Seeded: ${item.title} (${item.year})`);
    }
  }

  console.log("Extensive catalog seeded successfully.");
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
