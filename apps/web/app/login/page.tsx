"use client";

/** Вход и регистрация по инвайту. */
import * as React from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  const router = useRouter();
  const { login, register } = useAuth();
  const [mode, setMode] = React.useState<"login" | "register">("login");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [invite, setInvite] = React.useState("");
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await login(email, password);
      else await register({ invite, email, password, name });
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось войти");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex max-w-md flex-col px-4 py-16">
      <h1 className="mb-8 text-3xl font-bold text-white">
        {mode === "login" ? "Вход" : "Регистрация"}
      </h1>

      <form onSubmit={submit} className="flex flex-col gap-4">
        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-[var(--radius-control)] border border-border bg-surface px-4 py-3 text-white placeholder:text-muted focus:border-accent focus:outline-none"
          data-testid="email-input"
        />
        <input
          type="password"
          required
          minLength={8}
          placeholder="Пароль (от 8 символов)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-[var(--radius-control)] border border-border bg-surface px-4 py-3 text-white placeholder:text-muted focus:border-accent focus:outline-none"
          data-testid="password-input"
        />
        {mode === "register" && (
          <>
          <input
            required
            placeholder="Имя"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-[var(--radius-control)] border border-border bg-surface px-4 py-3 text-white placeholder:text-muted focus:border-accent focus:outline-none"
            data-testid="name-input"
          />
          <input
            required
            placeholder="Инвайт-код"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            className="rounded-[var(--radius-control)] border border-border bg-surface px-4 py-3 text-white placeholder:text-muted focus:border-accent focus:outline-none"
            data-testid="invite-input"
          />
          </>
        )}

        {error && (
          <p className="text-sm text-red-400" data-testid="auth-error">
            {error}
          </p>
        )}

        <Button type="submit" disabled={busy} data-testid="auth-submit">
          {busy ? "Секунду…" : mode === "login" ? "Войти" : "Зарегистрироваться"}
        </Button>
      </form>

      <button
        className="mt-6 text-sm text-muted transition hover:text-white"
        onClick={() => setMode(mode === "login" ? "register" : "login")}
        data-testid="auth-mode-toggle"
      >
        {mode === "login"
          ? "Нет аккаунта? Регистрация по инвайту →"
          : "Уже есть аккаунт? Войти →"}
      </button>
    </main>
  );
}
