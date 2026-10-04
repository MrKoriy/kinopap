"use client";

import { ApiError } from "@zal/api-client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";

const INPUT_CLASS =
  "rounded-[var(--radius-control)] border border-border bg-surface px-4 py-3 text-white placeholder:text-muted focus:border-accent focus:outline-none";

/** Понятная причина отказа вместо кода API. */
function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.body.error.code === "wrong_password") return "Текущий пароль введён неверно";
    if (err.body.error.code === "same_password") return "Новый пароль совпадает с текущим";
    if (err.status === 429) return "Слишком много попыток, подождите минуту";
  }
  return "Не удалось сменить пароль. Попробуйте позже";
}

/**
 * Смена пароля в личном кабинете. Сервер отзывает все сессии и выдаёт
 * этой вкладке свежий access-токен — остальные устройства выйдут сами.
 */
export function PasswordForm() {
  const { api } = useAuth();
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [repeat, setRepeat] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setDone(false);
    if (next.length < 8) return setError("Новый пароль — минимум 8 символов");
    if (next !== repeat) return setError("Пароли не совпадают");
    setBusy(true);
    setError(null);
    try {
      const res = await api.changePassword({ currentPassword: current, newPassword: next });
      api.setToken(res.tokens.accessToken);
      setCurrent("");
      setNext("");
      setRepeat("");
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-10 max-w-md" data-testid="password-section">
      <h2 className="mb-4 text-xl font-semibold text-white">Смена пароля</h2>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Текущий пароль"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className={INPUT_CLASS}
          data-testid="password-current"
          required
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="Новый пароль"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className={INPUT_CLASS}
          data-testid="password-new"
          required
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="Новый пароль ещё раз"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          className={INPUT_CLASS}
          data-testid="password-repeat"
          required
        />
        {error && (
          <p className="text-sm text-red-400" data-testid="password-error">
            {error}
          </p>
        )}
        {done && (
          <p className="text-sm text-green-400" data-testid="password-done">
            Пароль изменён. На других устройствах нужно будет войти заново.
          </p>
        )}
        <Button type="submit" disabled={busy} data-testid="password-submit">
          {busy ? "Секунду…" : "Сменить пароль"}
        </Button>
      </form>
    </section>
  );
}
