import { Stack } from "expo-router";
import { tokens } from "@zal/ui";

/** Корневой навигатор: тёмная тема «Зал». */
export default function RootLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: tokens.color.bg },
        headerTintColor: tokens.color.text,
        contentStyle: { backgroundColor: tokens.color.bg },
      }}
    />
  );
}
