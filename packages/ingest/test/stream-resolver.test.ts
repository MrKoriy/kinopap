/**
 * Резолвер стримов против локального стаба rutor + TorrServer.
 *
 * Ключевые сценарии, на которых держится «быстрый старт просмотра»:
 *  - ответ не ждёт прогрев торрента (addTorrent + DHT);
 *  - известный прогрев даёт точный индекс файла без похода в TorrServer;
 *  - одновременные запросы дорожек делят одну gst-пробу;
 *  - сезон/серия уходят в поиск (иначе сериалы ищутся как «название»).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StreamResolver } from "../src";

const HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f901234abcd";
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Test&tr=udp://tracker`;
const HASH2 = "b2c3d4e5f60718293a4b5c6d7e8f901234abcdef";

const RUTOR_HTML = `<html><body>
<tr class="gai">
  <td><a href="/torrent/1/test">Гадкий я 2010 1080p WEB-DL</a></td>
  <td><a href="magnet:?xt=urn:btih:${HASH}&dn=Test&tr=udp://tracker">magnet</a></td>
  <td align="right">2.5 GB</td>
  <td><span class="green">120 </span></td>
  <td><span class="red">4 </span></td>
</tr>
</body></html>`;

const RUTOR_HTML_ALT = RUTOR_HTML.replace(HASH, HASH2);

/** Выдача rutor с одним релизом с заданным названием (для кейсов сверки). */
const rutorHtmlWith = (title: string): string => `<html><body>
<tr class="gai">
  <td><a href="/torrent/1/test">${title}</a></td>
  <td><a href="magnet:?xt=urn:btih:${HASH}&dn=Test&tr=udp://tracker">magnet</a></td>
  <td align="right">2.5 GB</td>
  <td><span class="green">120 </span></td>
  <td><span class="red">4 </span></td>
</tr>
</body></html>`;

const VIDEO_FILES = [
  { id: 1, path: "sample.mkv", length: 1_000_000 },
  { id: 3, path: "Movie.2010.1080p.mkv", length: 2_500_000_000 },
];

const GST_TRACKS = [
  { Index: 0, PadName: "v", Type: "video" },
  { Index: 1, PadName: "a0", Type: "audio", Language: "rus", Title: "Дубляж", Channels: 2 },
  { Index: 2, PadName: "a1", Type: "audio", Language: "eng", Channels: 6 },
];

let server: Server;
let base: string;
let resolver: StreamResolver;

const counters = { add: 0, probe: 0, preopen: 0 };
const rutorQueries: string[] = [];
/** Сколько раз резолвер искал аниме по названию (вместо точного externalId). */
let aniSearches = 0;
/** Какие релизы AniLibria запрашивались: точный путь — только ["777"]. */
const aniReleases: string[] = [];
/** Источник «лежит»: оба эндпоинта отвечают 500. */
let aniDown = false;
/** Rutor без релизов: поиск ничего не нашёл. */
let rutorEmpty = false;
/**
 * Подмена выдачи rutor: когда не null, поиск возвращает эти релизы.
 * Нужна кейсам сверки названий — резолвер обязан отвергать чужие.
 */
let rutorHtmlOverride: string | null = null;
/** Имя релиза в каталоге AniLibria: подменяется кейсом чужого матча. */
let aniCatalogName = "Тест-аниме";
/** Задержка ответа /torrents action=add — имитация медленных метаданных DHT. */
let addDelayMs = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (body: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };

    // Стаб AniLibria: каталог для поиска + релиз с сериями и HLS.
    if (url.pathname === "/anime/catalog/releases") {
      aniSearches += 1;
      if (aniDown) {
        res.statusCode = 500;
        res.end();
        return;
      }
      json({ data: [{ id: 777, name: { main: aniCatalogName, english: "Test Anime" }, year: 2020 }] });
      return;
    }
    const aniRelease = url.pathname.match(/^\/anime\/releases\/(\d+)$/);
    if (aniRelease) {
      aniReleases.push(aniRelease[1]!);
      if (aniDown || aniRelease[1] !== "777") {
        res.statusCode = 404;
        res.end();
        return;
      }
      json({
        id: 777,
        name: { main: "Тест-аниме", english: "Test Anime" },
        year: 2020,
        episodes: [1, 2, 3].map((n) => ({
          id: n,
          ordinal: n,
          name: `Серия ${n}`,
          duration: 1440,
          opening: { start: 90, stop: 180 },
          hls_1080: `${base}/hls/ep${n}/index.m3u8`,
        })),
      });
      return;
    }

    if (url.pathname.startsWith("/search/")) {
      rutorQueries.push(decodeURIComponent(url.pathname));
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (rutorEmpty) {
        res.end("<html><body></body></html>");
        return;
      }
      if (rutorHtmlOverride) {
        res.end(rutorHtmlOverride);
        return;
      }
      // Второй параллельный запрос (оригинальное название) отдаём тем же
      // хешем — дедуп по hash должен оставить один релиз.
      res.end(rutorQueries.length % 2 === 0 ? RUTOR_HTML_ALT : RUTOR_HTML);
      return;
    }

    if (url.pathname === "/torrents") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const action = (JSON.parse(raw || "{}") as { action?: string }).action;
        if (action === "add") {
          counters.add += 1;
          void (async () => {
            if (addDelayMs) await new Promise((r) => setTimeout(r, addDelayMs));
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ hash: HASH, file_stats: VIDEO_FILES }));
          })();
          return;
        }
        json({ hash: HASH, file_stats: VIDEO_FILES });
      });
      return;
    }

    if (url.pathname === "/stream") {
      counters.preopen += 1;
      res.setHeader("content-type", "video/mp4");
      res.end("head-bytes");
      return;
    }

    if (url.pathname.endsWith("/probe")) {
      counters.probe += 1;
      json({ Tracks: GST_TRACKS });
      return;
    }

    if (url.pathname === "/echo") {
      json({ ok: true });
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resolver = new StreamResolver({
    rutorBaseUrl: base,
    torrServerBaseUrl: base,
    torrServerPublicUrl: base,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  counters.add = 0;
  counters.probe = 0;
  counters.preopen = 0;
  rutorQueries.length = 0;
  aniSearches = 0;
  aniReleases.length = 0;
  aniDown = false;
  rutorEmpty = false;
  rutorHtmlOverride = null;
  aniCatalogName = "Тест-аниме";
  addDelayMs = 0;
});

const query = (over: Partial<Parameters<StreamResolver["resolve"]>[0]> = {}) => ({
  itemId: 1,
  mediaId: 1,
  title: "Гадкий я",
  year: 2010,
  type: "movie",
  ...over,
});

describe("StreamResolver.resolve", () => {
  it("не ждёт медленный прогрев: ответ уходит в пределах бюджета, warm — null", async () => {
    addDelayMs = 8000;

    const startedAt = Date.now();
    const resolved = await resolver.resolve(query({ itemId: 1, mediaId: 1 }));
    const elapsed = Date.now() - startedAt;

    expect(resolved.warm).toBeNull();
    // Прогрев даёт 2.5с бюджета, дальше ответ уходит сам.
    expect(elapsed).toBeLessThan(6000);
    // Файлы всё равно содержат gst-HLS: хеш известен из магнита,
    // TorrServer подтянет торрент по DHT при первом же манифесте.
    expect(resolved.files[0]?.urls.hls).toBe(
      `${base}/gst/${HASH}/master.m3u8?index=1&audio=0`,
    );
    expect(resolved.files[0]?.urls.http).toContain("magnet");
    expect(counters.add).toBeGreaterThan(0);
  });

  it("использует известный прогрев: точный индекс и ни одного addTorrent", async () => {
    const warm = { hash: HASH, fileIndex: 3, magnet: MAGNET, title: "Гадкий я 2010 1080p" };

    const resolved = await resolver.resolve(query({ itemId: 2, mediaId: 2, warm }));

    expect(resolved.warm).toEqual(warm);
    expect(counters.add).toBe(0);
    // Индекс 3 — крупнейший файл, а не sample.mkv с индексом 1.
    expect(resolved.files[0]?.urls.hls).toBe(
      `${base}/gst/${HASH}/master.m3u8?index=3&audio=0`,
    );
    expect(resolved.files[0]?.urls.http).toContain("index=3");
    // Голова файла приоткрывается заново — TorrServer мог перезапуститься.
    await new Promise((r) => setTimeout(r, 100));
    expect(counters.preopen).toBeGreaterThan(0);
  });

  it("прогоняет сезон и серию в поиск rutor", async () => {
    await resolver.resolve(
      query({ itemId: 3, mediaId: 3, title: "Гадкий я", seasonNumber: 1, episodeNumber: 5 }),
    );

    expect(rutorQueries.some((q) => q.includes("s01e05"))).toBe(true);
  });

  it("источников нет — пустой files без мёртвой заглушки link=none", async () => {
    rutorEmpty = true;

    const resolved = await resolver.resolve(
      query({ itemId: 4, mediaId: 4, title: "Несуществующий фильм", year: 1970 }),
    );

    // Честный пустой список: плеер покажет «нет источников», а не ошибку
    // воспроизведения по мёртвой ссылке stream?link=none.
    expect(resolved.files).toEqual([]);
    expect(JSON.stringify(resolved)).not.toContain("link=none");
    expect(resolved.warm).toBeNull();
    // Прогревать нечего — ни одного addTorrent.
    expect(counters.add).toBe(0);
  });
});

describe("StreamResolver — сверка названий релизов", () => {
  // Поиск rutor нечёткий: на «Во все тяжкие 2008» он возвращал и
  // «Breaking Bear» — без сверки резолвер прикладывал чужой файл к тайтлу
  // (подмена контента на проде). Совпасть обязано название, а не выдача.

  it("чужой релиз (Breaking Bear) не прикладывается к Breaking Bad", async () => {
    rutorHtmlOverride = rutorHtmlWith("Breaking.Bear.S01E08.720p.WEB-DL");

    const resolved = await resolver.resolve(
      query({
        itemId: 21,
        mediaId: 21,
        title: "Во все тяжкие",
        originalTitle: "Breaking Bad",
        year: 2008,
      }),
    );

    expect(resolved.files).toEqual([]);
    expect(resolved.warm).toBeNull();
    expect(counters.add).toBe(0);
  });

  it("релиз на языке оригинала проходит по оригинальному названию", async () => {
    rutorHtmlOverride = rutorHtmlWith("Breaking.Bad.S01.COMPLETE.720p.WEB-DL");

    const resolved = await resolver.resolve(
      query({
        itemId: 22,
        mediaId: 22,
        title: "Во все тяжкие",
        originalTitle: "Breaking Bad",
        year: null,
      }),
    );

    expect(resolved.files.length).toBeGreaterThan(0);
  });

  it("русское релизное имя с разделителями и серией проходит", async () => {
    rutorHtmlOverride = rutorHtmlWith("Во.все.тяжкие.S01E01.720p.WEB-DL");

    const resolved = await resolver.resolve(
      query({
        itemId: 23,
        mediaId: 23,
        title: "Во все тяжкие",
        year: 2008,
        seasonNumber: 1,
        episodeNumber: 1,
      }),
    );

    expect(resolved.files.length).toBeGreaterThan(0);
  });

  it("сиквел с чужим годом не подменяет первую часть", async () => {
    rutorHtmlOverride = rutorHtmlWith("Форсаж 2 / The Fate of the Furious (2019) WEB-DL 1080p");

    const resolved = await resolver.resolve(
      query({
        itemId: 24,
        mediaId: 24,
        title: "Форсаж",
        originalTitle: "The Fast and the Furious",
        year: 2001,
      }),
    );

    expect(resolved.files).toEqual([]);
  });

  it("числа-маркеры: «Форсаж 2» без года не проходит под «Форсаж»", async () => {
    rutorHtmlOverride = rutorHtmlWith("Форсаж 2 BDRip 1080p");

    const resolved = await resolver.resolve(
      query({ itemId: 25, mediaId: 25, title: "Форсаж", year: null }),
    );

    expect(resolved.files).toEqual([]);
  });

  it("год в названии релиза обязан совпадать с тайтлом", async () => {
    rutorHtmlOverride = rutorHtmlWith("Гадкий я (2010) BDRip 1080p");
    const ok = await resolver.resolve(query({ itemId: 26, mediaId: 26 }));
    expect(ok.files.length).toBeGreaterThan(0);

    rutorHtmlOverride = rutorHtmlWith("Гадкий я (2015) BDRip 1080p");
    const bad = await resolver.resolve(query({ itemId: 27, mediaId: 27 }));
    expect(bad.files).toEqual([]);
  });

  it("год в самом названии тайтла («Бегущий по лезвию 2049») не считается чужим", async () => {
    rutorHtmlOverride = rutorHtmlWith("Бегущий по лезвию 2049 (2017) BDRip 1080p");

    const resolved = await resolver.resolve(
      query({
        itemId: 28,
        mediaId: 28,
        title: "Бегущий по лезвию 2049",
        originalTitle: "Blade Runner 2049",
        year: 2017,
      }),
    );

    expect(resolved.files.length).toBeGreaterThan(0);
  });

  it("сиквел без номера и без года режется щитом хвоста", async () => {
    rutorHtmlOverride = rutorHtmlWith("Мстители Эра Альтрона BDRip");

    const resolved = await resolver.resolve(
      query({
        itemId: 29,
        mediaId: 29,
        title: "Мстители",
        originalTitle: "The Avengers",
        year: null,
      }),
    );

    expect(resolved.files).toEqual([]);
  });
});

describe("StreamResolver — аниме: чужой результат поиска AniLibria", () => {
  const aniResolver = () =>
    new StreamResolver({
      rutorBaseUrl: base,
      torrServerBaseUrl: base,
      torrServerPublicUrl: base,
      anilibriaBaseUrl: base,
    });

  it("не берёт релиз с несовпадающим названием, откатываясь на торренты", async () => {
    aniCatalogName = "Совсем-другое-аниме";

    const resolved = await aniResolver().resolve(
      query({
        itemId: 31,
        mediaId: 31,
        title: "Тест-аниме",
        type: "anime",
        year: 2020,
      }),
    );

    // Чужой релиз вообще не запрашивался; по «Тест-аниме» rutor ничего
    // совпадающего не находит — честный пустой список.
    expect(aniSearches).toBe(1);
    expect(aniReleases).toEqual([]);
    expect(resolved.files).toEqual([]);
  });
});

describe("StreamResolver.resolve — аниме (AniLibria)", () => {
  const aniResolver = () =>
    new StreamResolver({
      rutorBaseUrl: base,
      torrServerBaseUrl: base,
      torrServerPublicUrl: base,
      anilibriaBaseUrl: base,
    });

  it("по externalId берёт релиз напрямую: без поиска по названию, серия — своя", async () => {
    const resolved = await aniResolver().resolve(
      query({
        itemId: 11,
        mediaId: 11,
        title: "Тест-аниме",
        type: "anime",
        year: 2020,
        seasonNumber: 1,
        episodeNumber: 2,
        externalSource: "anilibria",
        externalId: "777",
      }),
    );

    // Точный путь: ни одного поискового запроса, только getRelease(777).
    expect(aniSearches).toBe(0);
    expect(aniReleases).toEqual(["777"]);
    // Серия 2, а не первая попавшаяся.
    expect(resolved.files[0]?.urls.hls).toBe(`${base}/hls/ep2/index.m3u8`);
    // Интро из этой же серии.
    expect(resolved.intro).toEqual({ startSeconds: 90, endSeconds: 180 });
  });

  it("без externalId — поиск по названию, потом getRelease первого совпадения", async () => {
    const resolved = await aniResolver().resolve(
      query({
        itemId: 12,
        mediaId: 12,
        title: "Тест-аниме",
        type: "anime",
        year: 2020,
        episodeNumber: 1,
      }),
    );

    expect(aniSearches).toBe(1);
    expect(aniReleases).toEqual(["777"]);
    expect(resolved.files[0]?.urls.hls).toBe(`${base}/hls/ep1/index.m3u8`);
  });

  it("AniLibria лежит — ответ не падает, остаётся торрентный фолбэк", async () => {
    aniDown = true;
    const resolved = await aniResolver().resolve(
      query({
        itemId: 13,
        mediaId: 13,
        title: "Гадкий я",
        type: "anime",
        externalSource: "anilibria",
        externalId: "777",
      }),
    );

    expect(resolved.files.length).toBeGreaterThan(0);
    expect(resolved.files[0]?.urls.hls).toContain("/gst/");
  });
});

describe("StreamResolver.tracksFor", () => {
  it("строит дорожки с персональными gst-мастерами", async () => {
    const warm = { hash: HASH, fileIndex: 3, magnet: MAGNET, title: "x" };

    const audios = await resolver.tracksFor(warm);

    expect(audios).toHaveLength(2);
    expect(audios[0]?.masterUrl).toBe(`${base}/gst/${HASH}/master.m3u8?index=3&audio=1`);
    expect(audios[1]?.masterUrl).toBe(`${base}/gst/${HASH}/master.m3u8?index=3&audio=2`);
    expect(audios[1]?.channels).toBe(6);
  });

  it("дедуплицирует одновременные пробы: одна gst-проба на файл", async () => {
    const warm = { hash: HASH, fileIndex: 3, magnet: MAGNET, title: "x" };
    counters.probe = 0;

    const [a, b, c] = await Promise.all([
      resolver.tracksFor(warm),
      resolver.tracksFor(warm),
      resolver.tracksFor(warm),
    ]);

    expect(counters.probe).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });
});
