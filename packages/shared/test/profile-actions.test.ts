/**
 * Чистое ядро оптимистичных операций профиля: снимок → сеттеры → API →
 * откат. Хук useProfileActions — тонкая обёртка, вся логика здесь и
 * проверяется без React: сеттеры ведут себя как useState (функция от
 * предыдущего или готовое значение), API — стабы, снимок — объект на
 * момент вызова, как значения на рендере.
 */
import type {
  FavoriteDto,
  HistoryEntryDto,
  ProfileStats,
  UserListDetailDto,
  UserListDto,
} from "@zal/api-client";
import { describe, expect, it, vi } from "vitest";
import {
  clearHistory,
  deleteList,
  type ProfileActionsApi,
  type ProfileActionsDeps,
  type ProfileSetters,
  type ProfileSnapshot,
  removeFavorite,
  removeHistoryEntry,
} from "../src/profile-actions";

function stats(over: Partial<ProfileStats> = {}): ProfileStats {
  return {
    favorites: 2,
    lists: 2,
    history: 2,
    watched: 5,
    inProgress: 1,
    subscriptions: 4,
    comments: 6,
    ...over,
  };
}

function entry(over: Partial<HistoryEntryDto> = {}): HistoryEntryDto {
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

function favorite(over: Partial<FavoriteDto> = {}): FavoriteDto {
  return {
    itemId: 10,
    createdAt: "2026-09-01T00:00:00.000Z",
    item: {
      id: 10,
      type: "serial",
      title: "Тестовый сериал",
      year: 2024,
      posterMedium: null,
      rating: 8.4,
    },
    ...over,
  };
}

function list(over: Partial<UserListDto> = {}): UserListDto {
  return {
    id: 1,
    title: "На вечер",
    description: null,
    isPublic: false,
    itemCount: 2,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...over,
  };
}

function detail(over: Partial<UserListDetailDto> = {}): UserListDetailDto {
  return {
    ...list(),
    items: [
      { id: 10, type: "serial", title: "Тестовый сериал", year: 2024, posterMedium: null, rating: 8.4 },
    ],
    ...over,
  };
}

/** Хранилище с семантикой useState: сеттеры меняют слоты, снимок читается копией момента. */
function makeStore(init: Partial<ProfileSnapshot> = {}) {
  let state: ProfileSnapshot = {
    stats: init.stats ?? null,
    history: init.history ?? [],
    favorites: init.favorites ?? [],
    lists: init.lists ?? [],
    openList: init.openList ?? null,
  };
  const setters: ProfileSetters = {
    setHistory: (u) => {
      state = { ...state, history: typeof u === "function" ? u(state.history) : u };
    },
    setStats: (u) => {
      state = { ...state, stats: typeof u === "function" ? u(state.stats) : u };
    },
    setFavorites: (u) => {
      state = { ...state, favorites: typeof u === "function" ? u(state.favorites) : u };
    },
    setLists: (u) => {
      state = { ...state, lists: typeof u === "function" ? u(state.lists) : u };
    },
    setOpenList: (u) => {
      state = { ...state, openList: typeof u === "function" ? u(state.openList) : u };
    },
  };
  return { setters, read: () => state };
}

/** Клиент, у которого выбранные методы падают. */
function makeApi(failWith: Partial<Record<keyof ProfileActionsApi, Error>> = {}): ProfileActionsApi {
  const respond = (key: keyof ProfileActionsApi) => async () => {
    const err = failWith[key];
    if (err) throw err;
    return { ok: true };
  };
  return {
    deleteHistoryEntry: vi.fn(respond("deleteHistoryEntry")),
    clearHistory: vi.fn(respond("clearHistory")),
    removeFavorite: vi.fn(respond("removeFavorite")),
    deleteList: vi.fn(respond("deleteList")),
  };
}

/** Зависимости операции: снимок берётся на момент вызова — как на рендере. */
function deps(
  store: ReturnType<typeof makeStore>,
  api: ProfileActionsApi,
  revertStatsOnFailure = true,
): ProfileActionsDeps {
  return { api, state: store.read(), setters: store.setters, revertStatsOnFailure };
}

describe("удаление записи истории", () => {
  it("успех: запись уходит, счётчик уменьшается", async () => {
    const api = makeApi();
    const store = makeStore({
      stats: stats(),
      history: [entry({ mediaId: 500 }), entry({ mediaId: 501 })],
    });
    await removeHistoryEntry(deps(store, api), 500);
    expect(store.read().history.map((h) => h.mediaId)).toEqual([501]);
    expect(store.read().stats?.history).toBe(1);
    expect(api.deleteHistoryEntry).toHaveBeenCalledWith(500);
  });

  it("сбой: список и счётчик возвращаются снимком", async () => {
    const api = makeApi({ deleteHistoryEntry: new Error("сеть") });
    const store = makeStore({
      stats: stats({ history: 3 }),
      history: [entry({ mediaId: 500 }), entry({ mediaId: 501 })],
    });
    await removeHistoryEntry(deps(store, api), 500);
    expect(store.read().history).toHaveLength(2);
    expect(store.read().stats?.history).toBe(3);
  });

  it("счётчик не уходит в минус", async () => {
    const api = makeApi();
    const store = makeStore({ stats: stats({ history: 0 }), history: [entry()] });
    await removeHistoryEntry(deps(store, api), 500);
    expect(store.read().stats?.history).toBe(0);
  });

  it("без сводки (stats null) ничего не ломается", async () => {
    const api = makeApi();
    const store = makeStore({ history: [entry()] });
    await removeHistoryEntry(deps(store, api), 500);
    expect(store.read().stats).toBeNull();
    expect(store.read().history).toHaveLength(0);
  });

  it("откат возвращает снимок на момент вызова, а не текущий список", async () => {
    // Параллельные удаления: второе успело примениться, но первое падает и
    // возвращает свой снимок — так вели себя и исходные клиенты.
    let rejectFirst: (e: Error) => void = () => {};
    const api: ProfileActionsApi = {
      ...makeApi(),
      deleteHistoryEntry: (mediaId: number) =>
        mediaId === 500
          ? new Promise((_resolve, reject) => {
              rejectFirst = reject;
            })
          : Promise.resolve({ ok: true }),
    };
    const store = makeStore({
      stats: stats({ history: 2 }),
      history: [entry({ mediaId: 500 }), entry({ mediaId: 501 })],
    });
    const first = removeHistoryEntry(deps(store, api), 500);
    await removeHistoryEntry(deps(store, api), 501);
    expect(store.read().history).toHaveLength(0);
    rejectFirst(new Error("сеть"));
    await first;
    expect(store.read().history.map((h) => h.mediaId)).toEqual([500, 501]);
  });
});

describe("очистка истории", () => {
  it("успех: пустой список и ноль", async () => {
    const api = makeApi();
    const store = makeStore({ stats: stats(), history: [entry(), entry({ mediaId: 501 })] });
    await clearHistory(deps(store, api));
    expect(store.read().history).toEqual([]);
    expect(store.read().stats?.history).toBe(0);
    expect(api.clearHistory).toHaveBeenCalled();
  });

  it("сбой: снимок возвращается", async () => {
    const api = makeApi({ clearHistory: new Error("сеть") });
    const store = makeStore({ stats: stats(), history: [entry()] });
    await clearHistory(deps(store, api));
    expect(store.read().history).toHaveLength(1);
    expect(store.read().stats?.history).toBe(2);
  });
});

describe("снятие с сохранённого", () => {
  it("успех: карточка уходит, счётчик уменьшается", async () => {
    const api = makeApi();
    const store = makeStore({
      stats: stats(),
      favorites: [favorite({ itemId: 10 }), favorite({ itemId: 11 })],
    });
    await removeFavorite(deps(store, api), 10);
    expect(store.read().favorites.map((f) => f.itemId)).toEqual([11]);
    expect(store.read().stats?.favorites).toBe(1);
    expect(api.removeFavorite).toHaveBeenCalledWith(10);
  });

  it("сбой, веб (revertStats=true): карточка и счётчик возвращаются", async () => {
    const api = makeApi({ removeFavorite: new Error("сеть") });
    const store = makeStore({
      stats: stats(),
      favorites: [favorite({ itemId: 10 }), favorite({ itemId: 11 })],
    });
    await removeFavorite(deps(store, api), 10);
    expect(store.read().favorites).toHaveLength(2);
    expect(store.read().stats?.favorites).toBe(2);
  });

  it("сбой, мобильный (revertStats=false): карточка возвращается, счётчик остаётся", async () => {
    const api = makeApi({ removeFavorite: new Error("сеть") });
    const store = makeStore({
      stats: stats(),
      favorites: [favorite({ itemId: 10 }), favorite({ itemId: 11 })],
    });
    await removeFavorite(deps(store, api, false), 10);
    expect(store.read().favorites).toHaveLength(2);
    expect(store.read().stats?.favorites).toBe(1);
  });
});

describe("удаление подборки", () => {
  it("успех: подборка уходит, раскрытая в этот момент закрывается", async () => {
    const api = makeApi();
    const store = makeStore({
      stats: stats(),
      lists: [list({ id: 1 }), list({ id: 2 })],
      openList: detail({ id: 1 }),
    });
    await deleteList(deps(store, api), 1);
    expect(store.read().lists.map((l) => l.id)).toEqual([2]);
    expect(store.read().stats?.lists).toBe(1);
    expect(store.read().openList).toBeNull();
    expect(api.deleteList).toHaveBeenCalledWith(1);
  });

  it("успех: раскрытая чужая подборка остаётся", async () => {
    const api = makeApi();
    const store = makeStore({
      stats: stats(),
      lists: [list({ id: 1 }), list({ id: 2 })],
      openList: detail({ id: 2 }),
    });
    await deleteList(deps(store, api), 1);
    expect(store.read().openList?.id).toBe(2);
  });

  it("сбой, веб (revertStats=true): список и счётчик возвращаются, раскрытая — нет", async () => {
    const api = makeApi({ deleteList: new Error("сеть") });
    const store = makeStore({ stats: stats(), lists: [list()], openList: detail({ id: 1 }) });
    await deleteList(deps(store, api), 1);
    expect(store.read().lists).toHaveLength(1);
    expect(store.read().stats?.lists).toBe(2);
    // Закрытая раскрытость не возвращается — так у обоих клиентов.
    expect(store.read().openList).toBeNull();
  });

  it("сбой, мобильный (revertStats=false): список возвращается, счётчик остаётся", async () => {
    const api = makeApi({ deleteList: new Error("сеть") });
    const store = makeStore({ stats: stats(), lists: [list()] });
    await deleteList(deps(store, api, false), 1);
    expect(store.read().lists).toHaveLength(1);
    expect(store.read().stats?.lists).toBe(1);
  });
});
