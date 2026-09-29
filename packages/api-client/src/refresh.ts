/**
 * Общий refresh-флоу: сколько бы запросов ни получили 401 одновременно,
 * ротация уходит одна.
 *
 * Логика вынесена в пакет не ради красоты. Она одинаково устроена на вебе и на
 * мобиле и одинаково легко ломается: без single-flight десяток параллельных
 * запросов после истечения access-токена устраивает десяток ротаций. Сервер при
 * каждой ротации выдаёт новый refresh-токен и обесценивает старый, поэтому все
 * запросы, кроме первого, приходят со уже недействительным токеном и
 * разлогинивают пользователя — на ровном месте, ровно в тот момент, когда он
 * листает каталог. Написано это было дважды, а тестов не было ни на одной копии.
 *
 * Что осталось в приложениях и не переехало: откуда взять refresh-токен и куда
 * положить новый. Веб не хранит его вовсе (httpOnly-cookie уходит с запросом
 * сама), мобила держит в Keychain. Это разные политики, и общий знаменатель для
 * них пришлось бы выдумывать.
 */

import type { Tokens } from "./auth";

/** Минимум клиента, который нужен refresh-флоу. */
export interface RefreshCapableClient {
  refresh(input?: { refreshToken: string }): Promise<{ tokens: Tokens }>;
  setToken(token: string | null): void;
}

export interface TokenRefresherOptions {
  /**
   * Токен для тела запроса. Веб не передаёт функцию вовсе: токен в
   * httpOnly-cookie, тело пустое. Мобила достаёт его из хранилища.
   */
  loadRefreshToken?: () => Promise<string | undefined> | string | undefined;
  /** Куда положить обновлённые токены (мобиле — в Keychain, вебу — некуда). */
  saveTokens?: (tokens: Tokens) => Promise<void> | void;
  /** Ротация не прошла — сессия мертва, приложение чистит своё состояние. */
  onSessionLost?: () => Promise<void> | void;
}

/**
 * Собирает `onUnauthorized` для `createApiClient`.
 *
 * Клиент берётся ленивой функцией, а не значением: `onUnauthorized` нужен уже
 * при создании клиента, а сам клиент появляется только после этого вызова.
 * Стрелка разыменовывает его позже — на первом 401, когда он давно создан.
 *
 * Возвращает `false`, если сессия кончилась: по этому признаку клиент не
 * повторяет запрос, который всё равно получит 401.
 */
export function createTokenRefresher(
  getClient: () => RefreshCapableClient,
  opts: TokenRefresherOptions = {},
): () => Promise<boolean> {
  let inFlight: Promise<boolean> | null = null;

  return () => {
    // Single-flight: пока ротация идёт, все 401 ждут её же промис.
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const client = getClient();
          const refreshToken = await opts.loadRefreshToken?.();
          // Загрузчик есть, а токена нет — обновлять нечем. На мобиле это
          // штатный «разлогинен»: без этой проверки мы бы всё равно сходили в
          // API с пустым телом, зная заранее, что получим 401.
          if (opts.loadRefreshToken && !refreshToken) {
            await opts.onSessionLost?.();
            return false;
          }
          const res = await client.refresh(refreshToken ? { refreshToken } : undefined);
          await opts.saveTokens?.(res.tokens);
          client.setToken(res.tokens.accessToken);
          return true;
        } catch {
          // Сеть и 401 здесь неразличимы, и это осознанно: повторный refresh
          // безопасен, а различить их вызывающему всё равно нечем — для UI оба
          // случая выглядят одинаково, «сессии нет».
          await opts.onSessionLost?.();
          return false;
        } finally {
          // Сбрасывается в finally, поэтому провал не кэшируется: следующий 401
          // попробует ротацию заново.
          inFlight = null;
        }
      })();
    }
    return inFlight;
  };
}
