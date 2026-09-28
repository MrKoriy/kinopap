import { describe, expect, it } from "vitest";
import { formatDuration, formatTime } from "@/lib/format";
import {
  absoluteStreamUrl,
  activeCues,
  isIntroVisible,
  isNearEnd,
  nextAliveSource,
  parseVtt,
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

  it("isNearEnd — последние 10 секунд", () => {
    expect(isNearEnd(115, 120)).toBe(true);
    expect(isNearEnd(50, 120)).toBe(false);
    expect(isNearEnd(120, 120)).toBe(false);
    expect(isNearEnd(5, 0)).toBe(false);
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
