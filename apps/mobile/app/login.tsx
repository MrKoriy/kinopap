"use client";

/** Вход по email+паролю; регистрация — по инвайт-коду закрытого клуба. */
import * as React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { tokens } from "@zal/ui";
import { useAuth } from "../lib/auth";

export default function LoginScreen() {
  const { login, register } = useAuth();
  const router = useRouter();
  const [mode, setMode] = React.useState<"login" | "register">("login");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [name, setName] = React.useState("");
  const [invite, setInvite] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await login(email.trim(), password);
      else await register({ invite: invite.trim(), email: email.trim(), password, name: name.trim() });
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не вышло. Попробуйте снова.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        {mode === "login" ? "Вход" : "Регистрация"}
      </Text>

      <TextInput
        testID="email-input"
        style={styles.input}
        placeholder="Email"
        placeholderTextColor={tokens.color.textMuted}
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        testID="password-input"
        style={styles.input}
        placeholder="Пароль"
        placeholderTextColor={tokens.color.textMuted}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      {mode === "register" && (
        <>
          <TextInput
            style={styles.input}
            placeholder="Имя"
            placeholderTextColor={tokens.color.textMuted}
            value={name}
            onChangeText={setName}
          />
          <TextInput
            style={styles.input}
            placeholder="Инвайт-код"
            placeholderTextColor={tokens.color.textMuted}
            autoCapitalize="none"
            value={invite}
            onChangeText={setInvite}
          />
        </>
      )}

      {error && (
        <Text style={styles.error} testID="auth-error">
          {error}
        </Text>
      )}

      <Pressable
        testID="auth-submit"
        style={[styles.submit, busy && styles.submitOff]}
        disabled={busy}
        onPress={() => void submit()}
        accessibilityRole="button"
      >
        {busy ? (
          <ActivityIndicator color={tokens.color.text} />
        ) : (
          <Text style={styles.submitText}>
            {mode === "login" ? "Войти" : "Зарегистрироваться"}
          </Text>
        )}
      </Pressable>

      <Pressable
        onPress={() => setMode((m) => (m === "login" ? "register" : "login"))}
        accessibilityRole="button"
      >
        <Text style={styles.toggle}>
          {mode === "login"
            ? "Нет аккаунта? Регистрация по инвайту"
            : "Уже есть аккаунт? Вход"}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: tokens.color.bg,
    padding: tokens.space.lg,
  },
  title: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.xl,
    fontWeight: "700",
    marginBottom: tokens.space.lg,
  },
  input: {
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: tokens.color.border,
    color: tokens.color.text,
    fontSize: tokens.fontSize.md,
    padding: tokens.space.md,
    marginBottom: tokens.space.sm,
  },
  error: {
    color: "#e57373",
    fontSize: tokens.fontSize.sm,
    marginBottom: tokens.space.sm,
  },
  submit: {
    backgroundColor: tokens.color.accent,
    borderRadius: tokens.radius.full,
    alignItems: "center",
    paddingVertical: tokens.space.md,
    marginTop: tokens.space.sm,
  },
  submitOff: {
    opacity: 0.6,
  },
  submitText: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.md,
    fontWeight: "700",
  },
  toggle: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.sm,
    textAlign: "center",
    marginTop: tokens.space.md,
  },
});
