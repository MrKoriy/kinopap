import { describe, expect, it } from "vitest";
import { cueAt, parseVtt } from "../lib/subtitles";

const SAMPLE = `WEBVTT

NOTE служебная заметка

00:00:01.000 --> 00:00:04.000
Здравствуй, <i>мир</i>

00:01:05.500 --> 00:01:08.000 line:90%
Вторая реплика
на две строки

01:02:03.250 --> 01:02:05.000
Далёкая реплика &amp; сущность
`;

describe("parseVtt", () => {
  it("парсит реплики, чистит теги и собирает многострочный текст", () => {
    const cues = parseVtt(SAMPLE);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({ start: 1, end: 4, text: "Здравствуй, мир" });
    expect(cues[1]!.text).toBe("Вторая реплика\nна две строки");
    expect(cues[2]!.start).toBe(3723.25);
    expect(cues[2]!.text).toBe("Далёкая реплика & сущность");
  });

  it("терпит CRLF, BOM и мусорные блоки", () => {
    const raw = "\uFEFFWEBVTT\r\n\r\nSTYLE\r\n::cue { color: white }\r\n\r\n00:05.000 --> 00:07,000\r\nКороткий формат\r\n";
    const cues = parseVtt(raw);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toEqual({ start: 5, end: 7, text: "Короткий формат" });
  });

  it("пустой ввод и реплики без текста не дают кадров", () => {
    expect(parseVtt("")).toEqual([]);
    expect(parseVtt("WEBVTT\n\n00:01.000 --> 00:02.000\n\n")).toEqual([]);
  });
});

describe("cueAt", () => {
  const cues = parseVtt(SAMPLE);

  it("находит реплику по времени", () => {
    expect(cueAt(cues, 2)?.text).toBe("Здравствуй, мир");
    expect(cueAt(cues, 3.999)?.text).toBe("Здравствуй, мир");
    expect(cueAt(cues, 4.5)).toBeNull();
    expect(cueAt(cues, 3724)?.text).toContain("Далёкая");
  });

  it("сдвиг смещает показ, не переписывая файл", () => {
    // Семантика shared (едина с вебом): +500 мс — реплики из «будущего»,
    // субтитры появляются раньше.
    expect(cueAt(cues, 3.4, 500)?.text).toBe("Здравствуй, мир");
    expect(cueAt(cues, 4.25, 500)).toBeNull();
    // −500 мс: вторая реплика (65.5–68с) показывается позже.
    expect(cueAt(cues, 66.2, -500)?.text).toContain("Вторая");
    expect(cueAt(cues, 65.2, -500)).toBeNull();
  });
});
