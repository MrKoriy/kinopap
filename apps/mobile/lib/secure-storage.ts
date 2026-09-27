/**
 * Хранилище токенов на базе expo-secure-store: Keychain на iOS,
 * Keystore на Android. Отдельный модуль, чтобы чистая логика
 * (lib/session.ts) не тянула нативные зависимости.
 */
import * as SecureStore from "expo-secure-store";
import type { TokenStorage } from "./session";

export const secureStorage: TokenStorage = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};
