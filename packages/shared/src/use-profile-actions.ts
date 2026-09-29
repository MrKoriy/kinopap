/**
 * Хук оптимистичных операций профиля: снимок → сеттеры → API → откат.
 *
 * Живёт на сабпути `@zal/shared/react` рядом с useComments: главный вход
 * остаётся без React. Общий для React DOM и React Native — знает про
 * домен, а не про вёрстку. Сеть и состояние приходят инъекцией: клиент
 * `@zal/api-client` удовлетворяет `ProfileActionsApi` структурно, сеттеры —
 * обычные useState-сеттеры, состояние принадлежит приложению.
 *
 * Здесь только React-обвязка: свежие снимки через ref и стабильные
 * колбэки. Сам цикл операций и откаты — в `./profile-actions`, чистом и
 * протестированном без React.
 *
 * Операции, где платформы расходятся сильнее (создание подборки, открытие
 * и удаление из подборки), в хук не входят: у веба и мобильного там
 * разные потоки данных, и общая форма стала бы вынужденной.
 */
import * as React from "react";
import {
  clearHistory,
  deleteList,
  type ProfileActionsApi,
  type ProfileActionsDeps,
  type ProfileSetters,
  type ProfileSnapshot,
  removeFavorite,
  removeHistoryEntry,
} from "./profile-actions";

export type {
  ProfileActionsApi,
  ProfileSetters,
  ProfileSnapshot,
} from "./profile-actions";

export interface UseProfileActionsInput {
  /** Клиент или null (гость) — действия становятся no-op. */
  api: ProfileActionsApi | null;
  /** Значения ячеек профиля текущего рендера. */
  state: ProfileSnapshot;
  /** Сеттеры ячеек профиля приложения. */
  setters: ProfileSetters;
  /**
   * Возвращать ли счётчики сводки при неудачной мутации: веб откатывает,
   * мобильный оставляет. Политика платформы, расхождение — осознанное.
   */
  revertStatsOnFailure: boolean;
}

export interface ProfileActions {
  removeHistoryEntry: (mediaId: number) => Promise<void>;
  clearHistory: () => Promise<void>;
  removeFavorite: (itemId: number) => Promise<void>;
  deleteList: (listId: number) => Promise<void>;
}

export function useProfileActions(input: UseProfileActionsInput): ProfileActions {
  // Снимки для отката: колбэки переживают рендер, замыкание на state
  // внутри них устаревает — тот же приём, что listRef в useComments.
  const inputRef = React.useRef(input);
  React.useEffect(() => {
    inputRef.current = input;
  });

  return React.useMemo<ProfileActions>(() => {
    const wrap =
      <A extends unknown[]>(op: (deps: ProfileActionsDeps, ...args: A) => Promise<void>) =>
      async (...args: A) => {
        const { api, state, setters, revertStatsOnFailure } = inputRef.current;
        if (!api) return;
        await op({ api, state, setters, revertStatsOnFailure }, ...args);
      };
    return {
      removeHistoryEntry: wrap(removeHistoryEntry),
      clearHistory: wrap(clearHistory),
      removeFavorite: wrap(removeFavorite),
      deleteList: wrap(deleteList),
    };
  }, []);
}
