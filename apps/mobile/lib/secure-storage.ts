/**
 * Хранилище токенов: Keychain на iOS, Keystore на Android
 * (expo-secure-store), а на web-таргете (Expo web для e2e) — localStorage.
 * Отдельный модуль, чтобы чистая логика (lib/session.ts) не тянула натив.
 *
 * localStorage — намеренное исключение только для web-таргета: в нативной
 * сборке ключ в localStorage не лежал бы в Keystore. Guard ниже делает
 * это ограничение явным и роняет сборку, если «web» добрался до нативы.
 */

import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { TokenStorage } from "./session";

interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// tsconfig мобилки без lib "dom" — берём localStorage через globalThis.
const webLocalStorage = (): WebStorageLike | undefined =>
  (globalThis as { localStorage?: WebStorageLike }).localStorage;

const webStorage: TokenStorage = {
  getItem: async (key) => webLocalStorage()?.getItem(key) ?? null,
  setItem: async (key, value) => {
    webLocalStorage()?.setItem(key, value);
  },
  removeItem: async (key) => {
    webLocalStorage()?.removeItem(key);
  },
};

const nativeStorage: TokenStorage = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};

const isWebTarget = Platform.OS === "web";

export const secureStorage: TokenStorage = isWebTarget ? webStorage : nativeStorage;
