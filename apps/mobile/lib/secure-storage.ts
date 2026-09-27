/**
 * Хранилище токенов: Keychain на iOS, Keystore на Android
 * (expo-secure-store), а на web-таргете (Expo web для e2e) — localStorage.
 * Отдельный модуль, чтобы чистая логика (lib/session.ts) не тянула натив.
 */

import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { TokenStorage } from "./session";

const webStorage: TokenStorage = {
  getItem: async (key) =>
    typeof localStorage === "undefined" ? null : localStorage.getItem(key),
  setItem: async (key, value) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  },
  removeItem: async (key) => {
    if (typeof localStorage !== "undefined") localStorage.removeItem(key);
  },
};

const nativeStorage: TokenStorage = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};

export const secureStorage: TokenStorage =
  Platform.OS === "web" ? webStorage : nativeStorage;
