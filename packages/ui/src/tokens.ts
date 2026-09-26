/**
 * Дизайн-токены «Зал»: тёмная кинематографичная тема.
 * Единственный источник правды для web (CSS-переменные) и mobile (StyleSheet).
 */
export const tokens = {
  color: {
    /** Фон страницы — почти чёрный, тёплый. */
    bg: "#0b0b0f",
    /** Фон карточек и панелей. */
    surface: "#141419",
    surfaceHover: "#1c1c24",
    border: "#26262f",
    /** Основной текст. */
    text: "#f2f2f5",
    textMuted: "#9a9aa8",
    /** Акцент — «кинокрасный». */
    accent: "#e50914",
    accentHover: "#ff1f2b",
    success: "#2ecc71",
    warning: "#f39c12",
  },
  radius: {
    sm: 6,
    md: 10,
    lg: 16,
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
  fontSize: {
    xs: 12,
    sm: 14,
    md: 16,
    lg: 20,
    xl: 28,
    xxl: 44,
  },
  duration: {
    fast: 120,
    normal: 220,
    slow: 420,
  },
} as const;

export type Tokens = typeof tokens;

/** CSS-переменные из токенов — для globals.css и inline-стилей. */
export function cssVariables(theme: Tokens = tokens): Record<string, string> {
  return {
    "--zal-bg": theme.color.bg,
    "--zal-surface": theme.color.surface,
    "--zal-surface-hover": theme.color.surfaceHover,
    "--zal-border": theme.color.border,
    "--zal-text": theme.color.text,
    "--zal-text-muted": theme.color.textMuted,
    "--zal-accent": theme.color.accent,
    "--zal-accent-hover": theme.color.accentHover,
  };
}
