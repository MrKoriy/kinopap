"use client";

import { tokens } from "@zal/ui";
/** Корневой навигатор: AuthProvider + тёмная тема «Зал». */
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider } from "../lib/auth";

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: tokens.color.bg },
          headerTintColor: tokens.color.text,
          contentStyle: { backgroundColor: tokens.color.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Зал." }} />
        <Stack.Screen name="search" options={{ title: "Поиск" }} />
        <Stack.Screen name="subscriptions" options={{ title: "Мои подписки" }} />
        <Stack.Screen name="profile" options={{ title: "Профиль" }} />
        <Stack.Screen name="login" options={{ title: "Вход" }} />
        <Stack.Screen name="item/[id]" options={{ title: "Тайтл" }} />
        <Stack.Screen
          name="watch/[itemId]/[mediaId]"
          options={{ title: "Просмотр", headerShown: false }}
        />
      </Stack>
    </AuthProvider>
  );
}
