import type { ItemDetail } from "@zal/api-client";
import { describe, expect, it } from "vitest";
import { formatDuration, formatDurationHuman, formatTime } from "@/lib/format";
import {
  absoluteStreamUrl,
  activeCues,
  bufferedSegments,
  episodeGroups,
  flattenEpisodes,
  isIntroVisible,
  isNearEnd,
  nextAliveSource,
  nextEpisode,
  parseVtt,
  pickInitialFileIndex,
  preferNativeHls,
  resolveStreamUrl,
  segmentsEqual,
  spriteTileFor,
} from "@/lib/player-logic";

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.500
Привет, <b>мир</b>

00:00:04.000 --> 00:00:06.000
Вторая реплика
в две строки

00:01:00.000 --> 00:01:02.000
Через минуту
`;

describe("parseVtt", () => {
  it("разбирает кью и вырезает теги", () => {
    const cues = parseVtt(VTT);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({ start: 1, end: 3.5, text: "Привет, мир" });
    expect(cues[1]!.text).toBe("Вторая реплика\nв две строки");
    expect(cues[2]!.start).toBe(60);
  });

  it("понимает таймстемпы без часов и CRLF", () => {
    const cues = parseVtt("WEBVTT\r\n\r\n01:02.000 --> 01:04.000\r\nок");
    expect(cues).toEqual([{ start: 62, end: 64, text: "ок" }]);
  });

  it("отбрасывает мусорные блоки", () => {
    expect(parseVtt("WEBVTT\n\nпросто текст\n\nNOTE комментарий")).toEqual([]);
    expect(parseVtt("")).toEqual([]);
  });
});

describe("activeCues", () => {
  const cues = parseVtt(VTT);

  it("находит кью в момент времени", () => {
    expect(activeCues(cues, 2).map((c) => c.text)).toEqual(["Привет, мир"]);
    expect(activeCues(cues, 3.75)).toEqual([]);
  });

  it("учитывает сдвиг ±мс", () => {
    // Кью ещё не началась (t=0.5), но сдвиг +1с вытягивает её.
    expect(activeCues(cues, 0.5, 1000)).toHaveLength(1);
    // Отрицательный сдвиг прячет ранний кью.
    expect(activeCues(cues, 1.2, -1000)).toHaveLength(0);
  });
});

describe("spriteTileFor", () => {
  const meta = {
    intervalSeconds: 5,
    tileWidth: 160,
    tileHeight: 90,
    columns: 3,
    rows: 2,
    count: 6,
  };

  it("выбирает тайл по времени", () => {
    const t = spriteTileFor(0, meta);
    expect(t.col).toBe(0);
    expect(t.row).toBe(0);
    expect(t.backgroundPosition).toBe("-0px -0px");

    const t11 = spriteTileFor(11, meta);
    expect(t11.col).toBe(2);
    expect(t11.row).toBe(0);
    expect(t11.backgroundPosition).toBe("-320px -0px");

    const t26 = spriteTileFor(26, meta);
    expect(t26.col).toBe(2);
    expect(t26.row).toBe(1);
    expect(t26.backgroundPosition).toBe("-320px -90px");
  });

  it("зажимает тайл границами спрайта", () => {
    expect(spriteTileFor(-10, meta).col).toBe(0);
    const last = spriteTileFor(9999, meta);
    expect(last.col).toBe(2);
    expect(last.row).toBe(1);
  });
});

describe("маркеры интро и автоследующая серия", () => {
  const intro = { startSeconds: 5, endSeconds: 15 };

  it("isIntroVisible", () => {
    expect(isIntroVisible(10, intro)).toBe(true);
    expect(isIntroVisible(4.9, intro)).toBe(false);
    expect(isIntroVisible(15, intro)).toBe(false);
    expect(isIntroVisible(10, null)).toBe(false);
  });

  it("isNearEnd — последние 25 секунд, конец включительно", () => {
    expect(isNearEnd(100, 120)).toBe(true);
    expect(isNearEnd(50, 120)).toBe(false);
    expect(isNearEnd(120, 120)).toBe(true);
    expect(isNearEnd(5, 0)).toBe(false);
    expect(isNearEnd(10, 30)).toBe(false);
  });
});

describe("format", () => {
  it("formatTime / formatDuration", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(754)).toBe("12:34");
    expect(formatTime(4425)).toBe("1:13:45");
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(90)).toBe("1:30");
  });

  it("formatDurationHuman — длительность словами, не таймкодом", () => {
    // «2:16:00» в карточке читается как момент времени; кино-карточки
    // показывают «2 ч 16 мин», серии — «24 мин».
    expect(formatDurationHuman(8160)).toBe("2 ч 16 мин");
    expect(formatDurationHuman(1420)).toBe("24 мин");
    expect(formatDurationHuman(3600)).toBe("1 ч");
    expect(formatDurationHuman(null)).toBe("");
    expect(formatDurationHuman(0)).toBe("");
  });
});

describe("nextAliveSource", () => {
  it("без потерь берёт первую", () => {
    expect(nextAliveSource([], 8)).toBe(0);
  });

  it("перебирает по возрастанию индекса", () => {
    expect(nextAliveSource([0], 8)).toBe(1);
    expect(nextAliveSource([0, 1], 8)).toBe(2);
    expect(nextAliveSource([2], 8)).toBe(0);
  });

  it("возвращает null, когда живых не осталось", () => {
    expect(nextAliveSource([0, 1, 2], 3)).toBeNull();
    expect(nextAliveSource([], 0)).toBeNull();
  });

  it("игнорирует индексы за пределами списка", () => {
    // Мёртвым мог оказаться индекс, которого в новом списке раздач уже нет.
    expect(nextAliveSource([99], 3)).toBe(0);
    expect(nextAliveSource([0, 99, 1], 3)).toBe(2);
  });

  it("не мутирует входной список", () => {
    const dead = [0, 1];
    nextAliveSource(dead, 5);
    expect(dead).toEqual([0, 1]);
  });
});

describe("pickInitialFileIndex", () => {
  const files = (ids: number[], sizes: Array<number | null> = []) =>
    ids.map((qualityId, i) => ({
      qualityId,
      sizeBytes: sizes[i] ?? null,
    }));

  it("без размеров берёт минимальную qualityId", () => {
    expect(pickInitialFileIndex(files([2160, 720, 480]))).toBe(2);
    expect(pickInitialFileIndex(files([720, 1080]))).toBe(0);
    expect(pickInitialFileIndex([])).toBe(0);
  });

  it("с размерами берёт самый лёгкий файл", () => {
    // 2 ГБ против 1 ГБ — берём 1 ГБ, канал узкий (VPN из РФ).
    expect(pickInitialFileIndex(files([1080, 1080], [2_000_000_000, 1_000_000_000]))).toBe(1);
    expect(pickInitialFileIndex(files([720, 2160, 1080], [3_000_000_000, 8_000_000_000, 1_500_000_000]))).toBe(2);
  });

  it("размер важнее qualityId", () => {
    // Резолвер ставит вперёд крупные ремуксы — лёгкий выигрывает независимо от qualityId.
    expect(pickInitialFileIndex(files([2160, 1080, 720], [8_000_000_000, 1_200_000_000, 900_000_000]))).toBe(2);
  });

  it("перебирает мёртвые: лёгкий среди живых", () => {
    expect(pickInitialFileIndex(files([2160, 1080, 720], [4_000_000_000, 2_000_000_000, 1_000_000_000]), [2])).toBe(1);
    expect(pickInitialFileIndex(files([2160, 1080, 720]), [0, 1])).toBe(2);
    expect(pickInitialFileIndex(files([2160, 1080]), [0, 1])).toBe(0);
  });
});

describe("preferNativeHls", () => {
  const videoWith = (type: string) =>
    ({ canPlayType: () => type }) as unknown as HTMLVideoElement;

  it("Safari с нативным HLS играет без hls.js", () => {
    // AVFramework декодирует то, что MSE в Safari отвергает, и не оставляет
    // «мёртвых» вкладок после воспроизведения в standalone-PWA.
    expect(preferNativeHls(videoWith("maybe"))).toBe(true);
    expect(preferNativeHls(videoWith("probably"))).toBe(true);
  });

  it("Chrome/Firefox идут через hls.js", () => {
    expect(preferNativeHls(videoWith(""))).toBe(false);
  });
});

describe("absoluteStreamUrl", () => {
  it("достраивает относительную ссылку до полной", () => {
    // API отдаёт /gst/... и /stream?... относительными: один билд обслуживает
    // и http://<ip>, и https://<имя>. Внешнему плееру нужен полный адрес.
    expect(absoluteStreamUrl("/gst/abc/master.m3u8?index=1&audio=0")).toBe(
      `${window.location.origin}/gst/abc/master.m3u8?index=1&audio=0`,
    );
  });

  it("не трогает ссылку со своей схемой", () => {
    expect(absoluteStreamUrl("https://cdn.test/hls/index.m3u8")).toBe(
      "https://cdn.test/hls/index.m3u8",
    );
    expect(absoluteStreamUrl("http://94.103.1.126/stream?link=abc")).toBe(
      "http://94.103.1.126/stream?link=abc",
    );
    // Живая magnet-ссылка из ответа API: percent-кодирование обязано уцелеть.
    const magnet =
      "http://94.103.1.126/stream?link=magnet%3A%3Fxt%3Durn%3Abtih%3A1aab46e155c45e602b9ed7145d5ddf1904fb2603%26dn%3D%D0%A4%D0%B8%D0%BB%D1%8C%D0%BC&index=1&play";
    expect(absoluteStreamUrl(magnet)).toBe(magnet);
  });

  it("отдаёт ссылку как есть, если она не парсится", () => {
    // Мусор в ответе API не должен ронять рендер оверлея ошибки.
    expect(absoluteStreamUrl("http://[")).toBe("http://[");
  });

  it("возвращает пустую строку на пустом входе", () => {
    expect(absoluteStreamUrl(null)).toBe("");
    expect(absoluteStreamUrl(undefined)).toBe("");
    expect(absoluteStreamUrl("")).toBe("");
  });
});

/* ---------- Серии: список для плеера ---------- */

type SeasonInput = NonNullable<ItemDetail["seasons"]>[number];
type PartInput = NonNullable<ItemDetail["media"]>[number];

function ep(number: number, mediaId: number | null, title: string | null = null) {
  return { id: number, number, title, thumbnailUrl: null, runtime: 600, mediaId };
}

function seasonOf(
  number: number,
  episodes: SeasonInput["episodes"],
  title: string | null = null,
): SeasonInput {
  return { id: number, number, title, episodes };
}

function partOf(id: number, partNumber: number, title: string | null = null): PartInput {
  return { id, partNumber, title, thumbnailUrl: null, runtime: 600 };
}

describe("resolveStreamUrl", () => {
  const file = (http: string, hls: string | null) => ({ urls: { http, hls } });

  it("базовый выбор — HLS, если он есть", () => {
    expect(
      resolveStreamUrl({
        file: file("/stream?f=1", "/gst/master.m3u8"),
        directFallback: false,
        audioMaster: null,
      }),
    ).toBe("/gst/master.m3u8");
  });

  it("без HLS — прямой адрес", () => {
    expect(
      resolveStreamUrl({
        file: file("/stream?f=1", null),
        directFallback: false,
        audioMaster: null,
      }),
    ).toBe("/stream?f=1");
  });

  it("дубляж с персональным мастером важнее базового потока", () => {
    expect(
      resolveStreamUrl({
        file: file("/stream?f=1", "/gst/master.m3u8"),
        directFallback: false,
        audioMaster: "/gst/master.m3u8?audio=2",
      }),
    ).toBe("/gst/master.m3u8?audio=2");
  });

  it("откат на прямой стрим игнорирует мастер дубляжа", () => {
    // gst не собрал манифест — дорожки с masterUrl тоже манифесты, толку от них нет.
    expect(
      resolveStreamUrl({
        file: file("/stream?f=1", "/gst/master.m3u8"),
        directFallback: true,
        audioMaster: "/gst/master.m3u8?audio=2",
      }),
    ).toBe("/stream?f=1");
  });

  it("пустой прямой адрес — это «ключа нет», а не адрес", () => {
    // Репозиторий отдаёт `http: mediaUrl(...) ?? ""`. С `??` пустая строка
    // прошла бы насквозь, эффект инициализации вышел бы по `!streamUrl` — и
    // получился бы чёрный прямоугольник без ошибки и без спиннера.
    expect(
      resolveStreamUrl({
        file: { urls: { http: "", hls: "/gst/master.m3u8" } },
        directFallback: false,
        audioMaster: null,
      }),
    ).toBe("/gst/master.m3u8");
  });

  it("откат без прямого адреса возвращает базовый поток, а не пустоту", () => {
    expect(
      resolveStreamUrl({
        file: { urls: { http: "", hls: "/gst/master.m3u8" } },
        directFallback: true,
        audioMaster: null,
      }),
    ).toBe("/gst/master.m3u8");
  });

  it("пустой мастер дубляжа не перебивает базовый поток", () => {
    expect(
      resolveStreamUrl({
        file: file("/stream?f=1", "/gst/master.m3u8"),
        directFallback: false,
        audioMaster: "",
      }),
    ).toBe("/gst/master.m3u8");
  });

  it("раздачи нет — null, а не пустая строка", () => {
    expect(
      resolveStreamUrl({ file: undefined, directFallback: false, audioMaster: null }),
    ).toBeNull();
  });
});

describe("episodeGroups", () => {
  it("группирует серии по сезонам с ярлыками S/E", () => {
    const groups = episodeGroups({
      seasons: [seasonOf(1, [ep(1, 101), ep(2, 102)]), seasonOf(2, [ep(1, 201)])],
      media: null,
    });
    expect(groups.map((g) => g.heading)).toEqual(["Сезон 1", "Сезон 2"]);
    expect(groups[0]!.episodes.map((e) => e.label)).toEqual(["S1E1", "S1E2"]);
    expect(groups[1]!.episodes.map((e) => e.label)).toEqual(["S2E1"]);
    expect(groups[0]!.episodes[1]!.mediaId).toBe(102);
  });

  it("берёт название сезона, если оно есть", () => {
    const groups = episodeGroups({
      seasons: [seasonOf(1, [ep(1, 101)], "Первый сезон")],
      media: null,
    });
    expect(groups[0]!.heading).toBe("Первый сезон");
  });

  it("пропускает серии без mediaId", () => {
    const groups = episodeGroups({
      seasons: [seasonOf(1, [ep(1, 101), ep(2, null), ep(3, 103)])],
      media: null,
    });
    expect(groups[0]!.episodes.map((e) => e.mediaId)).toEqual([101, 103]);
  });

  it("не оставляет пустой сезон в списке", () => {
    const groups = episodeGroups({
      seasons: [seasonOf(1, [ep(1, null)]), seasonOf(2, [ep(1, 201)])],
      media: null,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.heading).toBe("Сезон 2");
  });

  it("аниме без сезонов показывает части из item.media", () => {
    const groups = episodeGroups({
      seasons: null,
      media: [partOf(501, 1), partOf(502, 2, "Финал")],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.heading).toBe("Части");
    expect(groups[0]!.episodes.map((e) => e.label)).toEqual(["Часть 1", "Часть 2"]);
    // part.id — это и есть mediaId маршрута /watch/[itemId]/[mediaId].
    expect(groups[0]!.episodes.map((e) => e.mediaId)).toEqual([501, 502]);
    expect(groups[0]!.episodes[1]!.title).toBe("Финал");
  });

  it("сезоны приоритетнее частей, когда есть и то и другое", () => {
    const groups = episodeGroups({
      seasons: [seasonOf(1, [ep(1, 101)])],
      media: [partOf(501, 1)],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.heading).toBe("Сезон 1");
  });

  it("фильм без серий и частей даёт пустой список", () => {
    expect(episodeGroups({ seasons: null, media: null })).toEqual([]);
    expect(episodeGroups({ seasons: [], media: [] })).toEqual([]);
  });
});

describe("flattenEpisodes", () => {
  it("сохраняет порядок сезонов", () => {
    const groups = episodeGroups({
      seasons: [seasonOf(1, [ep(1, 101), ep(2, 102)]), seasonOf(2, [ep(1, 201)])],
      media: null,
    });
    expect(flattenEpisodes(groups).map((e) => e.mediaId)).toEqual([101, 102, 201]);
  });
});

describe("nextEpisode", () => {
  const groups = episodeGroups({
    seasons: [seasonOf(1, [ep(1, 101), ep(2, 102)]), seasonOf(2, [ep(1, 201)])],
    media: null,
  });

  it("идёт к следующей серии внутри сезона", () => {
    expect(nextEpisode(groups, 101)?.mediaId).toBe(102);
  });

  it("переходит через границу сезона", () => {
    expect(nextEpisode(groups, 102)?.mediaId).toBe(201);
  });

  it("на последней серии возвращает null", () => {
    expect(nextEpisode(groups, 201)).toBeNull();
  });

  it("неизвестный mediaId — null, а не первая серия", () => {
    // Иначе оверлей «следующая серия» увёл бы в начало чужого тайтла.
    expect(nextEpisode(groups, 999)).toBeNull();
  });

  it("пустой список — null", () => {
    expect(nextEpisode([], 101)).toBeNull();
  });
});

describe("bufferedSegments", () => {
  it("пустой буфер даёт пустой список, а не отрезок в ноль", () => {
    // `buffered.length === 0` — штатное состояние сразу после load(): ни один
    // фрагмент ещё не пришёл. Полоса обязана остаться пустой.
    expect(bufferedSegments([], 100)).toEqual([]);
  });

  it("один отрезок переводится в доли", () => {
    expect(bufferedSegments([{ start: 25, end: 50 }], 100)).toEqual([
      { start: 0.25, end: 0.5 },
    ]);
  });

  it("дырка посередине даёт два отрезка", () => {
    // Перескок по скрабберу: hls.js догружает новое место, оставляя пропуск.
    const segs = bufferedSegments(
      [
        { start: 0, end: 30 },
        { start: 60, end: 90 },
      ],
      100,
    );
    expect(segs).toEqual([
      { start: 0, end: 0.3 },
      { start: 0.6, end: 0.9 },
    ]);
  });

  it("отрезок нулевой длины отбрасывается, а не рисуется точкой", () => {
    expect(bufferedSegments([{ start: 10, end: 10 }], 100)).toEqual([]);
  });

  it("соседние отрезки склеиваются в один", () => {
    // Два прямоугольника встык дают волосяной шов на стыке.
    const segs = bufferedSegments(
      [
        { start: 0, end: 50 },
        { start: 50, end: 80 },
      ],
      100,
    );
    expect(segs).toEqual([{ start: 0, end: 0.8 }]);
  });

  it("перекрывающиеся отрезки склеиваются по дальнему концу", () => {
    const segs = bufferedSegments(
      [
        { start: 0, end: 50 },
        { start: 20, end: 70 },
      ],
      100,
    );
    expect(segs).toEqual([{ start: 0, end: 0.7 }]);
  });

  it("неотсортированный вход приводится в порядок", () => {
    const segs = bufferedSegments(
      [
        { start: 60, end: 90 },
        { start: 0, end: 30 },
      ],
      100,
    );
    expect(segs.map((s) => s.start)).toEqual([0, 0.6]);
  });

  it("выход за длительность зажимается в [0,1]", () => {
    // У живого потока хвост буфера легко перелетает объявленную длительность.
    expect(bufferedSegments([{ start: -5, end: 150 }], 100)).toEqual([
      { start: 0, end: 1 },
    ]);
  });

  it("нулевая длительность — пусто, а не NaN", () => {
    // Прямой поток: duration === 0, пока не пришли метаданные. Деление на ноль
    // дало бы NaN в style.width, и полоса исчезла бы совсем.
    expect(bufferedSegments([{ start: 0, end: 10 }], 0)).toEqual([]);
  });

  it("бесконечная длительность — пусто, а не NaN", () => {
    expect(bufferedSegments([{ start: 0, end: 10 }], Number.POSITIVE_INFINITY)).toEqual([]);
  });
});

describe("segmentsEqual", () => {
  it("пустые списки равны", () => {
    expect(segmentsEqual([], [])).toBe(true);
  });

  it("равные значения равны, даже когда массивы разные", () => {
    // Каждый тик useBufferedRanges собирает новый массив: равенство имеет
    // смысл только по значениям, ссылка всегда новая.
    const a = [{ start: 0, end: 0.5 }];
    const b = [{ start: 0, end: 0.5 }];
    expect(a).not.toBe(b);
    expect(segmentsEqual(a, b)).toBe(true);
  });

  it("разная длина — не равны", () => {
    expect(segmentsEqual([], [{ start: 0, end: 1 }])).toBe(false);
    expect(
      segmentsEqual([{ start: 0, end: 1 }], [
        { start: 0, end: 0.5 },
        { start: 0.6, end: 1 },
      ]),
    ).toBe(false);
  });

  it("различие в start или end — не равны", () => {
    expect(segmentsEqual([{ start: 0, end: 0.5 }], [{ start: 0.1, end: 0.5 }])).toBe(false);
    expect(segmentsEqual([{ start: 0, end: 0.5 }], [{ start: 0, end: 0.6 }])).toBe(false);
    // Дырка в буфере: второй отрезок сдвинулся — полоса меняется.
    expect(
      segmentsEqual(
        [
          { start: 0, end: 0.3 },
          { start: 0.6, end: 1 },
        ],
        [
          { start: 0, end: 0.3 },
          { start: 0.7, end: 1 },
        ],
      ),
    ).toBe(false);
  });
});
