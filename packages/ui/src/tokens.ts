/**
 * Дизайн-токены «Зал»: тёмная кинематографичная тема.
 * Единственный источник правды для web (CSS-переменные, @theme в
 * apps/web/app/globals.css) и mobile (StyleSheet).
 */
export const tokens = {
  color: {
    /** Фон страницы — почти чёрный, тёплый. */
    bg: "#0b0b0f",
    /** Фон карточек и панелей. */
    surface: "#141419",
    /** Второй уровень: чипы, поля ввода, плейсхолдеры картинок. */
    surface2: "#1c1c24",
    surfaceHover: "#22222c",
    border: "#26262f",
    /** Основной текст. */
    text: "#f2f2f5",
    textMuted: "#9a9aa8",
    /** Акцент — «кинокрасный». */
    accent: "#e50914",
    accentHover: "#ff1f2b",
    /** Мягкий акцент: фон активного чипа/таба поверх тёмного. */
    accentSoft: "rgba(229, 9, 20, 0.16)",
    success: "#2ecc71",
    warning: "#f39c12",
    danger: "#ff4d4f",
    /** Рейтинги: ≥7 зелёный, ≥5 янтарный. */
    ratingHigh: "#10b981",
    ratingMid: "#f59e0b",
  },
  radius: {
    sm: 6,
    md: 10,
    card: 12,
    lg: 16,
    xl: 24,
    full: 999,
  },
  space: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 40,
    xxl: 64,
  },
  font: {
    sans: "'Inter', 'Helvetica Neue', Arial, sans-serif",
    display: "'Inter', 'Helvetica Neue', Arial, sans-serif",
  },
  /** Шкала типографики (px): подписи → заголовок hero. */
  fontSize: {
    xs: 12,
    sm: 14,
    md: 16,
    lg: 20,
    xl: 28,
    xxl: 44,
    display: 60,
  },
  lineHeight: {
    tight: 1.1,
    snug: 1.3,
    normal: 1.5,
    relaxed: 1.7,
  },
  /** Тени: карточка, всплывающие панели, hero-текст. */
  shadow: {
    card: "0 8px 24px rgba(0, 0, 0, 0.35)",
    popover: "0 24px 60px rgba(0, 0, 0, 0.7)",
    glow: "0 0 0 1px rgba(255, 255, 255, 0.06), 0 12px 40px rgba(229, 9, 20, 0.25)",
  },
  /** «Стекло»: шапка, липкие панели, кнопки поверх картинок. */
  glass: {
    bg: "rgba(11, 11, 15, 0.72)",
    border: "rgba(255, 255, 255, 0.08)",
    blur: 16,
  },
  duration: {
    fast: 120,
    normal: 220,
    slow: 420,
  },
  /** Слои: шапка, липкие фильтры, превью карточки, модалки. */
  z: {
    sticky: 40,
    header: 50,
    popover: 60,
    modal: 100,
  },
} as const;

export type Tokens = typeof tokens;

/** CSS-переменные из токенов — для globals.css и inline-стилей. */
export function cssVariables(theme: Tokens = tokens): Record<string, string> {
  return {
    "--zal-bg": theme.color.bg,
    "--zal-surface": theme.color.surface,
    "--zal-surface-2": theme.color.surface2,
    "--zal-surface-hover": theme.color.surfaceHover,
    "--zal-border": theme.color.border,
    "--zal-text": theme.color.text,
    "--zal-text-muted": theme.color.textMuted,
    "--zal-accent": theme.color.accent,
    "--zal-accent-hover": theme.color.accentHover,
    "--zal-accent-soft": theme.color.accentSoft,
    "--zal-radius-card": `${theme.radius.card}px`,
    "--zal-shadow-card": theme.shadow.card,
    "--zal-shadow-popover": theme.shadow.popover,
    "--zal-glass-bg": theme.glass.bg,
    "--zal-glass-border": theme.glass.border,
    "--zal-glass-blur": `${theme.glass.blur}px`,
  };
}
