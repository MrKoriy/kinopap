import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { HistoryEntryDto, ProfileOverviewDto, User } from "@zal/api-client";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Профиль ходит в API через useOptionalAuth — подменяем контекст, как в social.test.
const mocks = vi.hoisted(() => ({
  auth: null as null | { user: unknown; api: Record<string, ReturnType<typeof vi.fn>> },
}));

vi.mock("@/lib/auth", () => ({
  useOptionalAuth: () => mocks.auth,
  useAuth: () => {
    if (!mocks.auth) throw new Error("useAuth must be used within AuthProvider");
    return mocks.auth;
  },
}));

// next/link тянет роутер Next — в компонентных тестах он не нужен.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

import ProfilePage from "@/app/profile/page";
import { formatMemberSince, formatRelativeTime, pluralRu } from "@/lib/profile-format";

afterEach(cleanup);
beforeEach(() => {
  mocks.auth = null;
});

const user: User = {
  id: 7,
  email: "fan@zal.dev",
  name: "fan",
  role: "member",
  createdAt: "2026-03-01T00:00:00.000Z",
};

const stats = {
  favorites: 2,
  lists: 1,
  history: 3,
  watched: 5,
  inProgress: 1,
  subscriptions: 4,
  comments: 6,
};

function makeHistory(over: Partial<HistoryEntryDto> = {}): HistoryEntryDto {
  return {
    itemId: 10,
    mediaId: 500,
    itemTitle: "Тестовый сериал",
    posterMedium: null,
    type: "serial",
    seasonNumber: 2,
    episodeNumber: 4,
    partNumber: null,
    mediaTitle: "Серия 4",
    positionSeconds: 600,
    durationSeconds: 1200,
    progress: 0.5,
    status: "in_progress",
    updatedAt: "2026-09-29T10:00:00.000Z",
    ...over,
  };
}

function makeOverview(over: Partial<ProfileOverviewDto> = {}): ProfileOverviewDto {
  return { user, stats, history: [], favorites: [], lists: [], ...over };
}

describe("formatRelativeTime", () => {
  const now = new Date("2026-09-29T12:00:00.000Z");

  it("свежая метка — «только что»", () => {
    expect(formatRelativeTime("2026-09-29T11:59:30.000Z", now)).toBe("только что");
  });

  it("минуты с русской формой", () => {
    expect(formatRelativeTime("2026-09-29T11:58:00.000Z", now)).toBe("2 минуты назад");
    expect(formatRelativeTime("2026-09-29T11:59:00.000Z", now)).toBe("1 минуту назад");
    expect(formatRelativeTime("2026-09-29T11:55:00.000Z", now)).toBe("5 минут назад");
  });

  it("часы", () => {
    expect(formatRelativeTime("2026-09-29T10:00:00.000Z", now)).toBe("2 часа назад");
    expect(formatRelativeTime("2026-09-28T15:00:00.000Z", now)).toBe("21 час назад");
  });

  it("дни", () => {
    expect(formatRelativeTime("2026-09-26T12:00:00.000Z", now)).toBe("3 дня назад");
  });

  it("старше месяца — календарная дата", () => {
    expect(formatRelativeTime("2026-08-01T12:00:00.000Z", now)).toContain("августа");
  });

  it("битая дата — пусто", () => {
    expect(formatRelativeTime("не дата", now)).toBe("");
  });
});

describe("pluralRu", () => {
  it("выбирает форму по числу", () => {
    expect(pluralRu(1, "тайтл", "тайтла", "тайтлов")).toBe("тайтл");
    expect(pluralRu(3, "тайтл", "тайтла", "тайтлов")).toBe("тайтла");
    expect(pluralRu(11, "тайтл", "тайтла", "тайтлов")).toBe("тайтлов");
    expect(pluralRu(21, "тайтл", "тайтла", "тайтлов")).toBe("тайтл");
  });
});

// Подпись позиции в истории переехала в packages/shared/test/watch.test.ts:
// правило общее с мобильным клиентом, поэтому и тест у него один.
describe("formatMemberSince", () => {
  it("месяц и год", () => {
    expect(formatMemberSince("2026-03-01T00:00:00.000Z")).toBe("март 2026 г.");
  });
});

describe("ProfilePage (гость)", () => {
  it("показывает призыв войти и не рисует таблицы", () => {
    render(<ProfilePage />);
    expect(screen.getByTestId("profile-page")).toBeDefined();
    expect(screen.getByTestId("profile-login-hint")).toBeDefined();
    expect(screen.getByTestId("profile-login-link").getAttribute("href")).toBe("/login");
    // Пустые таблицы гостю не показываем.
    expect(screen.queryByTestId("profile-stats")).toBeNull();
    expect(screen.queryByTestId("history-row")).toBeNull();
    expect(screen.queryByTestId("favorites-grid")).toBeNull();
  });
});

describe("ProfilePage (авторизован)", () => {
  it("рисует счётчики и строки истории из overview", async () => {
    const api = {
      getProfileOverview: vi.fn().mockResolvedValue({
        profile: makeOverview({
          history: [makeHistory({ mediaId: 500 })],
          favorites: [
            {
              itemId: 10,
              createdAt: "2026-09-01T00:00:00.000Z",
              item: { id: 10, type: "serial", title: "Тестовый сериал", year: 2024, posterMedium: null, rating: 8.4 },
            },
          ],
          lists: [
            {
              id: 1,
              title: "На вечер",
              description: null,
              isPublic: false,
              itemCount: 2,
              createdAt: "2026-09-01T00:00:00.000Z",
              updatedAt: "2026-09-02T00:00:00.000Z",
            },
          ],
        }),
      }),
    };
    mocks.auth = { user, api };

    render(<ProfilePage />);

    await waitFor(() => expect(screen.getByTestId("history-row")).toBeDefined());
    expect(screen.getByTestId("profile-stats")).toBeDefined();
    expect(screen.getByText("S2E4 · Серия 4")).toBeDefined();
    expect(screen.getByTestId("favorites-grid")).toBeDefined();
    expect(screen.getByTestId("list-row")).toBeDefined();
    expect(screen.getByText("На вечер")).toBeDefined();
  });
});
