/**
 * Строка подключения в логе деплоя.
 *
 * seed-catalog печатает адрес базы, чтобы в отчёте о выкладке было видно, куда
 * именно сеяли. Раньше туда попадал DATABASE_URL целиком, вместе с паролем —
 * а лог деплоя читают и люди, и агенты, и он оседает в переписке. Пароля в нём
 * быть не должно, а всё остальное (хост, порт, база) должно остаться читаемым:
 * иначе проверка превращается в «туда ли мы вообще ходим» без ответа.
 */
import { describe, expect, it } from "vitest";
import { redactPassword } from "../src/seed-catalog";

describe("redactPassword", () => {
  it("убирает пароль, оставляя хост, порт и базу", () => {
    expect(redactPassword("postgres://zal:s3cret@localhost:5433/zal")).toBe(
      "postgres://***:***@localhost:5433/zal",
    );
  });

  it("не оставляет в выводе самого пароля", () => {
    expect(redactPassword("postgres://zal:hunter2@127.0.0.1:5433/zal")).not.toContain(
      "hunter2",
    );
  });

  it("строку без пароля не портит", () => {
    // Порт без собаки — это не пароль, и «:5433» вырезать нельзя.
    expect(redactPassword("postgres://localhost:5433/zal")).toBe(
      "postgres://localhost:5433/zal",
    );
  });

  it("справляется с паролем, содержащим двоеточие", () => {
    expect(redactPassword("postgres://zal:a:b@localhost:5433/zal")).toBe(
      "postgres://***:***@localhost:5433/zal",
    );
  });
});
