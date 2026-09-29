/**
 * Оптимистичные операции профиля: снимок → сеттеры → API → откат.
 *
 * Это чистое ядро хука `useProfileActions` (сабпуть `@zal/shared/react`).
 * Вынесено без единого импорта React не ради архитектуры: логика отката —
 * ровно та, что ломается незаметно, а рендер-инфраструктуры в пакете нет.
 * Ядро проверяется обычными тестами, хук владеет только обвязкой.
 *
 * Состояние профиля остаётся у приложений: сюда приходят снимок значений
 * на текущем рендере и сеттеры (структурно — useState-сеттеры), поэтому
 * shared не навязывает ни форму секций, ни их хранение.
 *
 * Откат списков — всегда восстановление снимка. Счётчики сводки —
 * политика платформы (`revertStatsOnFailure`): веб возвращает их, мобильный
 * оставляет. Расхождение осознанное и видно в сигнатуре, а не спрятано
 * внутри.
 */
import type {
  FavoriteDto,
  HistoryEntryDto,
  ProfileStats,
  UserListDetailDto,
  UserListDto,
} from "@zal/api-client";

/** Обновление ячейки состояния: значение или функция от предыдущего. */
export type ProfileSetter<T> = (update: T | ((prev: T) => T)) => void;

/** Значения ячеек профиля на рендере — источник снимков для отката. */
export interface ProfileSnapshot {
  stats: ProfileStats | null;
  history: HistoryEntryDto[];
  favorites: FavoriteDto[];
  lists: UserListDto[];
  openList: UserListDetailDto | null;
}

/** Сеттеры ячеек профиля; структурно им удовлетворяют useState-сеттеры. */
export interface ProfileSetters {
  setHistory: ProfileSetter<HistoryEntryDto[]>;
  setStats: ProfileSetter<ProfileStats | null>;
  setFavorites: ProfileSetter<FavoriteDto[]>;
  setLists: ProfileSetter<UserListDto[]>;
  setOpenList: ProfileSetter<UserListDetailDto | null>;
}

/**
 * Минимум API, нужный операциям профиля. Структурно ему удовлетворяет
 * клиент `@zal/api-client` — приложения передают его без обёрток, а ядро
 * не привязывается к конкретному клиенту и не тянет новых зависимостей.
 */
export interface ProfileActionsApi {
  deleteHistoryEntry(mediaId: number): Promise<unknown>;
  clearHistory(): Promise<unknown>;
  removeFavorite(itemId: number): Promise<unknown>;
  deleteList(listId: number): Promise<unknown>;
}

export interface ProfileActionsDeps {
  api: ProfileActionsApi;
  state: ProfileSnapshot;
  setters: ProfileSetters;
  /** Возвращать ли счётчики сводки при откате: веб — да, мобильный — нет. */
  revertStatsOnFailure: boolean;
}

/** Удаляет запись истории: список и счётчик сразу, при сбое — снимок целиком. */
export async function removeHistoryEntry(
  deps: ProfileActionsDeps,
  mediaId: number,
): Promise<void> {
  const { api, state, setters } = deps;
  const prevHistory = state.history;
  const prevStats = state.stats;
  setters.setHistory((cur) => cur.filter((h) => h.mediaId !== mediaId));
  setters.setStats((s) => (s ? { ...s, history: Math.max(0, s.history - 1) } : s));
  try {
    await api.deleteHistoryEntry(mediaId);
  } catch {
    setters.setHistory(prevHistory);
    setters.setStats(prevStats);
  }
}

/** Очищает историю: пустой список и ноль, при сбое — снимок. */
export async function clearHistory(deps: ProfileActionsDeps): Promise<void> {
  const { api, state, setters } = deps;
  const prevHistory = state.history;
  const prevStats = state.stats;
  setters.setHistory([]);
  setters.setStats((s) => (s ? { ...s, history: 0 } : s));
  try {
    await api.clearHistory();
  } catch {
    setters.setHistory(prevHistory);
    setters.setStats(prevStats);
  }
}

/** Снимает тайтл с сохранённого; откат счётчика — политика платформы. */
export async function removeFavorite(deps: ProfileActionsDeps, itemId: number): Promise<void> {
  const { api, state, setters, revertStatsOnFailure } = deps;
  const prevFavorites = state.favorites;
  setters.setFavorites((cur) => cur.filter((f) => f.itemId !== itemId));
  setters.setStats((s) => (s ? { ...s, favorites: Math.max(0, s.favorites - 1) } : s));
  try {
    await api.removeFavorite(itemId);
  } catch {
    setters.setFavorites(prevFavorites);
    if (revertStatsOnFailure) {
      setters.setStats((s) => (s ? { ...s, favorites: s.favorites + 1 } : s));
    }
  }
}

/**
 * Удаляет подборку. Раскрытая в этот момент закрывается и при откате не
 * возвращается — так делают оба клиента.
 */
export async function deleteList(deps: ProfileActionsDeps, listId: number): Promise<void> {
  const { api, state, setters, revertStatsOnFailure } = deps;
  const prevLists = state.lists;
  setters.setLists((cur) => cur.filter((l) => l.id !== listId));
  setters.setStats((s) => (s ? { ...s, lists: Math.max(0, s.lists - 1) } : s));
  if (state.openList?.id === listId) {
    setters.setOpenList(null);
  }
  try {
    await api.deleteList(listId);
  } catch {
    setters.setLists(prevLists);
    if (revertStatsOnFailure) {
      setters.setStats((s) => (s ? { ...s, lists: s.lists + 1 } : s));
    }
  }
}
